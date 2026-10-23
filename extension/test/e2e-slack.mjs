// Teste ponta a ponta do Slack no Chrome: página falsa em https://app.slack.com (via CDP Fetch) com um
// huddle simulado (áudio ao vivo num <audio> e painel com avatares), indicador de fala e fim do huddle.
//   CHROME=/caminho/para/chrome node test/e2e-slack.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error("Defina CHROME com o caminho do executável do Chrome/Chromium.");
  process.exit(2);
}
const SRC = resolve(import.meta.dirname, "..");
const EXT = mkdtempSync(join(tmpdir(), "escribanote-ext-"));
for (const d of ["manifest.json", "icons", "src", "vendor"]) cpSync(join(SRC, d), join(EXT, d), { recursive: true });
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "escribanote-slack-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (t) => console.log("✓", t);

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1400,900", "--autoplay-policy=no-user-gesture-required",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank",
], { stdio: "ignore" });

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  } catch {
    ws = null;
    await sleep(200);
  }
}
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else for (const l of listeners) l(msg);
};
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const evaluate = async (sid, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("tempo esgotado: " + what);
    await sleep(250);
  }
}
async function widgetText(sid, selector = "#body") {
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true }, sid);
  const find = (n) => {
    if (n.nodeName === "ESCRIBANOTE-WIDGET") return n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) {
      const f = find(c);
      if (f) return f;
    }
    return null;
  };
  const host = find(root);
  if (!host) return null;
  const { nodeId } = await send("DOM.querySelector", { nodeId: host.shadowRoots[0].nodeId, selector }, sid);
  if (!nodeId) return null;
  const { object } = await send("DOM.resolveNode", { nodeId }, sid);
  const r = await send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){ return this.innerText }", returnByValue: true }, sid);
  return r.result.value;
}

const SLACK_HTML = `<!doctype html><html><head><title>#geral - Meu Time - Slack</title></head><body style="margin:0;background:#1a1d21;color:#fff;font:14px sans-serif">
<div class="p-client">Slack simulado</div>
<div data-qa="huddle_mini_panel" class="p-huddle_mini_panel" style="position:fixed;bottom:20px;left:20px;background:#222;padding:12px">
  <div class="p-huddle_participant" id="p1"><img alt="Ana Teste" width="32" height="32"></div>
  <div class="p-huddle_participant" id="p2"><img alt="Bruno Lima" width="32" height="32"></div>
  <button aria-label="Leave huddle">Leave</button>
</div>
<audio id="huddle-audio"></audio></body></html>`;

try {
  let extId = null;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  assert.ok(extId, "service worker da extensão não iniciou");
  const { targetId: appTarget } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId: app } = await send("Target.attachToTarget", { targetId: appTarget, flatten: true });
  await sleep(800);
  const sw = (msg) => evaluate(app, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

  // Aba do Slack (página falsa)
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: slack } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://app.slack.com/*" }] }, slack);
  listeners.push((msg) => {
    if (msg.method === "Fetch.requestPaused" && msg.sessionId === slack) {
      send("Fetch.fulfillRequest", { requestId: msg.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body: Buffer.from(SLACK_HTML).toString("base64") }, slack);
    }
  });
  await send("Page.enable", {}, slack);
  await send("Page.navigate", { url: "https://app.slack.com/client/T0001/C0002" }, slack);
  await waitFor(() => evaluate(slack, "document.documentElement.dataset.escribanoteSlack === 'pronto' && document.readyState === 'complete'"), "detector do Slack injetado");
  step("extensão carregada e detector do Slack injetado");

  // Huddle "começa": áudio ao vivo chega num <audio> (como o Chime faz)
  await evaluate(slack, `(async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.01;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest); osc.start();
    const a = document.getElementById("huddle-audio"); a.srcObject = dest.stream; a.volume = 0.01; await a.play();
    window.__ctx = ctx; return a.paused;
  })()`);
  const entry = await waitFor(async () => (await sw({ type: "list" })).find((m) => m.meetingKey === "slack:C0002"), "sessão do huddle", 10_000);
  assert.equal(entry.platform, "slack");
  assert.equal(entry.title, "Huddle em #geral");
  const id = entry.id;
  step("huddle detectado pelo áudio ao vivo: sessão criada com o título do canal");

  await waitFor(async () => /Huddle do Slack/.test((await widgetText(slack)) || ""), "widget do huddle");
  assert.match(await widgetText(slack), /Transcrever este huddle/);
  step("widget mostra o huddle com o botão de um toque");

  // Indicador de fala: Ana fala por 1,5 s
  await evaluate(slack, `document.getElementById("p1").classList.add("c-huddle_speaking")`);
  await sleep(1500);
  await evaluate(slack, `document.getElementById("p1").classList.remove("c-huddle_speaking")`);
  const s1 = await waitFor(async () => {
    const s = await sw({ type: "get", id });
    return s.turns.some((t) => t.speakerId === "slack:Ana Teste") ? s : null;
  }, "turno da Ana");
  assert.equal(s1.speakers["slack:Ana Teste"], "Ana Teste");
  assert.equal(s1.speakers["slack:Bruno Lima"], "Bruno Lima");
  const turn = s1.turns.find((t) => t.speakerId === "slack:Ana Teste");
  step("nomes dos avatares e turno de fala pelo indicador 'falando'");

  // Segmento do Whisper no intervalo da fala ganha o falante
  const meetTabId = await evaluate(app, `(async () => { for (const t of await chrome.tabs.query({})) { if ((await chrome.runtime.sendMessage({ type: "active-for-tab", tabId: t.id })) === ${JSON.stringify(id)}) return t.id; } })()`);
  await sw({ type: "asr-result", tabId: meetTabId, seg: { start: turn.start + 100, end: turn.end - 100, text: "Vamos começar pelo orçamento.", source: "tab" } });
  const s2 = await waitFor(async () => { const s = await sw({ type: "get", id }); return s.asr.length ? s : null; }, "segmento salvo");
  assert.equal(s2.asr[0].speakerId, "slack:Ana Teste");
  await waitFor(async () => /Ana Teste[\s\S]*Vamos começar pelo orçamento/.test((await widgetText(slack)) || ""), "widget com a fala");
  step("segmento do Whisper atribuído à Ana e exibido no widget");

  // Huddle termina: o áudio para → sessão encerrada em ~20 s
  await evaluate(slack, `(() => { document.getElementById("huddle-audio").pause(); return true; })()`);
  await waitFor(async () => !!(await sw({ type: "get", id })).endedAt, "sessão encerrada ao fim do huddle", 30_000);
  step("fim do huddle encerra a sessão sozinho");

  console.log("\nE2E Slack OK");
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
}
