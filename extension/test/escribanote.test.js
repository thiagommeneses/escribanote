import { test } from "node:test";
import assert from "node:assert/strict";

import "../src/main/core.js";
import "../src/main/proto.js";
import "../src/main/meet.js";
import "../src/main/teams.js";
import "../src/main/zoom.js";
import { createSession, applyEvent, toBlocks } from "../src/lib/transcript.js";
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
