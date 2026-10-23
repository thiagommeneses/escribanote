// Fotografa o app real da extensão (Chromium headless + CDP) com uma reunião fictícia,
// para o vídeo de lançamento. Saída: public/capturas/*.png (2x, 1600x1000 lógicos).
//   CHROME=/caminho/chrome node capturas.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME."); process.exit(2); }
const EXT = resolve(import.meta.dirname, "../../extension");
const OUT = resolve(import.meta.dirname, "public/capturas");
mkdirSync(OUT, { recursive: true });
const W = 1600, H = 1000;

// ---------- reunião fictícia ----------
const t0 = new Date(); t0.setHours(14, 2, 0, 0);
const T = t0.getTime();
const SP = { a: "Ana Teixeira", b: "Bruno Lima", p: "Paula Franco", me: "Thiago" };
const ids = { a: "spaces/x/devices/101", b: "spaces/x/devices/102", p: "spaces/x/devices/103", me: "spaces/x/devices/104" };
const falas = [
  ["a", 0.5, "Bom, vamos revisar o orçamento do Q4. A proposta é fechar hoje."],
  ["b", 1.4, "Eu olhei os números ontem. A mídia ficou em 180 mil, dentro do que a gente combinou."],
  ["p", 2.6, "O cronograma eu consigo mandar até sexta, com as entregas por semana."],
  ["me", 3.5, "Perfeito. Então quem fica com a frente de mídia?"],
  ["a", 4.1, "Eu assumo a mídia. O Bruno fica com o financeiro e a aprovação da verba."],
  ["b", 5.0, "Combinado. Confirmo com o financeiro ainda hoje e aviso no canal."],
  ["p", 6.2, "Só um ponto: o fornecedor novo entra no segundo mês, não no primeiro."],
  ["a", 7.0, "Certo, ajusto a previsão. Então aprovamos os 180 mil de mídia?"],
  ["b", 7.6, "Aprovo a mídia de 180 mil."],
  ["me", 8.3, "Aprovado. Fechamos o orçamento do Q4 hoje, obrigado pessoal."],
  ["p", 9.0, "Mando o cronograma até sexta e a ata vai pro canal do projeto."],
];
const entries = falas.map(([w, min, text], i) => ({ id: `e${i + 1}`, kind: "caption", speakerId: ids[w], text, version: 1, at: T + min * 60000, updatedAt: T + min * 60000 + 4000, source: "protocol" }));
entries.splice(4, 0, { id: "c1", kind: "chat", speakerId: ids.p, text: "Vou colocar o cronograma no drive do projeto 👍", version: 1, at: T + 3.8 * 60000, updatedAt: T + 3.8 * 60000, source: "protocol" });
const sessao = {
  id: "demo-q4", platform: "meet", meetingKey: "meet:abc-defg-hij", url: "https://meet.google.com/abc-defg-hij", title: "Planejamento do Q4",
  startedAt: T, updatedAt: T + 42 * 60000, endedAt: T + 42 * 60000,
  speakers: { [ids.a]: SP.a, [ids.b]: SP.b, [ids.p]: SP.p, [ids.me]: SP.me },
  entries,
  highlights: { e9: ["decisao"], e3: ["acao"] },
  notes: { text: "", items: [{ id: "n1", at: T + 4.5 * 60000, text: "Confirmar verba extra com o financeiro" }] },
  chats: [{ id: "ch1", createdAt: T + 50 * 60000, messages: [
    { role: "user", text: "O que ficou decidido?", at: T + 50 * 60000 },
    { role: "assistant", text: "Três decisões:\n\n1. **Mídia aprovada em R$ 180 mil** (Bruno, 00:07).\n2. **Ana assume a frente de mídia**; Bruno fica com o financeiro.\n3. **Orçamento do Q4 fechado hoje** (Thiago, 00:08).\n\nPendências: Paula envia o cronograma até sexta; Bruno confirma a verba com o financeiro.", at: T + 50 * 60000 + 3000 },
  ] }],
  summary: { text: "## Resumo\nReunião de 42 minutos para fechar o orçamento do Q4. A verba de mídia foi aprovada e os responsáveis por cada frente ficaram definidos.\n\n## Decisões\n- Mídia aprovada: **R$ 180 mil** (Bruno)\n- Ana assume a frente de mídia; Bruno, o financeiro\n- Orçamento do Q4 fechado hoje\n\n## Pendências\n- [ ] Paula envia o cronograma até sexta\n- [ ] Bruno confirma a verba com o financeiro\n- [ ] Ajustar a previsão: fornecedor novo entra no segundo mês", createdAt: T + 43 * 60000 },
};
const outras = [
  { id: "demo-retro", title: "Retrospectiva da sprint 18", platform: "teams", startedAt: T - 24 * 3600000, endedAt: T - 24 * 3600000 + 35 * 60000, participants: ["Ana Teixeira", "Bruno Lima", "Thiago"], count: 84, highlights: 3 },
  { id: "demo-cliente", title: "Alinhamento com o cliente", platform: "zoom", startedAt: T - 3 * 24 * 3600000, endedAt: T - 3 * 24 * 3600000 + 50 * 60000, participants: ["Paula Franco", "Thiago"], count: 132, highlights: 5, hasSummary: true },
  { id: "demo-huddle", title: "Huddle em #projeto-q4", platform: "slack", startedAt: T - 5 * 24 * 3600000, endedAt: T - 5 * 24 * 3600000 + 12 * 60000, participants: ["Bruno Lima", "Thiago"], count: 31, highlights: 0 },
];
const index = [
  { id: sessao.id, title: sessao.title, platform: "meet", startedAt: T, updatedAt: sessao.updatedAt, endedAt: sessao.endedAt, count: entries.length, participants: Object.values(SP), highlights: 2, hasSummary: true, meetingKey: sessao.meetingKey },
  ...outras.map((o) => ({ ...o, updatedAt: o.endedAt })),
];

// ---------- CDP ----------
const PORT = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "escribanote-cap-"))}`, `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) { try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, f) => ((ws.onopen = ok), (ws.onerror = f))); break; } catch { await sleep(200); } }
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
let extId; for (let i = 0; i < 50 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sid); await send("Runtime.enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false }, sid);
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
for (let i = 0; i < 30; i++) { const ok = await evaluate("location.href.includes('app.html') && typeof chrome?.storage === 'object'"); if (ok) break; await sleep(300); }
const shot = async (name) => { await sleep(350); const { data } = await send("Page.captureScreenshot", { format: "png" }, sid); writeFileSync(join(OUT, name + ".png"), Buffer.from(data, "base64")); console.log("✓", name); };
const go = async (url) => { await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html${url}` }, sid); await sleep(1200); };

// semente
await evaluate(`(async () => { const { settings = {} } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ ["session:" + ${JSON.stringify(sessao.id)}]: ${JSON.stringify(sessao)}, index: ${JSON.stringify(index)}, settings: { ...settings, myName: "Thiago", mode: "always" } }); })()`);

const rects = {};
const rect = async (key, sel) => { rects[key] = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`); };
await go("?tab=1");
await shot("01-lista");
await rect("cardHoje", "#recent a, #recent .card, .recent [data-id], [data-id='demo-q4']");
await go(`?id=${sessao.id}`);
await shot("02-transcricao");
await rect("speakers", "#speakers"); await rect("nomePaula", '#timeline .who b[data-speaker="' + ids.p + '"]'); await rect("tabIa", '.subtabs [data-tab="ai"]'); await rect("tabStats", '.subtabs [data-tab="stats"]'); await rect("blk1", "#timeline .blk"); await rect("export", "#m-export");
// editor de renomear aberto no primeiro bloco da Paula
await evaluate(`(() => { const el = document.querySelector('#timeline .who b[data-speaker="${ids.p}"]'); el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); return true })()`);
await sleep(300);
await shot("03-renomear");
await rect("askInput", ".ask input"); await rect("askOk", ".ask [data-ok]");
await evaluate(`(() => { const i = document.querySelector('.ask input'); i.value = "Paula Franco (PM)"; return true })()`);
await shot("04-renomear-digitado");
await evaluate(`document.querySelector('.ask [data-cancel]').click(); true`);
// IA: conversa salva aberta
await evaluate(`document.querySelector('.subtabs [data-tab="ai"]').click(); true`);
await sleep(400);
await evaluate(`(() => { const s = document.getElementById('chat-select'); if (s) { s.value = "ch1"; s.dispatchEvent(new Event("change")); } return true })()`);
await sleep(300);
await shot("05-ia");
await rect("aiInput", "#ai-input, #pane-ai input[type=text], #pane-ai textarea, #ai-q"); await rect("chatLog", "#chat-log"); await rect("ata", "#pane-ai .ata, .card.ata");
console.log("ai input id:", await evaluate("[...document.querySelectorAll('#pane-ai input, #pane-ai textarea')].map(e => e.id + ':' + e.placeholder).join(' | ')"));
await evaluate(`(() => { const i = document.getElementById('ai-input') || document.querySelector('#pane-ai input, #pane-ai textarea'); if (i) i.value = "O que ficou decidido?"; return true })()`);
await shot("06-ia-pergunta");
await evaluate(`document.querySelector('.subtabs [data-tab="stats"]').click(); true`);
await sleep(400);
await shot("07-analise");
await rect("bars", "#pane-stats .bars, #pane-stats .card");
await evaluate(`document.querySelector('.subtabs [data-tab="highlights"]').click(); true`);
await sleep(300);
await shot("08-destaques");
await go("?view=settings");
await shot("09-ajustes");
writeFileSync(join(OUT, "rects.json"), JSON.stringify(rects, null, 1));
console.log(JSON.stringify(rects));
chrome.kill();
process.exit(0);
