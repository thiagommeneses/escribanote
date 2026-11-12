// Capturas do site (site/img/app-*.webp): fotografa a extensão real (Chromium headless + CDP) com reuniões
// fictícias que mostram os recursos atuais: pastas e fixadas, capítulos, material de apoio, captura de slide,
// pesquisa na web com fontes, ata, análise, temas Papel e Editor e o menu do botão direito.
//   CHROME=/caminho/chrome node marketing/capturas-site.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME."); process.exit(2); }
const EXT = resolve(import.meta.dirname, "../extension");
const OUT = resolve(import.meta.dirname, "../site/img");
const W = 1400, H = 757, DSF = 2;

// ---------- reuniões fictícias ----------
const t0 = new Date(); t0.setHours(14, 2, 0, 0);
const T = t0.getTime();
const MIN = 60000, DAY = 24 * 3600000;
const SP = { a: "Ana Teixeira", b: "Bruno Lima", p: "Paula Franco", me: "Thiago" };
const ids = { a: "spaces/x/devices/101", b: "spaces/x/devices/102", p: "spaces/x/devices/103", me: "spaces/x/devices/104" };
const falas = [
  ["a", 0.5, "Bom, vamos revisar o orçamento do Q4. A proposta é fechar hoje."],
  ["b", 1.4, "Eu olhei os números ontem. A mídia ficou em 180 mil, dentro do que a gente combinou."],
  ["p", 2.6, "O cronograma eu consigo mandar até sexta, com as entregas por semana."],
  ["me", 3.5, "Perfeito. Então quem fica com a frente de mídia?"],
  ["a", 4.1, "Eu assumo a mídia. O Bruno fica com o financeiro e a aprovação da verba."],
  ["b", 5.0, "Combinado. Confirmo com o financeiro ainda hoje e aviso no canal."],
  ["p", 12.2, "Agora o fornecedor: a proposta da agência nova entra no segundo mês, não no primeiro."],
  ["a", 13.0, "Certo, ajusto a previsão. O slide mostra o custo por mês, dá para ver o pico em dezembro."],
  ["b", 21.6, "Sobre a aprovação: eu aprovo a mídia de 180 mil, com revisão em dezembro."],
  ["me", 22.3, "Aprovado. Fechamos o orçamento do Q4 hoje, obrigado pessoal."],
  ["p", 23.0, "Mando o cronograma até sexta e a ata vai pro canal do projeto."],
];
const entries = falas.map(([w, min, text], i) => ({ id: `e${i + 1}`, kind: "caption", speakerId: ids[w], text, version: 1, at: T + min * MIN, updatedAt: T + min * MIN + 4000, source: "protocol" }));
entries.splice(4, 0, { id: "c1", kind: "chat", speakerId: ids.p, text: "Vou colocar o cronograma no drive do projeto 👍", version: 1, at: T + 3.8 * MIN, updatedAt: T + 3.8 * MIN, source: "protocol" });
const resposta = `Comparando a fala com o material anexado:

1. **Mídia de R$ 180 mil** bate com a planilha orcamento-q4.csv (linha "Mídia digital", R$ 180.000), aprovada pelo Bruno às 00:21.
2. **Pico em dezembro**: o slide capturado às 00:13 mostra R$ 74 mil no mês, 41% do total. A planilha confirma.
3. **Agência nova no 2º mês**: a proposta em PDF prevê início em novembro; a Paula pediu dezembro (00:12). Vale ajustar o contrato.

No mercado, o custo de mídia digital subiu em média 9% no último trimestre, então a revisão em dezembro combinada pelo Bruno faz sentido.

**Fontes da web:**
- Kantar IBOPE Media — Investimento publicitário 3º tri 2026 — https://www.kantaribopemedia.com.br/
- Meio & Mensagem — Inflação de mídia digital — https://www.meioemensagem.com.br/`;
const sessao = {
  id: "demo-q4", platform: "meet", meetingKey: "meet:abc-defg-hij", url: "https://meet.google.com/abc-defg-hij", title: "Planejamento do Q4",
  startedAt: T, updatedAt: T + 42 * MIN, endedAt: T + 42 * MIN, pinnedAt: T + 50 * MIN,
  speakers: { [ids.a]: SP.a, [ids.b]: SP.b, [ids.p]: SP.p, [ids.me]: SP.me },
  entries,
  highlights: { e10: ["decisao"], e3: ["acao"] },
  notes: { text: "", items: [{ id: "n1", at: T + 4.5 * MIN, text: "Confirmar verba extra com o financeiro" }] },
  shots: [{ id: "s1", at: T + 13.1 * MIN, area: "shared" }],
  chapters: [
    { title: "Orçamento e responsáveis", startAt: T + 0.5 * MIN },
    { title: "Fornecedor e cronograma", startAt: T + 12.2 * MIN },
    { title: "Aprovação da verba", startAt: T + 21.6 * MIN },
  ],
  chaptersBy: "claude-sonnet-5-5",
  support: [
    { id: "m1", kind: "text", name: "orcamento-q4.csv", mime: "text/csv", size: 18432, at: T + 44 * MIN },
    { id: "m2", kind: "pdf", name: "proposta-agencia.pdf", mime: "application/pdf", size: 412000, at: T + 44 * MIN },
  ],
  aiOptions: { shots: true, web: true },
  chats: [
    { id: "ch1", createdAt: T + 50 * MIN, messages: [
      { role: "user", text: "Compare o que foi aprovado com a planilha e a proposta anexadas. Algo destoa do mercado?", at: T + 50 * MIN },
      { role: "assistant", text: resposta, at: T + 51 * MIN },
    ] },
  ],
  summary: { text: "## Resumo\nReunião de 42 minutos para fechar o orçamento do Q4. A verba de mídia foi aprovada e os responsáveis por cada frente ficaram definidos.\n\n## Decisões\n- Mídia aprovada: **R$ 180 mil**, com revisão em dezembro (Bruno, 00:21)\n- Ana assume a frente de mídia; Bruno, o financeiro (00:04)\n- Orçamento do Q4 fechado hoje (Thiago, 00:22)\n\n## Itens de ação\n- [ ] **Paula** envia o cronograma até sexta\n- [ ] **Bruno** confirma a verba com o financeiro hoje\n- [ ] **Ana** ajusta a previsão: agência nova entra no segundo mês\n\n## Pendências\n- Contrato da agência prevê início em novembro; confirmar dezembro", createdAt: T + 43 * MIN },
};
const outras = [
  { id: "demo-mercado", title: "Sala de mercado — abertura", platform: "meet", startedAt: T - 5 * 3600000, endedAt: T - 5 * 3600000 + 95 * MIN, participants: ["Vitor Almeida", "Thiago", "Carla Souza"], count: 412, highlights: 6, hasSummary: true, folderId: "f-mercado" },
  { id: "demo-cliente", title: "Alinhamento com o cliente", platform: "zoom", startedAt: T - 3 * DAY, endedAt: T - 3 * DAY + 50 * MIN, participants: ["Paula Franco", "Thiago"], count: 132, highlights: 5, hasSummary: true, folderId: "f-clientes" },
  { id: "demo-kickoff", title: "Kickoff — Construtora Alfa", platform: "teams", startedAt: T - 6 * DAY, endedAt: T - 6 * DAY + 64 * MIN, participants: ["Rafael Dias", "Paula Franco", "Thiago"], count: 205, highlights: 2, folderId: "f-clientes" },
  { id: "demo-retro", title: "Retrospectiva da sprint 18", platform: "teams", startedAt: T - DAY, endedAt: T - DAY + 35 * MIN, participants: ["Ana Teixeira", "Bruno Lima", "Thiago"], count: 84, highlights: 3 },
  { id: "demo-video", title: "Copom: o que muda nos juros — entrevista", platform: "youtube", startedAt: T - 2.5 * 3600000, endedAt: T - 2.5 * 3600000 + 38 * MIN, participants: [], count: 96, highlights: 1, hasSummary: true },
  { id: "demo-huddle", title: "Huddle em #projeto-q4", platform: "slack", startedAt: T - 2 * DAY, endedAt: T - 2 * DAY + 12 * MIN, participants: ["Bruno Lima", "Thiago"], count: 31, highlights: 0 },
];
const T2 = T - 26 * 60 * MIN; // ontem à tarde
const aulaFalas = [
  "Bom dia, turma. Hoje a gente fecha o módulo de política monetária com a relação entre juros e inflação.",
  "Quando o Banco Central sobe a Selic, o crédito fica mais caro e a demanda desacelera.",
  "O efeito na inflação não é imediato: leva de seis a nove meses para aparecer nos preços.",
  "Por isso o Copom olha as expectativas do Focus, e não só o IPCA do mês.",
  "Anotem: juro real é a Selic menos a inflação esperada para os próximos doze meses.",
  "Com Selic de 10,5% e expectativa de 4%, o juro real fica perto de 6,3%, bem acima do neutro.",
  "Na próxima parte a gente vê como isso aparece na curva de juros futuros, o DI.",
];
const aula = {
  id: "demo-aula", platform: "import", title: "Aula de macroeconomia — juros e inflação", startedAt: T2, updatedAt: T2 + 52 * MIN, endedAt: T2 + 120 * MIN,
  speakers: { outros: "Profª Helena Prado" }, entries: [],
  asr: aulaFalas.map((text, i) => ({ id: `asr/${T2 + i * 7 * MIN}/import`, start: T2 + i * 7 * MIN + 20000, end: T2 + i * 7 * MIN + 31000, text, source: "import", speakerId: "outros" })),
  audio: { startedAt: T2, durationMs: 120 * MIN, model: "auto", file: "aula-macro-modulo3.mp3" },
  highlights: { [`asr/${T2 + 4 * 7 * MIN}/import`]: ["importante"] }, notes: { text: "", items: [] }, shots: [], import: true,
};
const index = [
  { id: sessao.id, title: sessao.title, platform: "meet", startedAt: T, updatedAt: sessao.updatedAt, endedAt: sessao.endedAt, count: entries.length, participants: Object.values(SP), highlights: 2, hasSummary: true, meetingKey: sessao.meetingKey, pinnedAt: sessao.pinnedAt },
  ...outras.map((o) => ({ ...o, updatedAt: o.endedAt })),
  { id: aula.id, title: aula.title, platform: "import", startedAt: T2, updatedAt: aula.updatedAt, endedAt: aula.endedAt, count: aula.asr.length, participants: [], highlights: 1, folderId: "f-mercado" },
];
const folders = [{ id: "f-clientes", name: "Clientes", collapsed: false }, { id: "f-mercado", name: "Mercado financeiro", collapsed: false }];

// ---------- CDP ----------
const PORT = 9300 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "escribanote-site-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`, `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, f) => ((ws.onopen = ok), (ws.onerror = f))); } catch { ws = null; await sleep(200); } }
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
let extId; for (let i = 0; i < 60 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DSF, mobile: false }, sid);
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
for (let i = 0; i < 30; i++) { if (await ev("typeof chrome?.storage === 'object'").catch(() => false)) break; await sleep(300); }
// A primeira captura depois de trocar de aba às vezes não volta (o headless não pinta um quadro novo): tenta de novo.
const shot = async (name) => {
  await sleep(500);
  for (let i = 0; i < 4; i++) {
    const r = await Promise.race([send("Page.captureScreenshot", { format: "webp", quality: 84 }, sid), sleep(8000).then(() => null)]);
    if (r) { writeFileSync(join(OUT, name + ".webp"), Buffer.from(r.data, "base64")); console.log("✓", name); return; }
  }
  throw new Error("captura não voltou: " + name);
};
const go = async (q) => { await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html?tab=1${q}` }, sid); await sleep(1500); };
const theme = (patch) => ev(`(async () => { const { settings = {} } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, ...${JSON.stringify(patch)} } }); return true })()`);
const tab = async (t) => { await ev(`document.querySelector('[data-tab="${t}"]').click(); true`); await sleep(500); };

// Slide capturado: um gráfico de custo por mês desenhado num canvas.
const slide = await ev(`(() => {
  const c = new OffscreenCanvas(960, 540), g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 960, 540);
  g.fillStyle = "#16181d"; g.font = "bold 34px sans-serif"; g.fillText("Q4 · custo de mídia por mês", 48, 72);
  g.fillStyle = "#7a8190"; g.font = "20px sans-serif"; g.fillText("R$ mil · proposta da agência", 48, 106);
  const v = [[ "Out", 46 ], [ "Nov", 60 ], [ "Dez", 74 ]];
  v.forEach(([m, x], i) => { const h = x * 4.6, X = 140 + i * 250; g.fillStyle = i === 2 ? "#2f6bff" : "#a9c1ff"; g.fillRect(X, 470 - h, 150, h);
    g.fillStyle = "#16181d"; g.font = "bold 26px sans-serif"; g.fillText(String(x), X + 50, 455 - h); g.fillStyle = "#4b5260"; g.font = "22px sans-serif"; g.fillText(m, X + 52, 505); });
  return c.convertToBlob({ type: "image/jpeg", quality: .9 }).then((b) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); }));
})()`);

await ev(`(async () => {
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    ["session:" + ${JSON.stringify(sessao.id)}]: ${JSON.stringify(sessao)},
    ["session:" + ${JSON.stringify(aula.id)}]: ${JSON.stringify(aula)},
    "shot:demo-q4:s1": ${JSON.stringify(slide)},
    index: ${JSON.stringify(index)},
    welcomeDone: Date.now(),
    apiKey: "sk-ant-demo",
    settings: { ...settings, myName: "Thiago", mode: "always", aiModel: "claude-sonnet-5-5", folders: ${JSON.stringify(folders)}, theme: "light", themeLight: "default", themeDark: "default" },
  });
  return true;
})()`);
await send("Browser.grantPermissions", { origin: `chrome-extension://${extId}`, permissions: [] }).catch(() => {});

// 1) Transcrição com capítulos, lista com Fixadas e pastas
await go(`&id=${sessao.id}`);
await ev(`chrome.permissions.contains = async () => true; true`);
await shot("app-transcricao");

// 2) IA: material de apoio, capturas e web ligadas, resposta com fontes
await tab("ai");
await ev(`(() => { const s = document.getElementById('chat-select'); if (s) { s.value = "ch1"; s.dispatchEvent(new Event("change")); } return true })()`);
await sleep(400);
await shot("app-ia");
await ev(`document.querySelector('#support')?.scrollIntoView({ block: 'center' }); true`);
await shot("app-ia-material");

// 3) Ata
await tab("ata");
await shot("app-ata");

// 4) Análise
await tab("stats");
await shot("app-analise");

// 5) Menu do botão direito numa reunião da lista, com o submenu de pastas
await tab("transcript");
await ev(`(() => { const el = document.querySelector('#list [data-open="demo-retro"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 150, clientY: r.top + 22 })); return true })()`);
await sleep(300);
await shot("app-menu");
await ev(`document.querySelector('.ctx')?.remove(); true`);

// 5b) Arquivo longo transcrevendo: a mesma faixa de progresso que a extensão mostra (retransBanner)
await go(`&id=${aula.id}`);
await ev(`(() => {
  const ic = document.querySelector('[data-act="hq"] svg, #hq svg, .hq svg')?.outerHTML || "";
  document.getElementById("t-banner").innerHTML = '<div class="banner">' + ic + ' <b>Transcrevendo… 43%</b> <span class="muted">· parte 2 de 4 · 52 min de 2h00 transcritos · 11 min decorridos · faltam ~14 min</span>'
    + '<div class="rt-bar" role="progressbar"><span style="width:43%"></span></div>'
    + '<span class="muted tiny">A transcrição aparece aqui conforme avança; você pode continuar usando o Escribanote. Áudio longo: vai em partes de 30 min e o ponto é salvo ao fim de cada uma; se o navegador fechar, dá para continuar dali.</span>'
    + '<span class="banner-acts"><button type="button" class="btn sm">Cancelar</button></span></div>';
  return true;
})()`);
await shot("app-arquivo");

// 6) Temas: Papel e Editor
await theme({ theme: "light", themeLight: "paper" });
await go(`&id=${sessao.id}`);
await shot("app-tema-papel");
await theme({ theme: "dark", themeDark: "editor" });
await go(`&id=${sessao.id}`);
await shot("app-tema-editor");
await tab("ai");
await ev(`(() => { const s = document.getElementById('chat-select'); if (s) { s.value = "ch1"; s.dispatchEvent(new Event("change")); } return true })()`);
await sleep(400);
await shot("app-ia-editor");

chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
