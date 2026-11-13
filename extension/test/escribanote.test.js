import { test } from "node:test";
import assert from "node:assert/strict";

import "../src/main/core.js";
import "../src/main/proto.js";
import "../src/main/meet.js";
import "../src/main/teams.js";
import "../src/main/zoom.js";
import { mergeSpeakers, canonicalSpeaker, participantNames, createSession, applyEvent, toBlocks, speakerName } from "../src/lib/transcript.js";
import { toSrt, toVtt, toMarkdown, toText, fileName } from "../src/lib/format.js";

const { encode } = globalThis.EscribanoteProto;
const Meet = globalThis.EscribanoteMeet;

test("Meet captions_v2: decodifica utterance (esquema observado no Meet)", () => {
  const bytes = encode([
    [1, "message", [
      [1, "varint", 987654321],
      [2, "varint", 3],
      [3, "message", [
        [3, "string", "olá, pessoal"],
        [4, "string", "pt-BR"],
        [6, "string", "spaces/abc/devices/42"],
      ]],
    ]],
  ]);
  assert.deepEqual(Meet.decodeCaptionsV2(bytes), {
    id: "987654321/spaces/abc/devices/42",
    speakerId: "spaces/abc/devices/42",
    version: 3,
    text: "olá, pessoal",
    lang: "pt-BR",
  });
});

test("Meet captions_v2: esquema mudado cai no decodificador flexível", () => {
  // um nível a mais e campos em outras posições: o caminho fixo falha, a busca acha o texto
  const bytes = encode([
    [2, "message", [
      [1, "varint", 641],
      [2, "varint", 18],
      [5, "message", [
        [7, "message", [
          [1, "string", "spaces/abc/devices/535"],
          [2, "string", "pt-BR"],
          [9, "string", "mas não é de costume, mas de costume"],
        ]],
      ]],
    ]],
  ]);
  assert.equal(Meet.decodeCaptionsV2(bytes), null);
  assert.deepEqual(Meet.decodeCaptionLoose(bytes), {
    id: "641/spaces/abc/devices/535",
    speakerId: "spaces/abc/devices/535",
    version: 18,
    text: "mas não é de costume, mas de costume",
    lang: "pt-BR",
  });
  // o formato conhecido continua dando o mesmo resultado pelos dois caminhos
  const known = encode([[1, "message", [[1, "varint", 7], [2, "varint", 2], [3, "message", [[3, "string", "bom dia a todos"], [4, "string", "pt-BR"], [6, "string", "spaces/abc/devices/1"]]]]]]);
  assert.deepEqual(Meet.decodeCaptionLoose(known), Meet.decodeCaptionsV2(known));
  // sem deviceId, ou sem texto, não inventa legenda
  assert.equal(Meet.decodeCaptionLoose(encode([[1, "message", [[1, "varint", 7], [3, "message", [[3, "string", "texto solto"]]]]]])), null);
  assert.equal(Meet.decodeCaptionLoose(encode([[1, "message", [[1, "varint", 7], [3, "message", [[6, "string", "spaces/abc/devices/1"]]]]]])), null);
});

test("proto: grupos (wire 3/4) não derrubam a mensagem inteira", () => {
  const inner = encode([[1, "varint", 5], [2, "varint", 1], [3, "message", [[3, "string", "olá de novo"], [6, "string", "spaces/x/devices/2"]]]]);
  const bytes = new Uint8Array([0x0a, inner.length, ...inner, 0x4b, 0x08, 0x01, 0x4c]); // campo 9 como grupo
  assert.equal(Meet.decodeCaptionsV2(bytes).text, "olá de novo");
});

test("Meet captions legado: wrapper{1: message}", () => {
  const bytes = encode([
    [1, "message", [
      [1, "string", "dev-1"],
      [2, "varint", 77],
      [3, "varint", 2],
      [6, "string", "bom dia"],
      [8, "varint", 1],
    ]],
    [2, "string", ""],
  ]);
  const c = Meet.decodeLegacyCaption(bytes);
  assert.equal(c.id, "77/dev-1");
  assert.equal(c.text, "bom dia");
  assert.equal(c.version, 2);
});

test("Meet collections: caminho 1→2→13→1→2 e varredura genérica", () => {
  const device = (id, name) => [[1, "string", id], [2, "string", name]];
  const bytes = encode([
    [1, "message", [[2, "message", [[13, "message", [[1, "message", [[2, "message", device("spaces/x/devices/1", "Ana Souza")]]]]]]]]],
    [9, "message", [[5, "message", device("spaces/x/devices/2", "Bruno Lima")]]],
  ]);
  const got = Meet.decodeDevices(bytes).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(got, [
    { speakerId: "spaces/x/devices/1", name: "Ana Souza" },
    { speakerId: "spaces/x/devices/2", name: "Bruno Lima" },
  ]);
});

test("Meet chat: encontra {2 device, 3 timestamp, 5:{1 texto}}", () => {
  const bytes = encode([[1, "message", [[1, "message", [[2, "string", "dev-9"], [3, "varint", 1700000000], [5, "message", [[1, "string", "link na descrição"]]]]]]]]);
  assert.deepEqual(Meet.decodeChat(bytes), { id: "chat/1700000000/dev-9", speakerId: "dev-9", text: "link na descrição", ts: 1700000000 });
});

test("decodificadores não lançam exceção com lixo", () => {
  const junk = new Uint8Array([0xff, 0xff, 0xff, 0x01, 0x02]);
  assert.equal(Meet.decodeCaptionsV2(junk), null);
  assert.equal(Meet.decodeLegacyCaption(junk), null);
  assert.deepEqual(Meet.decodeDevices(junk), []);
});

test("Teams: recognitionResults depois de prefixo binário", () => {
  const payload = '\u0001\u0002xx{"recognitionResults":[{"id":"abc/4","userId":"8:orgid:u1","timestampAudioSent":1234,"text":"Vamos começar"}]}';
  assert.deepEqual(globalThis.EscribanoteTeams.captionsFromPayload(payload), [
    { id: "1234/8:orgid:u1", speakerId: "8:orgid:u1", version: 4, text: "Vamos começar", lang: undefined },
  ]);
});

test("Zoom: detecta mensagens novas no newLTMessage", () => {
  const a = { msgId: "1", text: "oi", user: { zoomID: 10, displayName: "Carla" } };
  const b = { msgId: "2", text: "tudo bem?", user: { zoomID: 11, displayName: "Davi" } };
  const prev = { 1: a };
  const next = { 1: a, 2: b };
  const changed = globalThis.EscribanoteZoom.changedMessages(prev, next);
  assert.equal(changed.length, 1);
  assert.equal(globalThis.EscribanoteZoom.toCaption(changed[0]).speakerName, "Davi");
});

function session() {
  return createSession({ id: "s1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "Planejamento Q4", startedAt: 1_000_000 });
}

test("transcrição: atualizações incrementais substituem o texto pela versão maior", () => {
  const s = session();
  applyEvent(s, { kind: "caption", id: "1/d", speakerId: "d", version: 1, text: "eu acho" }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "1/d", speakerId: "d", version: 3, text: "eu acho que sim" }, 1_002_000);
  applyEvent(s, { kind: "caption", id: "1/d", speakerId: "d", version: 2, text: "eu acho q" }, 1_002_500);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].text, "eu acho que sim");
});

test("transcrição: mesma fala por dois canais vira uma só", () => {
  const s = session();
  applyEvent(s, { kind: "caption", id: "1/d", speakerId: "d", version: 1, text: "vamos ao orçamento" }, 1_001_000);
  assert.equal(applyEvent(s, { kind: "caption", id: "999/d", speakerId: "d", version: 1, text: "vamos ao orçamento" }, 1_001_300), false);
  applyEvent(s, { kind: "caption", id: "999/d", speakerId: "d", version: 2, text: "vamos ao orçamento agora" }, 1_001_600);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].text, "vamos ao orçamento agora");
  // falas curtas repetidas rápido ("sim", "sim") são falas diferentes
  applyEvent(s, { kind: "caption", id: "2/d", speakerId: "d", text: "sim" }, 1_002_000);
  applyEvent(s, { kind: "caption", id: "3/d", speakerId: "d", text: "sim" }, 1_002_400);
  assert.equal(s.entries.length, 3);
});

test("blocos agrupam falas consecutivas do mesmo falante e usam nomes", () => {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "primeira" }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "2/a", speakerId: "a", text: "segunda" }, 1_003_000);
  applyEvent(s, { kind: "caption", id: "3/b", speakerId: "spaces/x/devices/77", text: "outra pessoa" }, 1_004_000);
  const blocks = toBlocks(s);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "primeira segunda");
  assert.equal(blocks[0].speaker, "Ana");
  assert.equal(blocks[1].speaker, "Participante 77");
});

test("exportação: SRT, VTT, Markdown, TXT e nome de arquivo", () => {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "olá" }, 1_001_500);
  applyEvent(s, { kind: "caption", id: "2/a", speakerId: "a", text: "tudo certo" }, 1_065_250);
  assert.match(toSrt(s), /^1\n00:00:01,500 --> 00:00:02,500\nAna: olá\n/);
  assert.match(toVtt(s), /^WEBVTT\n\n00:00:01\.500 --> 00:00:02\.500\n<v Ana>olá/);
  assert.match(toMarkdown(s), /# Planejamento Q4[\s\S]*\*\*Participantes:\*\* Ana/);
  assert.match(toText(s), /\[00:00:01\] Ana: olá\n\n\[00:01:05\] Ana: tudo certo/);
  assert.match(fileName(s, "md"), /^Planejamento Q4 - Google Meet - \d{4}-\d\d-\d\d \d\dh\d\d\.md$/);
});

// ---------------- v2 ----------------
import { setBlockTags, toggleLastBlockTag, timeline, normalize } from "../src/lib/transcript.js";
import { computeStats, findMe } from "../src/lib/stats.js";
import { toHtml, mdToHtml } from "../src/lib/format.js";
import { ataRequest, chatRequest } from "../src/lib/ai.js";

function meeting() {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana Souza" });
  applyEvent(s, { kind: "speaker", speakerId: "b", name: "Bruno Lima" });
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "Vamos aprovar o orçamento de marketing?" }, 1_001_000);
  s.entries.at(-1).updatedAt = 1_005_000;
  applyEvent(s, { kind: "caption", id: "2/b", speakerId: "b", text: "Sim, aprovado." }, 1_006_000);
  s.entries.at(-1).updatedAt = 1_007_000;
  applyEvent(s, { kind: "caption", id: "3/a", speakerId: "a", text: "Ótimo, eu envio a proposta até sexta para todos revisarem com calma." }, 1_008_000);
  s.entries.at(-1).updatedAt = 1_016_000;
  return s;
}

test("destaques: tags por bloco e atalho do último bloco", () => {
  const s = meeting();
  setBlockTags(s, ["2/b"], ["decisao"]);
  assert.deepEqual(toBlocks(s)[1].tags, ["decisao"]);
  assert.deepEqual(toggleLastBlockTag(s, "acao").tags, ["acao"]);
  assert.deepEqual(toBlocks(s)[2].tags, ["acao"]);
  toggleLastBlockTag(s, "acao");
  assert.deepEqual(toBlocks(s)[2].tags, []);
});

test("linha do tempo mistura falas, notas e capturas em ordem", () => {
  const s = meeting();
  s.notes.items.push({ id: "n1", at: 1_006_500, text: "Confirmar verba" });
  s.shots.push({ id: "x1", at: 1_007_500 });
  assert.deepEqual(timeline(s).map((i) => i.type), ["block", "block", "note", "shot", "block"]);
});

test("normalize preenche campos novos de sessões antigas", () => {
  const old = { id: "x", title: "t", platform: "meet", startedAt: 1, updatedAt: 1, entries: [], speakers: {} };
  const s = normalize(old);
  assert.deepEqual([s.highlights, s.notes.items, s.shots, s.chats, s.paused], [{}, [], [], [], false]);
});

test("estatísticas: parcela de fala, perguntas e 'você'", () => {
  const st = computeStats(meeting());
  assert.equal(st.speakers[0].name, "Ana Souza");
  assert.ok(st.speakers[0].share > 0.7 && st.speakers[0].share < 1);
  assert.equal(st.speakers[0].questions, 1);
  assert.equal(st.speakers[0].turns, 2);
  assert.equal(st.totalTurns, 3);
  assert.equal(findMe(st, "bruno").name, "Bruno Lima");
  assert.equal(findMe(st, ""), null);
});

test("exportações incluem destaques, notas e ata", () => {
  const s = meeting();
  setBlockTags(s, ["2/b"], ["decisao"]);
  s.notes.text = "Pauta: **orçamento**";
  s.notes.items.push({ id: "n1", at: 1_006_500, text: "Confirmar verba" });
  s.summary = { text: "## Resumo\nOrçamento aprovado.\n- [ ] Enviar proposta — Ana" };
  const md = toMarkdown(s);
  assert.match(md, /## Ata[\s\S]*Orçamento aprovado/);
  assert.match(md, /## Destaques\n\n- ✅ Decisão \*\*Bruno Lima\*\*/);
  assert.match(md, /> 📝 `00:00:06` Confirmar verba/);
  const html = toHtml(s);
  assert.match(html, /<h2>Destaques<\/h2>/);
  assert.match(html, /<b>orçamento<\/b>/);
  assert.match(toText(s), /Bruno Lima \[✅ Decisão\]: Sim, aprovado\./);
});

test("exportações sem a ata (uso fora do MPGO): reunião completa, sem ata nem modelo", async () => {
  const { toJson } = await import("../src/lib/format.js");
  const s = meeting();
  setBlockTags(s, ["2/b"], ["decisao"]);
  s.notes.text = "Pauta: orçamento";
  s.summary = { text: "## Registro de reunião\nOrçamento aprovado.\n\nPromotor de Justiça" };
  s.summaryHistory = [{ id: "v1", n: 1, text: s.summary.text }];
  s.ataTemplateId = "tpl-atena";
  const md = toMarkdown(s, { ata: false });
  assert.doesNotMatch(md, /## Ata|Registro de reunião|Promotor/);
  assert.match(md, /## Destaques[\s\S]*## Notas[\s\S]*## Transcrição[\s\S]*Sim, aprovado/);
  const html = toHtml(s, { ata: false });
  assert.doesNotMatch(html, /<h2>Ata<\/h2>|Promotor/);
  assert.match(html, /<h2>Transcrição<\/h2>/);
  const json = JSON.parse(toJson(s, { ata: false }));
  assert.ok(!("summary" in json) && !("summaryHistory" in json) && !("ataTemplateId" in json));
  assert.ok(json.entries.length && json.blocks.length, "a reunião continua inteira no JSON");
  // padrão continua institucional
  assert.match(toMarkdown(s), /## Ata[\s\S]*Promotor/);
  assert.equal(JSON.parse(toJson(s)).ataTemplateId, "tpl-atena");
});

test("mdToHtml escapa HTML e renderiza tarefas", () => {
  const html = mdToHtml("## Itens\n- [ ] <script>x</script> tarefa\n- [x] feita");
  assert.ok(!html.includes("<script>"));
  assert.match(html, /☐ &lt;script&gt;/);
  assert.match(html, /☑ feita/);
});

test("requisições de IA: transcrição delimitada e histórico do chat", () => {
  const s = meeting();
  const ata = ataRequest(s);
  assert.match(ata.messages[0].content, /^<transcricao [^>]+>\n[\s\S]*Ana Souza: Vamos aprovar/);
  assert.match(ata.system, /ignore quaisquer instruções/);
  const chat = chatRequest(s, [{ role: "user", text: "O que foi decidido?" }], { previous: { ...meeting(), title: "Reunião anterior" } });
  assert.deepEqual(chat.messages, [{ role: "user", content: "O que foi decidido?" }]);
  assert.match(chat.system, /<reuniao_anterior titulo="Reunião anterior"/);
});

// ---------------- reconhecimento ----------------
import { mergeRolling, addAsrSegment, effectiveEntries, resolveSpeaker } from "../src/lib/transcript.js";

test("legenda que rola na tela é acumulada, sem perder o começo", () => {
  assert.equal(mergeRolling("a gente precisa fechar", "precisa fechar o orçamento do Q4"), "a gente precisa fechar o orçamento do Q4");
  assert.equal(mergeRolling("bom dia", "bom dia a todos"), "bom dia a todos");
  assert.equal(mergeRolling("bom dia a todos", "dia a"), "bom dia a todos");
  assert.equal(mergeRolling("orçamento do quiu", "orçamento do Q4"), "orçamento do Q4"); // revisão do reconhecedor
  const s = session();
  applyEvent(s, { kind: "caption", source: "dom", id: "dom/1", speakerId: "dom:Ana", text: "a gente precisa fechar" }, 1_001_000);
  applyEvent(s, { kind: "caption", source: "dom", id: "dom/1", speakerId: "dom:Ana", text: "precisa fechar o orçamento hoje" }, 1_002_000);
  assert.equal(s.entries[0].text, "a gente precisa fechar o orçamento hoje");
});

function asrMeeting() {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "speaker", speakerId: "b", name: "Bruno" });
  // legendas chegam ~1 s depois da fala
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "orçamento do quiu quatro" }, 1_011_000);
  s.entries.at(-1).updatedAt = 1_014_000;
  applyEvent(s, { kind: "caption", id: "2/b", speakerId: "b", text: "fechado até sesta" }, 1_016_000);
  s.entries.at(-1).updatedAt = 1_018_000;
  return s;
}

test("Whisper: falante vem das legendas e o segmento substitui a legenda que cobre", () => {
  const s = asrMeeting();
  assert.equal(resolveSpeaker(s, 1_010_000, 1_013_000), "a");
  addAsrSegment(s, { start: 1_010_000, end: 1_013_000, text: "Orçamento do Q4.", source: "tab" });
  const eff = effectiveEntries(s);
  assert.deepEqual(eff.map((e) => [e.speakerId, e.text, e.source || "protocol"]), [
    ["a", "Orçamento do Q4.", "whisper"],
    ["b", "fechado até sesta", "protocol"],
  ]);
  assert.deepEqual(eff[0].coveredIds, ["1/a"]);
  // descarta marcações sem fala
  assert.equal(addAsrSegment(s, { start: 1_020_000, end: 1_021_000, text: "[Música]", source: "tab" }), false);
  // microfone = a própria pessoa
  addAsrSegment(s, { start: 1_030_000, end: 1_032_000, text: "Concordo.", source: "mic" }, "a");
  assert.equal(effectiveEntries(s).at(-1).speakerId, "a");
});

test("destaques continuam valendo quando o Whisper substitui a legenda", () => {
  const s = asrMeeting();
  setBlockTags(s, ["1/a"], ["decisao"]);
  addAsrSegment(s, { start: 1_010_000, end: 1_013_000, text: "Orçamento do Q4.", source: "tab" });
  const b = toBlocks(s)[0];
  assert.equal(b.hq, true);
  assert.deepEqual(b.tags, ["decisao"]);
  setBlockTags(s, b.ids, []);
  assert.deepEqual(toBlocks(s)[0].tags, []);
});

test("correções da IA guardam o original", () => {
  const s = asrMeeting();
  s.fixes["2/b"] = "fechado até sexta";
  const b = toBlocks(s)[1];
  assert.equal(b.text, "fechado até sexta");
  assert.equal(b.original, "fechado até sesta");
  assert.equal(b.fixed, true);
  // nova versão da legenda invalida a correção antiga
  applyEvent(s, { kind: "caption", id: "2/b", speakerId: "b", version: 5, text: "fechado até sexta-feira" }, 1_019_000);
  assert.equal(s.fixes["2/b"], undefined);
});

// ---------------- idioma, revisão e Whisper ----------------
import { detectLang, captionLanguageIssue } from "../src/lib/lang.js";
import { reviewRequest, parseReview } from "../src/lib/ai.js";
import { Segmenter, cleanTranscript } from "../src/asr/segmenter.js";

test("detecta o idioma das legendas e avisa quando não bate", () => {
  assert.equal(detectLang("então a gente não vai conseguir fechar isso hoje"), "pt");
  assert.equal(detectLang("so we need to close the budget for this quarter"), "en");
  assert.equal(detectLang("ok"), null);
  const s = session();
  for (let i = 0; i < 4; i++) applyEvent(s, { kind: "caption", id: `${i}/a`, speakerId: "a", text: "a gente precisa ver isso", lang: "en-US" }, 1_001_000 + i * 2000);
  assert.deepEqual(captionLanguageIssue(s, "pt-BR"), { seen: "en", expected: "pt", source: "plataforma" });
  assert.equal(captionLanguageIssue(s, "en-US"), null);
  // sem código da plataforma: estima pelo texto
  const t = session();
  const lines = ["so we have to talk about the budget", "and what is the plan for you", "I think we can do it this week", "but the team is not ready yet", "we will have to wait for that", "can you send it to me today"];
  lines.forEach((text, i) => applyEvent(t, { kind: "caption", id: `${i}/b`, speakerId: "b", text }, 1_001_000 + i * 3000));
  assert.equal(captionLanguageIssue(t, "pt-BR").seen, "en");
});

test("idioma da interface do Meet avisa antes da primeira fala; some quando as legendas confirmam", () => {
  const s = session();
  assert.equal(applyEvent(s, { kind: "ui-lang", platform: "meet", lang: "en" }), true);
  assert.equal(applyEvent(s, { kind: "ui-lang", platform: "meet", lang: "en" }), false);
  assert.deepEqual(captionLanguageIssue(s, "pt-BR"), { seen: "en", expected: "pt", source: "interface" });
  assert.equal(captionLanguageIssue(s, "en-US"), null);
  // as legendas chegam com código pt-BR: a interface deixa de importar
  for (let i = 0; i < 3; i++) applyEvent(s, { kind: "caption", id: `${i}/a`, speakerId: "a", text: "vamos começar a reunião de hoje", lang: "pt-BR" }, 1_001_000 + i * 2000);
  assert.equal(captionLanguageIssue(s, "pt-BR"), null);
});

test("nome lido da tela só preenche lacunas; o nome do protocolo tem prioridade", () => {
  const s = session();
  assert.equal(applyEvent(s, { kind: "speaker", speakerId: "spaces/x/devices/1", name: "Ana (tela)", source: "dom", weak: true }), true);
  assert.equal(speakerName(s, "spaces/x/devices/1"), "Ana (tela)");
  assert.equal(applyEvent(s, { kind: "speaker", speakerId: "spaces/x/devices/1", name: "Ana Teste" }), true);
  assert.equal(applyEvent(s, { kind: "speaker", speakerId: "spaces/x/devices/1", name: "Outro Nome", weak: true }), false);
  assert.equal(speakerName(s, "spaces/x/devices/1"), "Ana Teste");
  assert.equal(speakerName(s, "voz:2"), "Falante 2");
});

test("revisão: pedido com glossário e contexto; resposta validada", () => {
  const items = [{ id: "1/a", speaker: "Ana", text: "o orçamento do quiu quatro" }, { id: "2/b", speaker: "Bruno", text: "fechado" }];
  const req = reviewRequest(items, { glossary: "Q4\nOKR", context: [{ id: "0/a", speaker: "Ana", text: "Bom dia" }] });
  assert.equal(req.format.type, "json_schema");
  assert.match(req.messages[0].content, /<glossario>\nQ4\nOKR\n<\/glossario>/);
  assert.match(req.messages[0].content, /<contexto_anterior>[\s\S]*Bom dia/);
  const fixes = parseReview(JSON.stringify({ fixes: [
    { id: "1/a", text: "o orçamento do Q4" },
    { id: "2/b", text: "fechado" }, // igual: ignorado
    { id: "9/x", text: "id inventado" }, // não pedido: ignorado
    { id: "2/b", text: "fechado e aprovado por todos os diretores da empresa ontem à noite" }, // reescrita demais
  ] }), items);
  assert.deepEqual(fixes, { "1/a": "o orçamento do Q4" });
  assert.deepEqual(parseReview("isto não é json", items), {});
});

function tone(ms, amp = 0.2, sr = 16000) {
  const n = Math.round((sr * ms) / 1000);
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / sr));
}
function silence(ms, sr = 16000) {
  return Float32Array.from({ length: Math.round((sr * ms) / 1000) }, () => (Math.random() - 0.5) * 0.002);
}

test("segmentador: corta nas pausas e ignora ruído curto", () => {
  const segs = [];
  const sg = new Segmenter({ onSegment: (s) => segs.push(s) });
  let idx = 0;
  for (const chunk of [silence(500), tone(1200), silence(900), tone(100), silence(900), tone(2000), silence(1000)]) {
    sg.push(chunk, idx);
    idx += chunk.length;
  }
  assert.equal(segs.length, 2); // o "estalo" de 100 ms não vira segmento
  assert.ok(segs[0].startSample < 8000 && segs[0].startSample > 2000); // inclui ~300 ms antes da fala
  assert.ok(segs[0].samples.length / 16000 > 1.2 && segs[0].samples.length / 16000 < 2.0);
});

test("segmentador: fala contínua é cortada antes de 14 s, no ponto mais baixo", () => {
  const segs = [];
  const sg = new Segmenter({ onSegment: (s) => segs.push(s) });
  // 20 s de fala com uma pequena queda de volume (sem pausa real) por volta de 12 s
  const speech = Float32Array.from({ length: 16000 * 20 }, (_, i) => (i > 16000 * 12 && i < 16000 * 12.1 ? 0.03 : 0.2) * Math.sin(i / 7));
  sg.push(speech, 0);
  sg.flush();
  assert.equal(segs.length, 2);
  const cut = segs[0].endSample / 16000;
  assert.ok(cut > 11.9 && cut < 12.2, `corte em ${cut}s`);
  assert.equal(segs[1].startSample, segs[0].endSample); // nada se perde entre os dois
});

test("limpeza do Whisper: alucinações e loops", () => {
  assert.equal(cleanTranscript("Legendas pela comunidade Amara.org"), "");
  assert.equal(cleanTranscript("Obrigado por assistir!"), "");
  assert.equal(cleanTranscript("Obrigado, Ana, pela apresentação."), "Obrigado, Ana, pela apresentação.");
  assert.equal(cleanTranscript("sim, sim, sim, sim, sim, sim"), "sim sim sim");
});

test("Gravador do computador: áudio do sistema vira 'outros', microfone vira 'você'", () => {
  const s = createSession({ id: "d", platform: "slack", title: "Huddle", startedAt: 2_000_000 });
  s.speakers.outros = "Participantes";
  addAsrSegment(s, { start: 2_001_000, end: 2_004_000, text: "Bom dia, vamos revisar o roadmap.", source: "system" });
  addAsrSegment(s, { start: 2_005_000, end: 2_007_000, text: "Pode começar, estou ouvindo.", source: "mic" }, "me");
  const blocks = toBlocks(s);
  assert.deepEqual(blocks.map((b) => b.speaker), ["Participantes", "Você"]);
});

import { VoiceBook } from "../src/asr/speakers.js";
import * as transcriptMod from "../src/lib/transcript.js";

test("vozes: embeddings parecidos viram o mesmo falante; diferentes viram outro", () => {
  const book = new VoiceBook();
  const a = Float32Array.from([1, 0, 0, 0.1]);
  const a2 = Float32Array.from([0.95, 0.1, 0, 0.1]);
  const b = Float32Array.from([0, 1, 0.1, 0]);
  assert.equal(book.assign(a), "voz:1");
  assert.equal(book.assign(a2), "voz:1");
  assert.equal(book.assign(b), "voz:2");
  assert.equal(book.assign(Float32Array.from([0.1, 0.9, 0.1, 0])), "voz:2");
  assert.equal(book.size, 2);
});

test("vozes: aprende o nome pela legenda e usa a voz quando a legenda falta (ou no gravador)", () => {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "dev/ana", name: "Ana" });
  // duas falas da Ana cobertas por legendas: a voz 1 aprende que é a Ana
  for (let i = 0; i < 2; i++) {
    const at = 1_000_000 + i * 10_000;
    applyEvent(s, { kind: "caption", id: `c${i}/dev/ana`, speakerId: "dev/ana", text: "estamos revisando o orçamento do trimestre" }, at + 1200);
    s.entries[s.entries.length - 1].updatedAt = at + 4000;
    assert.equal(addAsrSegment(s, { start: at, end: at + 3000, text: "estamos revisando o orçamento", source: "tab", voice: "voz:1" }), true);
    assert.equal(s.asr[s.asr.length - 1].speakerId, "dev/ana");
  }
  // sem legenda nenhuma por perto: a voz 1 ainda é a Ana; a voz 2 vira "Falante 2"
  assert.equal(addAsrSegment(s, { start: 2_000_000, end: 2_003_000, text: "fechamos então", source: "tab", voice: "voz:1" }), true);
  assert.equal(s.asr[s.asr.length - 1].speakerId, "dev/ana");
  assert.equal(addAsrSegment(s, { start: 2_010_000, end: 2_013_000, text: "concordo com a proposta", source: "tab", voice: "voz:2" }), true);
  assert.equal(speakerName(s, s.asr[s.asr.length - 1].speakerId), "Falante 2");
  // gravador: áudio do sistema com voz identificada não vira "outros"
  const r = session();
  addAsrSegment(r, { start: 10_000, end: 13_000, text: "bom dia a todos", source: "system", voice: "voz:1" }, "me");
  addAsrSegment(r, { start: 20_000, end: 23_000, text: "bom dia", source: "system", voice: "voz:2" }, "me");
  assert.deepEqual(r.asr.map((a) => a.speakerId), ["voz:1", "voz:2"]);
  assert.deepEqual(toBlocks(r).map((b) => b.speaker), ["Falante 1", "Falante 2"]);
});

test("Slack: o indicador 'falando' da plataforma dá o falante ao segmento do Whisper", () => {
  const s = session();
  assert.equal(applyEvent(s, { kind: "meeting-start", key: "slack:C1", title: "Huddle em #geral" }), false);
  applyEvent(s, { kind: "speaker", speakerId: "slack:Ana", name: "Ana" });
  assert.equal(applyEvent(s, { kind: "turn", id: "t1", speakerId: "slack:Ana", start: 1000, end: 3000 }), true);
  assert.equal(applyEvent(s, { kind: "turn", id: "t1", speakerId: "slack:Ana", start: 1000, end: 5000 }), true); // fala longa: fim atualizado
  assert.equal(applyEvent(s, { kind: "turn", id: "t1", speakerId: "slack:Ana", start: 1000, end: 5000 }), false);
  applyEvent(s, { kind: "turn", id: "t2", speakerId: "slack:Bruno", start: 5200, end: 8000 });
  assert.equal(s.turns.length, 2);
  assert.equal(resolveSpeaker(s, 1500, 4000), "slack:Ana");
  assert.equal(resolveSpeaker(s, 5500, 7000), "slack:Bruno");
  addAsrSegment(s, { start: 1200, end: 4500, text: "vamos começar pelo orçamento", source: "tab" });
  assert.equal(s.asr[0].speakerId, "slack:Ana");
  assert.equal(speakerName(s, "slack:Ana"), "Ana");
});

test("Gravador do computador: eco da caixa de som no microfone é descartado", () => {
  const s = createSession({ id: "e", platform: "slack", title: "Huddle", startedAt: 3_000_000 });
  // o microfone capta a fala do outro participante ~300 ms depois
  addAsrSegment(s, { start: 3_001_000, end: 3_004_000, text: "A entrega fica para sexta-feira.", source: "system" });
  assert.equal(addAsrSegment(s, { start: 3_001_300, end: 3_004_200, text: "a entrega fica pra sexta-feira", source: "mic" }, "me"), false);
  // se o eco for transcrito antes, a versão do sistema substitui a do microfone
  addAsrSegment(s, { start: 3_010_000, end: 3_012_000, text: "Quem cuida do contrato?", source: "mic" }, "me");
  addAsrSegment(s, { start: 3_009_800, end: 3_011_900, text: "Quem cuida do contrato?", source: "system" });
  // fala diferente no mesmo momento (as duas pessoas falando) é mantida
  addAsrSegment(s, { start: 3_020_000, end: 3_022_000, text: "Eu cuido disso amanhã.", source: "mic" }, "me");
  addAsrSegment(s, { start: 3_020_500, end: 3_022_500, text: "Ótimo, obrigado.", source: "system" });
  assert.deepEqual(
    s.asr.map((a) => [a.source, a.text]),
    [["system", "A entrega fica para sexta-feira."], ["system", "Quem cuida do contrato?"], ["mic", "Eu cuido disso amanhã."], ["system", "Ótimo, obrigado."]],
  );
});

// ---------------- Sincronização com a conta: mescla de versões ----------------
import { mergeDocs, sameContent } from "../src/lib/sync.js";

const doc = (over = {}) => ({
  id: "m", title: "Reunião", startedAt: 1000, updatedAt: 2000, endedAt: null, speakers: { a: "Ana" },
  entries: [{ id: "1", at: 1100, updatedAt: 1200, speakerId: "a", text: "Olá", kind: "caption" }],
  asr: [], chats: [], notes: { text: "", items: [] }, highlights: {}, fixes: {}, reviewed: {}, aliases: {}, langs: {}, shots: [], summary: null,
  ...over,
});

test("Sincronização: falas dos dois lados são somadas, sem duplicar", () => {
  const local = doc({ updatedAt: 3000, entries: [...doc().entries, { id: "2", at: 1300, updatedAt: 1400, speakerId: "a", text: "Tudo bem?", kind: "caption" }] });
  const remote = doc({ updatedAt: 2500, entries: [...doc().entries, { id: "3", at: 1250, updatedAt: 1260, speakerId: "b", text: "Oi", kind: "caption" }] });
  const m = mergeDocs(local, remote);
  assert.deepEqual(m.entries.map((e) => e.id), ["1", "3", "2"]);
});

test("Sincronização: a mesma fala editada nos dois lados fica com a versão mais recente", () => {
  const local = doc({ entries: [{ id: "1", at: 1100, updatedAt: 1500, speakerId: "a", text: "Olá a todos", kind: "caption" }] });
  const remote = doc({ entries: [{ id: "1", at: 1100, updatedAt: 1200, speakerId: "a", text: "Olá", kind: "caption" }] });
  assert.equal(mergeDocs(local, remote).entries[0].text, "Olá a todos");
});

test("Sincronização: conversa excluída não volta da outra cópia; editada vence pela data; restaurada volta", () => {
  const c1 = { id: "c1", createdAt: 1, updatedAt: 10, messages: [{ role: "user", text: "a?" }, { role: "assistant", text: "A" }] };
  const c2 = { id: "c2", createdAt: 2, updatedAt: 10, messages: [{ role: "user", text: "b?" }, { role: "assistant", text: "B" }] };
  const local = doc({ updatedAt: 3000, chats: [c2], deletedChats: [{ id: "c1", at: 20 }] });
  const remote = doc({ updatedAt: 2000, chats: [c1, c2] });
  assert.deepEqual(mergeDocs(local, remote).chats.map((c) => c.id), ["c2"]);
  assert.deepEqual(mergeDocs(remote, local).chats.map((c) => c.id), ["c2"], "vale nos dois sentidos");
  const edited = { ...c2, updatedAt: 30, messages: [{ role: "user", text: "b editada?", edited: true }, { role: "assistant", text: "B2" }] };
  assert.equal(mergeDocs(doc({ updatedAt: 1500, chats: [edited] }), doc({ updatedAt: 2500, chats: [c2] })).chats[0].messages[1].text, "B2");
  const restored = doc({ updatedAt: 4000, chats: [{ ...c1, updatedAt: 40 }, c2] });
  assert.deepEqual(mergeDocs(restored, local).chats.map((c) => c.id), ["c1", "c2"]);
});

test("Sincronização: título e ata vêm do lado alterado por último; nomes, notas e conversas se juntam", () => {
  const local = doc({ updatedAt: 1500, title: "Antigo", speakers: { a: "Ana" }, notes: { text: "nota local", items: [{ id: "n1", at: 1, text: "x" }] }, chats: [{ id: "c1", createdAt: 1, messages: [{ role: "user", text: "?" }] }], shots: [{ id: "s1" }] });
  const remote = doc({ updatedAt: 4000, title: "Orçamento Q4", speakers: { b: "Bruno" }, summary: { text: "## Resumo" }, notes: { text: "", items: [{ id: "n2", at: 2, text: "y" }] }, chats: [{ id: "c2", createdAt: 2, messages: [] }] });
  const m = mergeDocs(local, remote);
  assert.equal(m.title, "Orçamento Q4");
  assert.equal(m.summary.text, "## Resumo");
  assert.deepEqual(m.speakers, { a: "Ana", b: "Bruno" });
  assert.equal(m.notes.text, "nota local");
  assert.deepEqual(m.notes.items.map((n) => n.id), ["n1", "n2"]);
  assert.deepEqual(m.chats.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(m.shots, [{ id: "s1" }], "capturas locais não se perdem");
  assert.equal(m.updatedAt, 4000);
});

test("Sincronização: sameContent ignora capturas e carimbo de tempo", () => {
  assert.ok(sameContent(doc({ updatedAt: 1, shots: [{ id: "x" }] }), doc({ updatedAt: 9 })));
  assert.ok(!sameContent(doc(), doc({ title: "Outro" })));
});

test("mesclar falantes: falas, votos e eventos novos vão para o destino; nome do destino prevalece", () => {
  const s = normalize({ id: "m1", startedAt: 0, speakers: { "dev/428": "Participante 428", "dev/434": "Thiago" } });
  applyEvent(s, { kind: "caption", id: "c1", speakerId: "dev/428", text: "Bom dia a todos, vamos começar a reunião", version: 1 }, 1000);
  applyEvent(s, { kind: "caption", id: "c2", speakerId: "dev/434", text: "Vamos sim, pode começar pelo orçamento", version: 1 }, 2000);
  s.voices["voz:1"] = { "dev/428": 2 };
  assert.equal(mergeSpeakers(s, "dev/428", "dev/434"), 1);
  assert.equal(canonicalSpeaker(s, "dev/428"), "dev/434");
  assert.equal(speakerName(s, "dev/428"), "Thiago");
  assert.ok(!("dev/428" in s.speakers));
  assert.deepEqual(s.voices["voz:1"], { "dev/434": 2 });
  assert.ok(s.entries.every((e) => e.speakerId === "dev/434"));
  // fala nova com o id antigo cai no destino; nome novo para o id antigo é ignorado
  applyEvent(s, { kind: "caption", id: "c3", speakerId: "dev/428", text: "Então vamos aos números do trimestre", version: 1 }, 3000);
  assert.equal(s.entries.find((e) => e.id === "c3").speakerId, "dev/434");
  assert.equal(applyEvent(s, { kind: "speaker", speakerId: "dev/428", name: "Outro" }), false);
  assert.deepEqual(participantNames(s), ["Thiago"]);
  // cadeia: mesclar o destino em um terceiro leva o antigo junto
  s.speakers["dev/500"] = "Thiago Meneses";
  mergeSpeakers(s, "dev/434", "dev/500");
  assert.equal(canonicalSpeaker(s, "dev/428"), "dev/500");
  assert.equal(speakerName(s, "dev/428"), "Thiago Meneses");
});

import { diffWords, diffDocument, diffStats, diffHtml, commitSummary, describeVersion } from "../src/lib/diff.js";

test("diff por palavras e por linhas: trocas, inserções, remoções e estatísticas", () => {
  assert.deepEqual(diffWords("o gato preto", "o gato branco e feliz"), [
    { op: "eq", text: "o gato " }, { op: "del", text: "preto" }, { op: "add", text: "branco e feliz" },
  ]);
  const a = "## Decisões\n- Mídia aprovada: R$ 180 mil (Bruno)\n- Ana assume a mídia\n\n## Pendências\n- Paula envia até sexta";
  const b = "## Decisões\n- Mídia aprovada: R$ 200 mil (Bruno, 00:31)\n- Ana assume a mídia\n- Orçamento fechado hoje\n\n## Pendências\n- Paula envia até quinta";
  const blocks = diffDocument(a, b);
  assert.deepEqual(blocks.map((x) => x.kind), ["same", "changed", "same", "added", "same", "same", "changed"]);
  assert.deepEqual(diffStats(blocks), { added: 7, removed: 2, changedLines: 3 });
  const html = diffHtml(blocks, { onlyChanges: true });
  assert.match(html, /<del>180<\/del><ins>200<\/ins>/);
  assert.match(html, /<ins>- Orçamento fechado hoje<\/ins>/);
  assert.match(diffHtml(blocks, { mode: "side" }), /<div class="dcell">/);
  // textos iguais e acentuação preservada
  assert.equal(diffStats(diffDocument("Ação", "Ação")).changedLines, 0);
  assert.equal(diffWords("", "").length, 0);
});

test("histórico da ata: versões encadeadas, sem duplicar texto igual, com rótulo e tamanho da mudança", () => {
  const s = normalize({ id: "h1", startedAt: 0 });
  const v1 = commitSummary(s, { text: "## Resumo\nReunião curta." }, { source: "ai" });
  assert.equal(v1.n, 1);
  assert.equal(commitSummary(s, { text: "## Resumo\nReunião curta." }, { source: "ai" }), null, "texto igual não vira versão");
  const v2 = commitSummary(s, { text: "## Resumo\nReunião curta e produtiva." }, { source: "edit", label: "Editada à mão" });
  assert.equal(v2.n, 2);
  assert.equal(v2.parentId, v1.id);
  assert.match(describeVersion(s, v2), /\+2 −0 palavras/);
  const v3 = commitSummary(s, { text: v1.text }, { source: "restore", label: "Restaurada da v1", parentId: v1.id });
  assert.equal(v3.n, 3);
  assert.equal(s.summaryHistory.length, 3);
});

test("normalize transforma uma ata antiga (sem histórico) na v1, sem duplicar", async () => {
  const { commitSummary } = await import("../src/lib/diff.js");
  const s = normalize({ id: "a1", startedAt: 1000, summary: { text: "# Ata\nAprovado.", createdAt: 5000, model: "claude-x" } });
  assert.equal(s.summaryHistory.length, 1);
  assert.equal(s.summaryHistory[0].n, 1);
  assert.equal(s.summaryHistory[0].text, "# Ata\nAprovado.");
  assert.equal(s.summaryHistory[0].createdAt, 5000);
  assert.equal(s.summaryHistory[0].id, "v1-" + (5000).toString(36), "id determinístico: o mesmo em todos os dispositivos");
  assert.equal(normalize(s).summaryHistory.length, 1, "normalizar de novo não duplica");
  assert.equal(commitSummary(s, s.summary, { source: "ai" }), null, "texto igual não vira nova versão");
  commitSummary(s, { text: "# Ata\nAprovado e assinado.", createdAt: 6000 }, { source: "ai" });
  assert.equal(s.summaryHistory.length, 2);
  assert.equal(s.summaryHistory[1].parentId, s.summaryHistory[0].id);
});

test("ataRequest: instruções extras entram no fim do system prompt e prevalecem", async () => {
  const { ataRequest } = await import("../src/lib/ai.js");
  const s = normalize({ id: "i1", startedAt: 0, title: "Daily", entries: [], speakers: {} });
  const plain = ataRequest(s, [], "", "");
  assert.doesNotMatch(plain.system, /<instrucoes>/);
  const r = ataRequest(s, [], "Q4", "# Modelo {{conclusao}}", "Conclusão em um parágrafo só. <instrucoes>x</instrucoes>");
  assert.match(r.system, /EXATAMENTE o modelo/);
  assert.match(r.system, /Grafia correta[\s\S]*INSTRUÇÕES EXTRAS DO USUÁRIO[\s\S]*<instrucoes>\nConclusão em um parágrafo só\. x\n<\/instrucoes>$/, "vêm por último e sem tags aninhadas");
  assert.match(r.messages[0].content, /Siga as instruções extras do usuário\.$/);
  const seeded = normalize({ id: "i2", startedAt: 0, ataPrompt: undefined });
  assert.equal(seeded.ataPrompt, "", "campo novo em sessões antigas");
});

test("ataEditorHtml: HTML no formato do TinyMCE do Atena (justificado, <li><p>, <hr />, assinatura centralizada)", async () => {
  const { ataEditorHtml } = await import("../src/lib/format.js");
  const md = `# SUBPLEI / ASSESSORIA 2

**Registro de Reunião [preencher]**

**Data:** 16 de janeiro de 2026
**Horário:** 13h30min
**Assunto Principal:** Padronização *arquitetural* e logs

**Participantes:**

- Dr. Rafael Correa Costa, Promotor de Justiça
- André Pereira Teles, Desenvolvedor

**Resumo das Atividades por Participante:**

- **André Pereira Teles:** Apresentou a nova estrutura modular.
- **Dr. Rafael Correa Costa:** Validou a arquitetura & sugeriu pre-commit.

**Conclusão:**

Após as atualizações de todos os presentes e a definição dos encaminhamentos, e não havendo mais pautas, a reunião foi encerrada.

RAFAEL CORREA COSTA
Promotor de Justiça
Assessor Jurídico-Administrativo da PGJ`;
  const html = ataEditorHtml(md);
  assert.match(html, /^<p style="text-align: justify;"><strong>SUBPLEI \/ ASSESSORIA 2<\/strong><\/p>/);
  assert.match(html, /<p style="text-align: justify;"><strong>Data:<\/strong> 16 de janeiro de 2026<\/p>/);
  assert.match(html, /<strong>Assunto Principal:<\/strong> Padronização <em>arquitetural<\/em> e logs/);
  assert.match(html, /<strong>Participantes:<\/strong><\/p>\n<ul style="text-align: justify;">\n<li>\n<p>Dr\. Rafael Correa Costa, Promotor de Justiça<\/p>\n<\/li>/);
  assert.match(html, /<\/ul>\n<hr \/>\n<p style="text-align: justify;"><strong>Resumo das Atividades por Participante:<\/strong><\/p>/, "hr antes de uma seção que vem depois de lista");
  assert.match(html, /<li>\n<p><strong>Dr\. Rafael Correa Costa:<\/strong> Validou a arquitetura &amp; sugeriu pre-commit\.<\/p>/);
  assert.match(html, /<hr \/>\n<p style="text-align: justify;"><strong>Conclusão:<\/strong><\/p>\n<p style="text-align: justify;">Após as atualizações/);
  assert.match(html, /a reunião foi encerrada\.<\/p>\n<hr \/>\n<p style="text-align: center;">&nbsp;<\/p>\n<p style="text-align: center;"><strong>RAFAEL CORREA COSTA<\/strong><\/p>\n<p style="text-align: center;">Promotor de Justiça<\/p>\n<p style="text-align: center;">Assessor Jurídico-Administrativo da PGJ<\/p>$/, "assinatura centralizada no fim");
  assert.doesNotMatch(html, /<h\d|<ul>\s*<li>[^<]/, "sem títulos h e sem li sem parágrafo");
  // sem assinatura: nada centralizado
  assert.doesNotMatch(ataEditorHtml("## Resumo\nTexto.\n\n## Decisões\n- A\n- B"), /center/);
});

test("toBlocks: pausa de 2,5 s ou parágrafo longo abre parágrafo novo; 30 s de monólogo abre bloco novo no fim da frase", async () => {
  const { PARA_GAP_MS } = await import("../src/lib/transcript.js");
  const s = createSession({ id: "p1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  let t = 1_000_000;
  const say = (id, text, gap = 1000) => { t += gap; applyEvent(s, { kind: "caption", id, speakerId: "d", version: 1, text }, t); };
  say("a", "Primeira frase do mesmo parágrafo.");
  say("b", "Segunda frase, logo em seguida.");
  say("c", "Depois de uma pausa vem outro parágrafo.", PARA_GAP_MS + 100);
  let blocks = toBlocks(s);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].paras.length, 2, "pausa abre parágrafo");
  assert.equal(blocks[0].paras[0].text, "Primeira frase do mesmo parágrafo. Segunda frase, logo em seguida.");
  assert.equal(blocks[0].paras[1].at, t);
  assert.equal(blocks[0].text, "Primeira frase do mesmo parágrafo. Segunda frase, logo em seguida.\n\nDepois de uma pausa vem outro parágrafo.");

  // parágrafo longo (>400 caracteres) só quebra quando a fala anterior terminou a frase
  const longo = "palavra ".repeat(60).trim() + " sem ponto";
  say("d", longo);
  say("e", "ainda no mesmo parágrafo porque o anterior não terminou a frase");
  say("f", "agora terminou.");
  say("g", "Parágrafo novo.");
  blocks = toBlocks(s);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].paras.length, 3);
  assert.ok(blocks[0].paras[1].text.endsWith("agora terminou."));
  assert.equal(blocks[0].paras[2].text, "Parágrafo novo.");

  // 30 s do mesmo falante: bloco novo assim que uma frase termina
  say("h", "Trinta segundos depois, frase que termina.", 25_000);
  say("i", "Esta já começa um bloco novo.");
  blocks = toBlocks(s);
  assert.equal(blocks.length, 2, "bloco novo depois de 30 s");
  assert.equal(blocks[1].text, "Trinta segundos depois, frase que termina. Esta já começa um bloco novo.");
  assert.equal(blocks[1].speakerId, "d");
  // os ids continuam todos cobertos (destaques e revisão não se perdem)
  assert.deepEqual([...blocks[0].ids, ...blocks[1].ids], ["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
});

test("glossário: 'Termo = erro, erro2' corrige palavra inteira, mantém maiúscula inicial e alimenta o prompt", async () => {
  const { compileGlossary, applyGlossary, glossaryForPrompt, parseGlossary } = await import("../src/lib/glossary.js");
  const rules = compileGlossary("Agno = argum, agnum\nOKR\nfront-end → front end, fronte\n# comentário");
  assert.equal(applyGlossary("Saída do argum. Argum é novo. argumento fica. front end e Fronte.", rules), "Saída do Agno. Agno é novo. argumento fica. front-end e Front-end.");
  assert.equal(applyGlossary("sem nada", []), "sem nada");
  assert.deepEqual(parseGlossary("Agno = argum\nOKR").terms, ["Agno", "OKR"]);
  const prompt = glossaryForPrompt("Agno = argum, agnum\nOKR", "direito administrativo e software");
  assert.equal(prompt, "Agno (as legendas costumam escrever: argum, agnum)\nOKR\nContexto das reuniões: direito administrativo e software");
});

test("exportações levam os parágrafos com o horário do segundo em diante", () => {
  const s = createSession({ id: "p2", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  applyEvent(s, { kind: "caption", id: "a", speakerId: "d", version: 1, text: "Começo." }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "b", speakerId: "d", version: 1, text: "Depois da pausa." }, 1_011_000);
  const txt = toText(s);
  assert.ok(txt.includes("Começo.\n\n[00:00:11] Depois da pausa."), txt);
  const md = toMarkdown(s);
  assert.ok(md.includes("Começo.\n\n`00:00:11` Depois da pausa."), md);
});

test("segmentador: microfone ruidoso mantém a fala (margem adaptativa) e a aba usa barra fixa", async () => {
  const { Segmenter } = await import("../src/asr/segmenter.js");
  const SR = 16000;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  // 20 s de ruído (rms ~0,006) com uma "fala" de 1,5 s (tom a rms ~0,02) aos 12 s
  const n = SR * 20;
  const audio = new Float32Array(n);
  for (let i = 0; i < n; i++) audio[i] = rand() * 0.006 * 3.46;
  for (let i = SR * 12; i < SR * 13.5; i++) audio[i] += Math.sin((2 * Math.PI * 220 * i) / SR) * 0.028;
  const got = [];
  const seg = new Segmenter({ sampleRate: SR, profile: "mic", onSegment: (s) => got.push(s) });
  for (let off = 0; off < n; off += SR) seg.push(audio.subarray(off, Math.min(n, off + SR)), off);
  seg.flush();
  assert.equal(got.length, 1, "um trecho de fala no microfone ruidoso: " + got.length);
  assert.ok(Math.abs(got[0].startSample / SR - 12) < 0.5, "começa perto dos 12 s: " + got[0].startSample / SR);
  assert.ok(got[0].speechRms > 0.015 && got[0].levels.length === got[0].speechMask.length, "nível de fala e máscaras no trecho");
  // a mesma gravação sem fala não produz nada
  const quiet = new Float32Array(n);
  for (let i = 0; i < n; i++) quiet[i] = rand() * 0.006 * 3.46;
  const none = [];
  const seg2 = new Segmenter({ sampleRate: SR, profile: "mic", onSegment: (s) => none.push(s) });
  for (let off = 0; off < n; off += SR) seg2.push(quiet.subarray(off, Math.min(n, off + SR)), off);
  seg2.flush();
  assert.equal(none.length, 0, "ruído constante não vira fala");
});

test("filtro de eco por energia: fala própria passa, vazamento da caixa de som cai", async () => {
  const { ownSpeechRatio, ECHO_KEEP_RATIO } = await import("../src/asr/segmenter.js");
  const frames = 40;
  const seg = { levels: Float32Array.from({ length: frames }, () => 0.01), speechMask: new Uint8Array(frames).fill(1) };
  const t = [], rms = [];
  for (let i = 0; i < frames; i++) { t.push(5000 + i * 30); rms.push(0.05); } // os outros falando alto ao mesmo tempo
  assert.ok(ownSpeechRatio(seg, 5000, { t, rms }) < ECHO_KEEP_RATIO, "mic baixo durante fala alta dos outros é eco");
  const loud = { levels: Float32Array.from({ length: frames }, () => 0.04), speechMask: new Uint8Array(frames).fill(1) };
  assert.ok(ownSpeechRatio(loud, 5000, { t, rms }) >= ECHO_KEEP_RATIO, "mic com energia comparável é fala própria");
  assert.equal(ownSpeechRatio(seg, 60000, { t, rms }), 1, "sem áudio dos outros no momento, tudo é fala própria");
});

test("eco por texto (trigramas), nivelamento e frases prontas", async () => {
  const { textEchoRatio } = await import("../src/lib/transcript.js");
  const { levelSamples, isStockPhrase, isNoiseMarker, cleanTranscript } = await import("../src/asr/segmenter.js");
  assert.ok(textEchoRatio("a gente precisa fechar o orçamento até sexta", ["Então a gente precisa fechar o orçamento até sexta, certo?"]) >= 0.5);
  assert.ok(textEchoRatio("eu discordo completamente dessa proposta", ["a gente precisa fechar o orçamento até sexta"]) < 0.5);
  assert.ok(textEchoRatio("ok", ["ok, combinado"]) >= 0.5, "frase curta: sequência inteira");
  const quiet = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 10) * 0.01);
  const out = levelSamples(quiet, 0.007);
  assert.ok(Math.max(...out) > 0.05 && Math.max(...out) <= 0.95, "fala baixa é amplificada sem estourar");
  assert.ok(isStockPhrase("Obrigado.") && isStockPhrase("Thank you") && !isStockPhrase("Obrigado pela proposta, vamos analisar."));
  assert.ok(isNoiseMarker("[música]") && isNoiseMarker("(risos)") && isNoiseMarker("...") && !isNoiseMarker("música ao fundo"));
  assert.equal(cleanTranscript("*aplausos*"), "");
  assert.equal(cleanTranscript("Obrigado."), "Obrigado.", "frase pronta não cai só pelo texto: depende do nível de áudio");
});

test("addAsrSegment: eco por texto vale para a aba (Meet) e remove o eco que chegou antes", () => {
  const s = createSession({ id: "e1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  s.asr = [];
  const { addAsrSegment } = globalThis.__tx || {};
  // importado estaticamente no topo do arquivo? usa import dinâmico para não mexer no cabeçalho
  return import("../src/lib/transcript.js").then(({ addAsrSegment }) => {
    assert.ok(addAsrSegment(s, { start: 1_000_000, end: 1_003_000, text: "vamos começar pelo backlog da sprint", source: "mic" }, "me"));
    assert.ok(addAsrSegment(s, { start: 1_000_200, end: 1_003_200, text: "Então vamos começar pelo backlog da sprint de hoje.", source: "tab" }, "me"));
    assert.deepEqual(s.asr.map((a) => a.source), ["tab"], "o eco do microfone que chegou antes foi removido");
    assert.equal(addAsrSegment(s, { start: 1_010_000, end: 1_012_000, text: "pode ser, o deploy ficou pendente", source: "tab" }, "me"), true);
    assert.equal(addAsrSegment(s, { start: 1_010_300, end: 1_012_300, text: "pode ser o deploy ficou pendente", source: "mic" }, "me"), false, "eco do microfone que chega depois é descartado");
    assert.equal(addAsrSegment(s, { start: 1_010_300, end: 1_012_300, text: "eu discordo, o deploy não era prioridade", source: "mic" }, "me"), true, "fala própria diferente entra");
  });
});

test("cofre de áudio: retenção e cota apagam as mais antigas, poupando 'manter' e reuniões em andamento", async () => {
  const { planEviction } = await import("../src/lib/audiovault.js");
  const day = 86_400_000;
  const now = 100 * day;
  const items = [
    { id: "velha", bytes: 10, startedAt: now - 40 * day, keep: false },
    { id: "mantida", bytes: 50, startedAt: now - 60 * day, keep: true },
    { id: "a", bytes: 30, startedAt: now - 10 * day, keep: false },
    { id: "b", bytes: 30, startedAt: now - 5 * day, keep: false },
    { id: "ativa", bytes: 30, startedAt: now - 1 * day, keep: false },
  ];
  // retenção de 30 dias tira "velha"; cota de 100 bytes ainda precisa tirar 30+30+30+50=140 -> 100: sai "a" (mais antiga apagável)
  assert.deepEqual(planEviction(items, { limitBytes: 100, retentionMs: 30 * day, now, protect: new Set(["ativa"]) }).sort(), ["a", "b", "velha"]);
  assert.deepEqual(planEviction(items, { limitBytes: 120, retentionMs: 30 * day, now, protect: new Set(["ativa"]) }).sort(), ["a", "velha"], "cota de 120 bytes: só a mais antiga apagável sai");
  assert.deepEqual(planEviction(items, { limitBytes: 0, retentionMs: 0, now }), [], "sem limites, nada sai");
  assert.deepEqual(planEviction(items, { limitBytes: 10, retentionMs: 0, now, protect: new Set(["ativa"]) }).sort(), ["a", "b", "velha"], "cota apertada poupa só a mantida e a ativa");
});

test("edição manual: texto, falante e apagar com desfazer; a revisão da IA não sobrescreve", async () => {
  const { editBlock, undoEdit, effectiveEntries } = await import("../src/lib/transcript.js");
  const s = createSession({ id: "ed1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  applyEvent(s, { kind: "caption", id: "a", speakerId: "d", version: 1, text: "o deploi ficou pra sexta" }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "b", speakerId: "d", version: 1, text: "e o front end também" }, 1_002_000);
  applyEvent(s, { kind: "caption", id: "c", speakerId: "e", version: 1, text: "combinado" }, 1_004_000);
  s.fixes.a = "o deploy ficou pra sexta"; // revisão da IA
  assert.ok(editBlock(s, ["a", "b"], { text: "O deploy e o front-end ficaram para sexta." }, "texto"));
  let eff = effectiveEntries(s);
  assert.deepEqual(eff.map((e) => e.id), ["a", "c"], "a segunda fala do bloco some (texto foi para a primeira)");
  assert.equal(eff[0].text, "O deploy e o front-end ficaram para sexta.");
  assert.ok(eff[0].edited && !eff[0].fixed && eff[0].original === "o deploi ficou pra sexta", "correção manual vence a revisão e guarda o original");
  assert.ok(editBlock(s, ["c"], { speakerId: "d" }, "falante"));
  assert.equal(effectiveEntries(s).find((e) => e.id === "c").speakerId, "d");
  assert.ok(editBlock(s, ["c"], { deleted: true }, "apagar"));
  assert.deepEqual(effectiveEntries(s).map((e) => e.id), ["a"]);
  assert.equal(s.undo.length, 3);
  undoEdit(s);
  assert.deepEqual(effectiveEntries(s).map((e) => e.id), ["a", "c"], "desfazer o apagar");
  undoEdit(s);
  assert.equal(effectiveEntries(s).find((e) => e.id === "c").speakerId, "e", "desfazer a troca de falante");
  undoEdit(s);
  eff = effectiveEntries(s);
  assert.deepEqual(eff.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(eff[0].text, "o deploy ficou pra sexta", "sem edição, a revisão da IA volta a valer");
  assert.equal(undoEdit(s), null);
  assert.equal(toBlocks(s)[0].text, "o deploy ficou pra sexta e o front end também");
});

test("dividir uma fala em duas: segunda parte com outro falante, corrigível, divisível de novo e com desfazer", async () => {
  const { splitBlock, editBlock, undoEdit, effectiveEntries } = await import("../src/lib/transcript.js");
  const s = createSession({ id: "sp1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "speaker", speakerId: "b", name: "Bruno" });
  applyEvent(s, { kind: "caption", id: "x", speakerId: "a", version: 1, text: "Podemos fechar hoje?" }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "y", speakerId: "a", version: 1, text: "Sim, fechamos hoje. E o contrato?" }, 1_003_000);
  s.entries.at(-1).updatedAt = 1_009_000;
  s.highlights = {};
  const [b0] = toBlocks(s);
  assert.equal(b0.text, "Podemos fechar hoje? Sim, fechamos hoje. E o contrato?");
  const id = splitBlock(s, ["x", "y"], { before: "Podemos fechar hoje?", after: "Sim, fechamos hoje. E o contrato?", speakerId: "b", at: 1_003_000 }, "dividir");
  assert.equal(id, "x~2");
  let blocks = toBlocks(s);
  assert.deepEqual(blocks.map((b) => [b.speaker, b.text]), [["Ana", "Podemos fechar hoje?"], ["Bruno", "Sim, fechamos hoje. E o contrato?"]]);
  assert.ok(blocks[1].edited && blocks[1].ids[0] === "x~2");
  // a segunda parte aceita as mesmas correções, inclusive outra divisão
  assert.equal(splitBlock(s, ["x~2"], { before: "Sim, fechamos hoje.", after: "E o contrato?", speakerId: "a", at: 1_006_000 }), "x~2~2");
  assert.deepEqual(toBlocks(s).map((b) => [b.speaker, b.text]), [["Ana", "Podemos fechar hoje?"], ["Bruno", "Sim, fechamos hoje."], ["Ana", "E o contrato?"]]);
  assert.ok(editBlock(s, ["x~2~2"], { text: "E o contrato, já foi assinado?" }, "texto"));
  assert.equal(toBlocks(s)[2].text, "E o contrato, já foi assinado?");
  // dividir de novo a primeira fala não apaga a divisão anterior
  assert.equal(splitBlock(s, ["x"], { before: "Podemos", after: "fechar hoje?", speakerId: "a", at: 1_002_000 }), "x~3");
  assert.equal(effectiveEntries(s).length, 4);
  assert.equal(s.undo.length, 4);
  undoEdit(s); undoEdit(s); undoEdit(s);
  assert.deepEqual(toBlocks(s).map((b) => [b.speaker, b.text]), [["Ana", "Podemos fechar hoje?"], ["Bruno", "Sim, fechamos hoje. E o contrato?"]]);
  undoEdit(s);
  assert.deepEqual(toBlocks(s).map((b) => b.text), ["Podemos fechar hoje? Sim, fechamos hoje. E o contrato?"], "desfazer tudo volta ao original");
  assert.equal(splitBlock(s, ["x"], { before: "", after: "tudo", speakerId: "b", at: 1 }), null, "precisa de texto dos dois lados");
});

test("capítulos: parseChapters valida, ajusta ao bloco mais próximo e limita; exportações levam a seção", async () => {
  const { parseChapters, chapterLines } = await import("../src/lib/ai.js");
  const s = createSession({ id: "ch1", platform: "meet", url: "https://meet.google.com/abc-defg-hij", title: "T", startedAt: 1_000_000 });
  let t = 1_000_000;
  for (let i = 0; i < 6; i++) { t += 60_000; applyEvent(s, { kind: "caption", id: "c" + i, speakerId: i % 2 ? "a" : "b", version: 1, text: "Assunto número " + i + " em discussão." }, t); }
  assert.ok(chapterLines(s).startsWith("[00:01:00] "), chapterLines(s).slice(0, 40));
  const ch = parseChapters('Aqui está:\n{"chapters":[{"start":"03:05","title":"\\"Orçamento do trimestre\\""},{"start":"00:00","title":"Abertura"},{"start":"03:00","title":"Repetido"},{"start":"xx","title":"inválido"},{"start":"05:02","title":"Encerramento e próximos passos"}]}', s);
  assert.deepEqual(ch.map((c) => [clockOf(c.startAt - s.startedAt), c.title]), [["00:01:00", "Abertura"], ["00:03:00", "Orçamento do trimestre"], ["00:05:00", "Encerramento e próximos passos"]]);
  assert.deepEqual(parseChapters("nada de json", s), []);
  assert.deepEqual(parseChapters('[{"start":"01:00","title":"Só um"}]', s).length, 1);
  s.chapters = ch;
  const md = toMarkdown(s);
  assert.ok(md.includes("## Capítulos") && md.includes("`00:03:00` Orçamento do trimestre") && md.includes("### 2. Orçamento do trimestre"), md);
  assert.ok(toText(s).includes("--- 2. Orçamento do trimestre ---"));
  function clockOf(ms) { const sec = Math.round(ms / 1000); return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, "0")).join(":"); }
});

test("leitura limpa: tira hesitações e repetições coladas, mantém o que tem sentido", async () => {
  const { cleanSpeech } = await import("../src/lib/clean.js");
  assert.equal(cleanSpeech("Ahn, eu acho que sim."), "Eu acho que sim.");
  assert.equal(cleanSpeech("Então, ahn, a gente vai eu eu eu vou ver."), "Então, a gente vai eu vou ver.");
  assert.equal(cleanSpeech("Eu acho, ahn."), "Eu acho.");
  assert.equal(cleanSpeech("Certo. Ahn, vamos lá."), "Certo. Vamos lá.");
  assert.equal(cleanSpeech("O que que é isso? Éé, sei lá."), "O que é isso? Sei lá.");
  assert.equal(cleanSpeech("Hum."), "");
  // ficam: repetição com vírgula, "ah", "né", "um" (artigo), números repetidos
  assert.equal(cleanSpeech("Não, não, não é isso."), "Não, não, não é isso.");
  assert.equal(cleanSpeech("Ah, entendi, né?"), "Ah, entendi, né?");
  assert.equal(cleanSpeech("um processo e um recurso"), "um processo e um recurso");
  assert.equal(cleanSpeech("Foram 10 10 casos"), "Foram 10 10 casos");
});

test("leitura limpa nos blocos e nas exportações; o texto guardado não muda", () => {
  const s = createSession({ id: "c", platform: "meet", url: "", title: "T", startedAt: 1_000_000 });
  s.speakers = { a: "Ana", b: "Bruno" };
  s.entries.push(
    { id: "x", kind: "caption", speakerId: "a", text: "Ahn, eu acho que sim.", at: 1_001_000, updatedAt: 1_002_000 },
    { id: "y", kind: "caption", speakerId: "b", text: "Hum.", at: 1_003_000, updatedAt: 1_003_500 },
    { id: "z", kind: "caption", speakerId: "a", text: "Então, ahn, fechado.", at: 1_004_000, updatedAt: 1_005_000 },
  );
  assert.equal(toBlocks(s).length, 3);
  const clean = toBlocks(s, { clean: true });
  assert.deepEqual(clean.map((b) => b.text), ["Eu acho que sim. Então, fechado."], "fala só de hesitação some e as vizinhas se juntam");
  assert.equal(s.entries[0].text, "Ahn, eu acho que sim.");
  assert.ok(!/ahn|Hum/i.test(toMarkdown(s, { clean: true })) && /Ahn/.test(toMarkdown(s)));
  assert.ok(!/ahn/i.test(toText(s, { clean: true })));
  assert.ok(!/ahn|Hum/i.test(toSrt(s, { clean: true })) && toSrt(s, { clean: true }).includes("Eu acho que sim."));
  assert.ok(/Hum/.test(toVtt(s)));
});

test("glossário: grafias parecidas com os termos e com os nomes dos participantes", async () => {
  const { fuzzyTargets, applyFuzzy } = await import("../src/lib/glossary.js");
  const T = fuzzyTargets("Maria Quitéria\nDomenico Failutti\nCásper Líbero\nóleo sobre tela\nMinistério Público\nhabeas corpus\nAgno = argum", ["Leonardo Andrade", "André Souza", "Rosa Lima", "Participante 3f2a", "Falante 2"]);
  const fix = (s) => applyFuzzy(s, T);
  assert.equal(fix("Retrato de Maria Quitérria, de Domênico Failut, técnica Olho Sobre Tela."), "Retrato de Maria Quitéria, de Domenico Failutti, técnica Óleo sobre tela.");
  assert.equal(fix("Faculdade Casper-Líbero."), "Faculdade Cásper Líbero.");
  assert.equal(fix("o ministerio publico pediu habeas corpos"), "o Ministério Público pediu habeas corpus");
  assert.equal(fix("Não faria sentido, né, Andre?"), "Não faria sentido, né, André?");
  // conservador: palavra comum sem maiúscula, nome curto com outra grafia, termo atravessando pontuação
  assert.equal(fix("a rosa é bonita, Rosa"), "a rosa é bonita, Rosa");
  assert.equal(fix("Andres disse"), "Andres disse");
  assert.equal(fix("leonarda e Failut, ponto. Domênico disse"), "leonarda e Failut, ponto. Domênico disse");
  assert.equal(fix("Falantes"), "Falantes");
  assert.equal(applyFuzzy("Quitérria", fuzzyTargets("", [])), "Quitérria");
});

test("ícones: conjunto duotone e paleta das tags com emoji para exportação", async () => {
  await import("../src/lib/icons.js");
  const { icon, tagIcon, TAG_ICONS, names } = globalThis.EsIcons;
  const { DEFAULT_TAGS } = await import("../src/lib/settings.js");
  for (const t of DEFAULT_TAGS) assert.equal(tagIcon(t), t.icon);
  // Tag antiga, só com emoji: acha o desenho equivalente (com ou sem o seletor de variação), senão a etiqueta.
  assert.equal(tagIcon({ emoji: "⚠" }), "risco");
  assert.equal(tagIcon({ emoji: "💡" }), "ideia");
  assert.equal(tagIcon({ emoji: "🍕" }), "tag");
  assert.equal(TAG_ICONS.length, 20);
  for (const [n] of TAG_ICONS) assert.ok(names.includes(n), n);
  const svg = icon("decisao", { size: 14 });
  assert.match(svg, /^<svg class="ic" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">/);
  assert.match(svg, /fill-opacity:var\(--ic-fill,\.16\)/);
  assert.equal(icon("nao-existe"), "");
});

// ---------------- 0.9.45: falantes duplicados e nomes técnicos ----------------
import { isJunkName, nameKey, dedupeSpeakers, speakerName as spkName2 } from "../src/lib/transcript.js";
test("falantes: 'keep_…' não vira nome; o mesmo nome em ids diferentes vira um participante só", () => {
  assert.equal(isJunkName("keep_a1b2c3d4"), true);
  assert.equal(isJunkName("spaces/x/devices/9"), true);
  assert.equal(isJunkName("Pedro Henrique"), false);
  assert.equal(isJunkName("Thiago"), false);
  assert.equal(nameKey("Apresentação de Vitor Almeida"), nameKey("vitor almeida"));
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "d1", name: "keep_abc123" });
  assert.equal(s.speakers.d1, undefined);
  applyEvent(s, { kind: "speaker", speakerId: "d1", name: "Igor Peres" });
  applyEvent(s, { kind: "caption", id: "1/d1", speakerId: "d1", text: "primeira" }, 1_001_000);
  // reconexão: id novo, mesmo nome
  applyEvent(s, { kind: "speaker", speakerId: "d2", name: "Igor Peres" });
  applyEvent(s, { kind: "caption", id: "2/d2", speakerId: "d2", text: "segunda" }, 1_010_000);
  assert.deepEqual([...new Set(s.entries.map((e) => e.speakerId))], ["d1"]);
  // sessão antiga com duplicatas e nome técnico
  const old = session();
  old.speakers = { a: "Diego Dantas", b: "Diego Dantas", c: "keep_zz99" };
  applyEvent(old, { kind: "caption", id: "1/a", speakerId: "a", text: "x" }, 1_001_000);
  applyEvent(old, { kind: "caption", id: "2/b", speakerId: "b", text: "y" }, 1_002_000);
  assert.equal(dedupeSpeakers(old), 2);
  assert.deepEqual([...new Set(old.entries.map((e) => e.speakerId))], ["a"]);
  assert.match(spkName2(old, "c"), /^Participante/);
});

// ---------------- 0.9.46: mesma pessoa não vira duas vozes ----------------
import { mergeVoices } from "../src/lib/transcript.js";
function voiceVec(seed, noise, rnd) {
  // 64 dimensões: direção da pessoa (seed) + ruído do turno
  const v = new Float32Array(64);
  for (let i = 0; i < 64; i++) v[i] = Math.sin((i + 1) * seed) + (rnd() - 0.5) * noise;
  return v;
}
function rng(s) { return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }
test("vozes: turno curto e ruidoso no começo não deixa a mesma pessoa com duas vozes", () => {
  const rnd = rng(7);
  const book = new VoiceBook();
  // começo ruim: um turno curto muito ruidoso da pessoa A cria uma voz própria
  const first = book.assign(voiceVec(1.3, 3.5, rnd), 800);
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(book.assign(voiceVec(1.3, 1.2, rnd), 4000));
  for (let i = 0; i < 12; i++) ids.push(book.assign(voiceVec(2.9, 1.2, rnd), 4000));
  assert.equal(book.size, 3, "antes do fim, A ficou com duas vozes (o turno ruidoso e as falas boas)");
  const merges = book.finalize();
  const a = book.resolve(first);
  assert.equal(book.resolve(ids[0]), a, "o turno ruidoso foi absorvido pela voz de A");
  assert.ok(ids.slice(0, 12).every((id) => book.resolve(id) === a));
  assert.ok(ids.slice(12).every((id) => book.resolve(id) !== a), "B continua outra pessoa");
  assert.equal(book.size, 2);
  assert.deepEqual(merges, [{ from: first, to: a }]);
});
test("vozes: duas vozes que convergem viram uma só, e B continua separada", () => {
  const rnd = rng(11);
  const book = new VoiceBook({ same: 0.9 }); // limiar alto: força a criação de vozes duplicadas de A
  for (let i = 0; i < 20; i++) book.assign(voiceVec(1.3, 1.2, rnd), 5000);
  for (let i = 0; i < 10; i++) book.assign(voiceVec(2.9, 1.2, rnd), 5000);
  const before = book.voices.length;
  book.finalize();
  assert.ok(book.size <= 2 && book.size < before + 1, `ficaram ${book.size} vozes (antes ${before})`);
  assert.notEqual(book.resolve(book.assign(voiceVec(1.3, 0.3, rnd), 3000)), book.resolve(book.assign(voiceVec(2.9, 0.3, rnd), 3000)));
});
test("vozes: a junção remapeia falas, votos e o nome dado à mão", () => {
  const s = session();
  s.asr.push({ id: "asr/1/tab", start: 1, end: 2, text: "oi", source: "tab", speakerId: "voz:2", voice: "voz:2" });
  s.asr.push({ id: "asr/3/tab", start: 3, end: 4, text: "tudo", source: "tab", speakerId: "voz:1", voice: "voz:1" });
  s.voices = { "voz:2": { ana: 2 }, "voz:1": { ana: 1 } };
  s.speakers["voz:2"] = "Ana Paula";
  mergeVoices(s, [{ from: "voz:2", to: "voz:1" }]);
  assert.deepEqual(s.asr.map((a) => [a.voice, a.speakerId]), [["voz:1", "voz:1"], ["voz:1", "voz:1"]]);
  assert.deepEqual(s.voices, { "voz:1": { ana: 3 } });
  assert.equal(s.speakers["voz:1"], "Ana Paula");
});
test("falantes: 'manter separados' impede a junção automática por nome", () => {
  const { keepApart } = transcriptMod;
  const s = session();
  s.speakers = { a: "João Silva", b: "João Silva" };
  keepApart(s, "a", "b");
  assert.equal(dedupeSpeakers(s), 0);
  applyEvent(s, { kind: "speaker", speakerId: "c", name: "João Silva" });
  assert.equal(s.merged.c, "a", "um terceiro id com o mesmo nome ainda é juntado");
});
test("localizar e substituir: palavra inteira, um passo de desfazer", () => {
  const { replaceAll, countMatches, undoEdit } = transcriptMod;
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "o quiu quatro e o banana" }, 1_001_000);
  applyEvent(s, { kind: "caption", id: "2/b", speakerId: "b", text: "fechamos o Quiu Quatro" }, 1_060_000);
  assert.equal(countMatches(s, "quiu quatro"), 2);
  assert.equal(countMatches(s, "nana", { wholeWord: true }), 0);
  assert.equal(replaceAll(s, "quiu quatro", "Q4"), 2);
  assert.deepEqual(toBlocks(s).map((b) => b.text), ["o Q4 e o banana", "fechamos o Q4"]);
  assert.equal(s.undo.length, 1);
  undoEdit(s);
  assert.equal(toBlocks(s)[0].text, "o quiu quatro e o banana");
});

// ---------------- 0.9.50: perfis de voz ----------------
import { learnProfiles } from "../src/lib/voiceprofiles.js";
test("perfis de voz: aprende pelo nome, reconhece na reunião seguinte e não junta dois perfis", () => {
  const rnd = rng(3);
  const book = new VoiceBook();
  for (let i = 0; i < 6; i++) book.assign(voiceVec(1.3, 0.8, rnd), 4000);
  for (let i = 0; i < 6; i++) book.assign(voiceVec(2.9, 0.8, rnd), 4000);
  const prints = book.snapshot();
  assert.equal(Object.keys(prints).length, 2);
  // reunião 1: legendas dizem que voz:1 é a Ana; voz:2 ficou "Falante 2" (genérico, não vira perfil)
  const s = session();
  s.speakers = { "dev/ana": "Ana Souza", "voz:2": "Falante 2" };
  s.asr = [{ id: "x1", voice: "voz:1", speakerId: "dev/ana", start: 1, end: 2, text: "a" }, { id: "x2", voice: "voz:2", speakerId: "voz:2", start: 3, end: 4, text: "b" }];
  const profiles = learnProfiles(s, prints, []);
  assert.deepEqual(profiles.map((p) => p.name), ["Ana Souza"]);
  // reunião 2: livro novo, semeado; a voz da Ana é reconhecida com nome
  const book2 = new VoiceBook();
  book2.seed(profiles);
  const id = book2.assign(voiceVec(1.3, 0.8, rnd), 3000);
  assert.equal(book2.nameOf(id), "Ana Souza");
  assert.notEqual(book2.nameOf(book2.assign(voiceVec(2.9, 0.8, rnd), 3000)), "Ana Souza");
  // sem legenda, a fala com o nome do perfil vira a Ana e junta com o participante de mesmo nome
  const s2 = session();
  applyEvent(s2, { kind: "speaker", speakerId: "dev/ana2", name: "Ana Souza" });
  addAsrSegment(s2, { start: 9_000_000, end: 9_003_000, text: "bom dia a todos", source: "tab", voice: id, voiceName: "Ana Souza" });
  assert.equal(transcriptMod.canonicalSpeaker(s2, s2.asr[0].speakerId), "dev/ana2");
  // atualizar o perfil soma as reuniões
  assert.equal(learnProfiles(s, prints, profiles)[0].meetings, 2);
});
test("chat sobre várias reuniões: cada anterior vira material de consulta, cortado para caber", async () => {
  const { chatRequest, previousContext } = await import("../src/lib/ai.js");
  const a = session(); a.title = "Reunião A"; a.summary = { text: "Decidimos o orçamento." };
  const b = session(); b.title = "Reunião B"; applyEvent(b, { kind: "caption", id: "1/x", speakerId: "x", text: "x ".repeat(9000) }, 1_001_000);
  const ctx = previousContext([a, b]);
  assert.equal((ctx.match(/<reuniao_anterior/g) || []).length, 2);
  assert.match(ctx, /Decidimos o orçamento/);
  assert.match(ctx, /trecho cortado/);
  const req = chatRequest(session(), [{ role: "user", text: "e aí?" }], { previous: [a, b] });
  assert.match(req.system, /titulo="Reunião B"/);
  assert.match(req.system, /\[00:12:31\]/);
});

// ---------------- Exportação: partes escolhidas e conversas com a IA ----------------
import { aiConversations } from "../src/lib/format.js";
test("exportação: escolher chat, notas, destaques, capítulos e perguntas à IA", () => {
  const s = session();
  applyEvent(s, { kind: "speaker", speakerId: "a", name: "Ana" });
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "Vamos aprovar o orçamento." }, 1_001_000);
  applyEvent(s, { kind: "chat", id: "c/1", speakerId: "a", text: "link da planilha" }, 1_090_000);
  applyEvent(s, { kind: "caption", id: "2/a", speakerId: "a", text: "Próximo assunto." }, 1_200_000);
  setBlockTags(s, toBlocks(s)[0].ids, ["decisao"]);
  s.notes.text = "Pauta: orçamento";
  s.notes.items.push({ id: "n1", at: 1_100_000, text: "lembrar do prazo" });
  s.chapters = [{ startAt: 1_001_000, title: "Orçamento" }];
  s.chats = [{ id: "x", messages: [
    { role: "user", text: '<reuniao_anterior titulo="A">antes</reuniao_anterior>\n\n# Roteiro\nListe as decisões.' },
    { role: "assistant", text: "- Orçamento aprovado [00:00:01]" },
  ] }];

  // Padrão: como sempre foi (tudo, menos a IA).
  const md = toMarkdown(s);
  assert.match(md, /## Destaques/);
  assert.match(md, /## Notas/);
  assert.match(md, /## Capítulos/);
  assert.match(md, /link da planilha/);
  assert.doesNotMatch(md, /Perguntas à IA/);

  // Só a IA ligada além das falas.
  const only = { chat: false, notes: false, highlights: false, chapters: false, ai: true };
  const md2 = toMarkdown(s, { include: only });
  assert.doesNotMatch(md2, /## Destaques|## Notas|## Capítulos|link da planilha|lembrar do prazo|✅/);
  assert.match(md2, /## Perguntas à IA\n\n### Roteiro\n\n\*\*Pergunta:\*\*\n\n# Roteiro\nListe as decisões\.\n\n\*\*Resposta:\*\*\n\n- Orçamento aprovado/);
  assert.doesNotMatch(md2, /reuniao_anterior|\bantes\b/);
  assert.match(md2, /Vamos aprovar o orçamento/);

  const txt = toText(s, { include: only });
  assert.match(txt, /=== Perguntas à IA ===\n\nPergunta: # Roteiro\nListe as decisões\.\n\nResposta:\n- Orçamento aprovado/);
  assert.doesNotMatch(txt, /lembrar do prazo|link da planilha|--- 1\. Orçamento ---/);

  const html = toHtml(s, { include: only });
  assert.match(html, /<h2>Perguntas à IA<\/h2>\s*<h3>Roteiro<\/h3>/);
  assert.doesNotMatch(html, /<h2>(Destaques|Notas|Capítulos)<\/h2>/);
  assert.match(toHtml(s), /<h2>Capítulos<\/h2>/);

  assert.deepEqual(aiConversations(s)[0].pairs, [{ q: "# Roteiro\nListe as decisões.", a: "- Orçamento aprovado [00:00:01]" }]);
});

// ---------------- Perguntas longas e material de apoio ----------------
import { chatRequest as chatReq, supportBlocks, chatModel, questionCredits as qCredits } from "../src/lib/ai.js";
test("chat: material de apoio entra antes da primeira pergunta; pergunta pesada raciocina mais", () => {
  const s = session();
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "abriu em alta" }, 1_001_000);
  const support = [{ kind: "text", name: "cotações", text: "09:00 WIN 130000" }, { kind: "image", name: "grafico.png", mime: "image/png", data: "iVBORw0KGgo=" }, { kind: "image", name: "x.bmp", mime: "image/bmp", data: "AAAA" }];
  const hist = [{ role: "user", text: "Como abriu?" }, { role: "assistant", text: "Em alta." }, { role: "user", text: "E depois?" }];
  const r = chatReq(s, hist, { support });
  assert.equal(r.effort, "medium");
  assert.equal(r.heavy, true);
  const c = r.messages[0].content;
  assert.match(c[0].text, /<material_de_apoio nome="cotações">\n09:00 WIN 130000/);
  assert.equal(c[2].type, "image");
  assert.deepEqual(c[2].cache_control, { type: "ephemeral" }, "material fica no cache");
  assert.equal(c.length, 4, "bmp não entra");
  assert.equal(c.at(-1).text, "Como abriu?");
  assert.equal(r.messages[2].content, "E depois?");
  assert.match(r.system, /nunca peça permissão para continuar/);
  assert.match(r.system, /material de apoio/);

  const curta = chatReq(s, [{ role: "user", text: "Quem falou?" }]);
  assert.equal(curta.effort, "low");
  assert.doesNotMatch(curta.system, /<material_de_apoio>|material de apoio \(dentro/);
  assert.equal(chatReq(s, [{ role: "user", text: "x".repeat(2500) }]).effort, "medium");

  assert.equal(supportBlocks([]).length, 0);
  assert.equal(qCredits("Oi"), 1);
  assert.equal(qCredits("Oi", { support: true }), 2);
  // modelo da chave própria: sobe para o de perguntas longas, nunca desce
  assert.equal(chatModel({ aiModel: "claude-haiku-5-5" }, true), "claude-sonnet-5-5");
  assert.equal(chatModel({ aiModel: "claude-haiku-5-5" }, false), "claude-haiku-5-5");
  assert.equal(chatModel({ aiModel: "claude-opus-5-5", aiModelLong: "claude-sonnet-5-5" }, true), "claude-opus-5-5");
  assert.equal(chatModel({ aiModel: "claude-haiku-5-5", aiModelLong: "same" }, true), "claude-haiku-5-5");
});

// ---------------- Capturas para a IA, pesquisa na web e continuação após pause_turn ----------------
import { streamClaude, EmptyAnswer, sampleShots, withSources, webSearchTool } from "../src/lib/ai.js";
test("chat: capturas espaçadas, pesquisa na web e fontes", () => {
  const shots = Array.from({ length: 50 }, (_, i) => ({ id: String(i), at: i }));
  const pick = sampleShots(shots, 20);
  assert.equal(pick.length, 20);
  assert.equal(pick[0].id, "0");
  assert.equal(pick.at(-1).id, "49");
  assert.equal(webSearchTool("claude-sonnet-5-5").type, "web_search_20260209");
  assert.equal(webSearchTool("claude-haiku-5-5").type, "web_search_20250305");
  assert.equal(withSources("Resposta.", []), "Resposta.");
  assert.equal(withSources("Resposta.", [{ url: "https://a.com", title: "A" }, { url: "https://a.com", title: "A" }]), "Resposta.\n\n**Fontes da web:**\n- A — https://a.com");
  const s = session();
  applyEvent(s, { kind: "caption", id: "1/a", speakerId: "a", text: "oi" }, 1_001_000);
  const r = chatReq(s, [{ role: "user", text: "Como estava o mercado?" }], { web: true, model: "claude-sonnet-5-5", support: [{ kind: "shot", at: "00:01:00", mime: "image/jpeg", data: "/9j/" }] });
  assert.equal(r.heavy, true);
  assert.equal(r.tools[0].name, "web_search");
  assert.match(r.system, /pesquisar na web/);
  assert.match(r.system, /captura_de_tela/);
  assert.doesNotMatch(r.system, /material de apoio \(dentro/, "capturas não contam como material de apoio");
  assert.match(r.messages[0].content[0].text, /<captura_de_tela horario="00:01:00">/);
});

test("streamClaude: continua após pause_turn, devolve blocos de pensamento intactos e junta as fontes", async () => {
  const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
  const bodies = [];
  const responses = [
    sse([
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "vou buscar" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig1" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"IPCA outubro"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" } },
    ]),
    sse([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "IPCA acima." } },
      { type: "content_block_delta", index: 0, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://ibge.gov.br/ipca", title: "IBGE" } } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ]),
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async (_url, init) => (bodies.push(JSON.parse(init.body)), responses.shift());
  try {
    const seen = [];
    const r = await streamClaude({ apiKey: "k", model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "IPCA?" }], tools: [webSearchTool("claude-sonnet-5-5")], onDelta: (t) => seen.push(t) });
    assert.equal(r.text, "IPCA acima.");
    assert.deepEqual(r.sources, [{ url: "https://ibge.gov.br/ipca", title: "IBGE" }]);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].tools[0].type, "web_search_20260209");
    const replay = bodies[1].messages.at(-1);
    assert.equal(replay.role, "assistant");
    assert.deepEqual(replay.content[0], { type: "thinking", thinking: "vou buscar", signature: "sig1" });
    assert.deepEqual(replay.content[1].input, { query: "IPCA outubro" });
    assert.equal(seen.at(-1), "IPCA acima.");
  } finally {
    globalThis.fetch = real;
  }
});

test("streamClaude: só raciocínio até o limite de tokens vira erro claro, não 'vazia' genérico", async () => {
  const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
  const real = globalThis.fetch;
  globalThis.fetch = async () => sse([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pensando muito" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" } },
  ]);
  try {
    await assert.rejects(streamClaude({ apiKey: "k", model: "claude-opus-5-5", system: "s", messages: [{ role: "user", content: "x" }] }), /limite de tokens raciocinando/);
  } finally {
    globalThis.fetch = real;
  }
});

test("streamClaude: resposta cortada pelo limite de tokens pede continuação e emenda; esgotadas, avisa o corte", async () => {
  const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
  const part = (t, stop) => sse([
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop } },
  ]);
  const real = globalThis.fetch;
  const bodies = [];
  let queue = [part("1. Diário. Havia um **v", "max_tokens"), part("azio** de preço.", "end_turn")];
  globalThis.fetch = async (_u, init) => (bodies.push(JSON.parse(init.body)), queue.shift());
  try {
    const r = await streamClaude({ apiKey: "k", model: "m", system: "s", messages: [{ role: "user", content: "análise" }] });
    assert.equal(r.text, "1. Diário. Havia um **vazio** de preço.");
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1].messages.slice(1).map((m) => m.role), ["assistant", "user"]);
    assert.equal(bodies[1].messages[1].content, "1. Diário. Havia um **v");
    assert.match(bodies[1].messages[2].content, /Continue exatamente/);
    queue = [part("a", "max_tokens"), part("b", "max_tokens"), part("c", "max_tokens")];
    const cut = await streamClaude({ apiKey: "k", model: "m", system: "s", messages: [{ role: "user", content: "x" }] });
    assert.ok(cut.text.startsWith("abc"));
    assert.match(cut.text, /cortada pelo limite de tamanho/);
  } finally {
    globalThis.fetch = real;
  }
});

test("streamClaude: aproveita texto que vem inteiro no content_block_start, SSE com \\r\\n e resposta JSON comum", async () => {
  const real = globalThis.fetch;
  const body = (txt) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(txt)); c.close(); } }), { status: 200 });
  const ev = (e, nl = "\n") => `event: ${e.type}${nl}data: ${JSON.stringify(e)}${nl}${nl}`;
  const cases = [
    [ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: '{"chapters":[]}' } }) + ev({ type: "content_block_stop", index: 0 }) + ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }), '{"chapters":[]}'],
    [ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "\r\n") + ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "oi" } }, "\r\n") + ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }, "\r\n"), "oi"],
    [JSON.stringify({ content: [{ type: "text", text: "json comum" }], stop_reason: "end_turn" }), "json comum"],
  ];
  try {
    for (const [raw, want] of cases) {
      globalThis.fetch = async () => body(raw);
      const r = await streamClaude({ apiKey: "k", model: "claude-opus-5-5", system: "s", messages: [{ role: "user", content: "x" }] });
      assert.equal(r.text, want);
    }
    globalThis.fetch = async () => body(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) + ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }));
    await assert.rejects(streamClaude({ apiKey: "k", model: "claude-opus-5-5", system: "s", messages: [{ role: "user", content: "x" }] }), (e) => e instanceof EmptyAnswer && /motivo: end_turn; blocos: thinking; eventos: 2/.test(e.message));
  } finally {
    globalThis.fetch = real;
  }
});

test("streamClaude: sem onDelta (capítulos, revisão) o texto ainda é montado", async () => {
  const real = globalThis.fetch;
  const ev = (e) => `data: ${JSON.stringify(e)}\n\n`;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"chapters":' } }) + ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[]}" } }) + ev({ type: "message_delta", delta: { stop_reason: "end_turn" } }))); c.close(); } }), { status: 200 });
  try {
    const r = await streamClaude({ apiKey: "k", model: "claude-opus-5-5", system: "s", messages: [{ role: "user", content: "x" }] });
    assert.equal(r.text, '{"chapters":[]}');
  } finally {
    globalThis.fetch = real;
  }
});

test("streamClaude: avisa as etapas (analisando, pesquisando, escrevendo) e desiste após o tempo sem dados", async () => {
  const { phaseOf } = await import("../src/lib/ai.js");
  assert.equal(phaseOf({ type: "thinking" }), "Analisando…");
  assert.equal(phaseOf({ type: "server_tool_use", name: "web_search" }), "Pesquisando na web…");
  assert.equal(phaseOf({ type: "tool_use" }), null);
  const real = globalThis.fetch;
  const ev = (e) => `data: ${JSON.stringify(e)}\n\n`;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) + ev({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "s", name: "web_search", input: {} } }) + ev({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }) + ev({ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "ok" } }) + ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })));
      c.close();
    } }), { status: 200 });
    const phases = [];
    const r = await streamClaude({ apiKey: "k", model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "x" }], onPhase: (p) => phases.push(p) });
    assert.equal(r.text, "ok");
    assert.deepEqual(phases, ["Analisando…", "Pesquisando na web…", "Escrevendo…"]);
    // Conexão que para de mandar dados: erro claro em vez de esperar para sempre.
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }))); } }), { status: 200 });
    await assert.rejects(streamClaude({ apiKey: "k", model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "x" }], idleMs: 150 }), /parou de responder/);
  } finally {
    globalThis.fetch = real;
  }
});

test("arquivos da IA: blocos de código viram downloads e .zip válido", async () => {
  const { codeFiles, mdToHtml, zipFiles } = await import("../src/lib/format.js");
  const md = "Pacote:\n```mql5 JA_Delta.mqh\nint x = 1 < 2;\n```\n```ntsl profit/../Robo.ntsl\nvar a;\n```\n```\nsolto\n```\n```mql5 JA_Delta.mqh\ndup\n```";
  const files = codeFiles(md);
  assert.deepEqual(files.map((f) => f.name), ["JA_Delta.mqh", "profit/Robo.ntsl", "trecho-3.txt", "JA_Delta-2.mqh"]);
  assert.equal(files[0].text, "int x = 1 < 2;\n");
  const html = mdToHtml(md, { files: true });
  assert.match(html, /<pre><code>int x = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /data-file="3"/);
  assert.doesNotMatch(mdToHtml(md), /data-file/);
  const bytes = new Uint8Array(await zipFiles(files).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.deepEqual([...bytes.slice(-22, -18)], [0x50, 0x4b, 0x05, 0x06]);
  assert.equal(bytes[bytes.length - 22 + 10], 4);
});

test("chat avisa a IA que ela não cria nem anexa arquivos", async () => {
  const { chatRequest } = await import("../src/lib/ai.js");
  const s = createSession({ platform: "meet", title: "R" });
  const r = chatRequest(s, [{ role: "user", text: "gere um zip" }]);
  assert.match(r.system, /não cria, salva, anexa/);
  assert.match(r.system, /nunca invente caminhos ou links/);
});

test("streamClaude: se cair depois de já ter texto (ex.: na continuação), devolve o parcial com o motivo", async () => {
  const sse = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
  const real = globalThis.fetch;
  let queue = [
    sse([{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "```mql5 A.mq5\nint a;" } }, { type: "message_delta", delta: { stop_reason: "max_tokens" } }]),
    new Response(JSON.stringify({ error: { message: "prompt is too long" } }), { status: 400 }),
  ];
  globalThis.fetch = async () => queue.shift();
  try {
    const seen = [];
    const r = await streamClaude({ apiKey: "k", model: "m", system: "s", messages: [{ role: "user", content: "x" }], onDelta: (t) => seen.push(t) });
    assert.ok(r.text.startsWith("```mql5 A.mq5\nint a;"));
    assert.match(r.text, /parou antes do fim \(Erro 400: prompt is too long\)/);
    assert.equal(r.stopReason, "error");
    assert.equal(seen.at(-1), r.text);
    // Sem texto nenhum, o erro continua subindo.
    queue = [new Response(JSON.stringify({ error: { message: "ruim" } }), { status: 400 })];
    await assert.rejects(streamClaude({ apiKey: "k", model: "m", system: "s", messages: [{ role: "user", content: "x" }] }), /ruim/);
  } finally {
    globalThis.fetch = real;
  }
});

test("reamostragem em fluxo: 44,1 kHz e 48 kHz viram 16 kHz sem mudar a frequência nem a duração", async () => {
  const { Resampler, OUT_RATE } = await import("../src/asr/decode.js");
  for (const rate of [44100, 48000, 22050]) {
    const rs = new Resampler(rate);
    const sec = 5, f = 1000;
    const parts = [];
    // entra em pedaços de tamanhos irregulares, como sai do decodificador
    for (let i = 0, n = 0; n < rate * sec; i++) {
      const len = Math.min(rate * sec - n, 997 + (i % 7) * 311);
      const x = new Float32Array(len);
      for (let k = 0; k < len; k++) x[k] = 0.5 * Math.sin((2 * Math.PI * f * (n + k)) / rate);
      parts.push(rs.push(x));
      n += len;
    }
    parts.push(rs.flush());
    const out = Float32Array.from(parts.flatMap((p) => [...p]));
    assert.ok(Math.abs(out.length - OUT_RATE * sec) < 40, `${rate}: ${out.length} amostras`);
    let cross = 0;
    for (let i = 1; i < OUT_RATE * sec - 20; i++) if ((out[i] >= 0) !== (out[i - 1] >= 0)) cross++;
    assert.ok(Math.abs(cross / 2 / sec - f) < 3, `${rate}: ${cross / 2 / sec} Hz`);
    const mid = out.subarray(OUT_RATE, OUT_RATE * 4);
    const rms = Math.sqrt(mid.reduce((s, v) => s + v * v, 0) / mid.length);
    assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.02, `${rate}: volume ${rms}`);
  }
});

test("página da web (Transcrever esta aba): o som da aba vira o falante do site, sem depender de legendas", () => {
  const s = createSession({ id: "w1", platform: "web", title: "Aula", startedAt: 1_000_000 });
  s.web = true;
  s.speakers.outros = "YouTube";
  // há uma legenda solta de outra pessoa no mesmo horário: numa página da web ela não manda no falante
  applyEvent(s, { kind: "caption", id: "c1", speakerId: "ana", speakerName: "Ana", text: "oi" }, 1_001_000);
  addAsrSegment(s, { start: 1_000_500, end: 1_003_000, text: "Hoje vamos falar de geografia.", source: "tab" });
  assert.equal(s.asr.length, 1);
  assert.equal(s.asr[0].speakerId, "outros");
  assert.equal(speakerName(s, "outros"), "YouTube");
});

test("servidor: fala inventada em silêncio cai, fala real fica e o fim é cortado no pedaço", async () => {
  const { keepServerSegment } = await import("../src/asr/segmenter.js");
  const sr = 16000, samples = new Float32Array(sr * 12); // 12 s: silêncio até 5 s, voz (tom) de 5 a 9 s
  for (let i = 5 * sr; i < 9 * sr; i++) samples[i] = 0.1 * Math.sin(i * 0.17);
  const off = 600_000;
  assert.equal(keepServerSegment(samples, off, { start: off, end: off + 29_980, text: "Thank you." }).text, "Thank you."); // trecho inclui voz forte (0,07): fica
  assert.equal(keepServerSegment(samples, off, { start: off, end: off + 4000, text: "Bom dia a todos." }), null); // silêncio
  assert.equal(keepServerSegment(samples, off, { start: off, end: off + 4000, text: "Thank you." }), null); // silêncio
  assert.deepEqual(keepServerSegment(samples, off, { start: off + 5000, end: off + 29_980, text: " Bom dia a todos. " }), { start: off + 5000, end: off + 12_000, text: "Bom dia a todos." });
  assert.equal(keepServerSegment(samples, off, { start: off + 5000, end: off + 9000, text: "Legendas pela comunidade Amara.org" }), null);
  assert.equal(keepServerSegment(samples, off, { start: off + 13_000, end: off + 14_000, text: "Fora do pedaço" }), null);
});

test("link colado: completa https://, recusa vazio e outros esquemas", async () => {
  const { normalizeLink } = await import("../src/lib/format.js");
  assert.equal(normalizeLink(" youtu.be/abc "), "https://youtu.be/abc");
  assert.equal(normalizeLink("https://www.instagram.com/reel/x/"), "https://www.instagram.com/reel/x/");
  assert.throws(() => normalizeLink(""), /Cole o link/);
  assert.throws(() => normalizeLink("ftp://exemplo.com/a.mp3"), /http/);
  assert.throws(() => normalizeLink("javascript:alert(1)"));
});

test("conta: o teste grátis do Pro para de valer no fim do prazo, mesmo sem consultar o servidor", async () => {
  const { accountIsPro } = await import("../src/lib/account.js");
  const base = { token: "t", plan: "pro" };
  assert.equal(accountIsPro(base), true);
  assert.equal(accountIsPro({ ...base, trialEndsAt: new Date(Date.now() + 3600_000).toISOString() }), true);
  assert.equal(accountIsPro({ ...base, trialEndsAt: new Date(Date.now() - 1000).toISOString() }), false);
  assert.equal(accountIsPro({ ...base, invalid: true }), false);
  assert.equal(accountIsPro({ plan: "pro" }), false);
  assert.equal(accountIsPro(null), false);
});

test("loopStart: reel que recomeça é cortado na segunda volta; aula longa e frase repetida não", async () => {
  const { loopStart } = await import("../src/lib/transcript.js");
  const seg = (texts) => texts.map((text, i) => ({ text, start: i * 4000, end: i * 4000 + 3500 }));
  const volta1 = [
    "O Banco Central manteve a Selic em dez e meio por cento nesta quarta.",
    "A decisão foi unânime e o comunicado veio mais duro do que o mercado esperava.",
    "Para os analistas, o recado é que os juros não caem antes do segundo semestre.",
    "E isso pesa no crédito, no consumo e na bolsa.",
  ];
  // segunda volta: cortes diferentes e pequenas diferenças do Whisper
  const volta2 = [
    "O Banco Central manteve a Selic em 10,5% nesta quarta. A decisão foi unânime",
    "e o comunicado veio mais duro do que o mercado esperava. Para os analistas,",
  ];
  const asr = seg([...volta1, ...volta2]);
  assert.equal(loopStart(asr), 4, "corta na primeira fala da segunda volta");
  assert.equal(loopStart(seg(volta1)), -1, "uma volta só: nada a cortar");
  assert.equal(loopStart(seg([...volta1, volta2[0]])), -1, "poucas palavras repetidas ainda não bastam");

  const aula = seg([
    "Hoje vamos falar de política monetária e de como os juros afetam a inflação.",
    "Quando o Banco Central sobe a Selic, o crédito fica mais caro e a demanda desacelera.",
    "Lembrem que o efeito não é imediato: leva de seis a nove meses para aparecer nos preços.",
    "Repetindo o ponto principal: quando o Banco Central sobe a Selic, o crédito fica mais caro.",
    "Agora vamos ver a curva de juros futuros e como o mercado precifica as próximas reuniões.",
    "O DI de janeiro mostra a expectativa para a Selic no fim do ano que vem.",
  ]);
  assert.equal(loopStart(aula), -1, "frase repetida no meio da aula não é loop");
  assert.equal(loopStart([]), -1);
});

test("slides: parseDeck valida a resposta da IA e o .pptx traz slides, notas e a captura", async () => {
  const { parseDeck, deckToPptx, slidesRequest, imageSize, deckPrintHtml, cleanDeck } = await import("../src/lib/slides.js");
  const t0 = Date.UTC(2026, 10, 10, 14);
  const entries = Array.from({ length: 6 }, (_, i) => ({ id: "e" + i, kind: "caption", speakerId: i % 2 ? "b" : "a", text: `Fala ${i} sobre o lançamento & <metas> do trimestre.`, at: t0 + i * 60_000, updatedAt: t0 + i * 60_000 + 3000 }));
  const session = { id: "m", title: "Plano <Q1>", startedAt: t0, endedAt: t0 + 6 * 60_000, speakers: { a: "Ana", b: "Bruno" }, entries };
  const s = (o) => ({ layout: "topicos", title: "", bullets: [], stats: [], quote: "", speaker: "", notes: "", at: "00:00", shot: "", ...o });
  const ai = JSON.stringify({ title: "Plano Q1", subtitle: "Resumo", slides: [
    s({ layout: "topicos", title: "Metas & prazos", bullets: ["Meta <alta>", "  "], notes: "Linha 1\nLinha 2", at: "00:02:10" }),
    s({ layout: "imagem", title: "Painel", bullets: ["Gráfico"], shot: "sh1", at: "03:00" }),
    s({ layout: "imagem", title: "Mesma captura de novo", shot: "sh1" }),
    s({ layout: "citacao", quote: "", title: "Sem citação" }),
    s({ layout: "inventado", title: "Layout desconhecido", bullets: ["x"] }),
  ] });
  const deck = parseDeck("Aqui está:\n" + ai + "\nfim", session, { style: "nao-existe", palette: "roxo", mode: "escuro" }, ["sh1"]);
  assert.deepEqual(deck.slides.map((x) => x.layout), ["capa", "topicos", "imagem", "topicos", "topicos", "topicos"], "capa no início; captura repetida, citação vazia e layout desconhecido viram tópicos");
  assert.deepEqual([deck.style, deck.palette, deck.mode], ["moderno", "roxo", "escuro"]);
  assert.equal(deck.slides[1].at, t0 + 120_000, "horário colado no início da fala mais próxima");
  assert.deepEqual(deck.slides[1].bullets, ["Meta <alta>"]);
  assert.equal(deck.slides[3].shot, "", "a mesma captura não entra duas vezes");
  assert.equal(parseDeck("sem json", session), null);
  assert.equal(cleanDeck({ slides: [] }), null);

  const req = slidesRequest(session, { kind: "status", size: "longo", instructions: "Foque nos prazos" }, [{ id: "sh1", at: "00:03:00", mime: "image/png", data: "AAAA" }]);
  assert.match(req.system, /Status de projeto/);
  assert.match(req.system, /de 13 a 18 slides/);
  assert.match(req.system, /Foque nos prazos/);
  assert.match(req.messages[0].content[0].text, /\[00:01:00\] Bruno: Fala 1/);
  assert.equal(req.messages[0].content.filter((c) => c.type === "image").length, 1);

  // PNG 3×2 de verdade
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGP4z8DAwMDAxAADAB0EAf8uBWiNAAAAAElFTkSuQmCC", "base64"));
  assert.deepEqual(imageSize(png), { w: 3, h: 2, ext: "png" });
  const blob = deckToPptx(deck, session, { sh1: "data:image/png;base64," + Buffer.from(png).toString("base64") });
  const bytes = Buffer.from(await blob.arrayBuffer());
  const names = [];
  for (let i = 0; i + 30 < bytes.length && bytes.readUInt32LE(i) === 0x04034b50; ) {
    const size = bytes.readUInt32LE(i + 18), nlen = bytes.readUInt16LE(i + 26);
    const name = bytes.subarray(i + 30, i + 30 + nlen).toString();
    names.push([name, bytes.subarray(i + 30 + nlen, i + 30 + nlen + size)]);
    i += 30 + nlen + size;
  }
  const files = Object.fromEntries(names);
  assert.equal(names[0][0], "[Content_Types].xml");
  for (let i = 1; i <= 6; i++) { assert.ok(files[`ppt/slides/slide${i}.xml`]); assert.ok(files[`ppt/notesSlides/notesSlide${i}.xml`]); }
  assert.ok(files["ppt/media/image1.png"], "a captura vai para o .pptx");
  assert.match(files["ppt/slides/_rels/slide3.xml.rels"].toString(), /media\/image1\.png/);
  const s2 = files["ppt/slides/slide2.xml"].toString();
  assert.match(s2, /Metas &amp; prazos/);
  assert.match(s2, /Meta &lt;alta&gt;/);
  assert.doesNotMatch(s2, /<alta>/);
  assert.match(files["ppt/notesSlides/notesSlide2.xml"].toString(), /Linha 2.*Momento na reunião: 02:00/s);
  assert.match(files["[Content_Types].xml"].toString(), /Extension="png"/);
  const html = deckPrintHtml(deck, session, {});
  assert.match(html, /Plano &lt;Q1&gt;/);
  assert.doesNotMatch(html, /<Q1>/);
});
