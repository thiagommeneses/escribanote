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
  assert.match(fileName(s, "md"), /_planejamento-q4\.md$/);
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
