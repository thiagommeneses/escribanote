// Arquivo longo (65 min, quase todo silêncio, com falas aos 5, 40 e 62 min): aviso de duração, partes de
// 30 min, ponto salvo ao fim da parte 1, Cancelar e "Continuar de onde parou" sem perder nem repetir falas.
//   PROFILE=../bench/.perfil CHROME=... node test/e2e-import-long.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9600 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), "escribanote-import-long-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail))); } catch { ws = null; await sleep(200); }
}
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
async function waitFor(fn, what, ms = 60000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("tempo esgotado: " + what); await sleep(300); } }
try {
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1000);
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 600000 }, sessionId).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
  const AT = [5, 40, 62].map((m) => m * 60_000);
  await ev(`(async () => {
    const pcm = new Uint8Array(await (await fetch(chrome.runtime.getURL("src/asr/fala-teste.pcm"))).arrayBuffer());
    const total = 65 * 60 * 32000;
    const data = new Uint8Array(total);
    for (const ms of ${JSON.stringify(AT)}) data.set(pcm, (ms / 1000) * 32000);
    const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); h.setUint32(4, 36 + total, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, total, true);
    const file = new File([h, data], "Replay longo.wav", { type: "audio/wav", lastModified: Date.now() - 4 * 3600000 });
    const dt = new DataTransfer(); dt.items.add(file);
    // assim que a parte 1 for salva, cancela pelo botão (o silêncio é lido rápido: tem de ser na hora)
    window.__checkpoints = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m.type !== "retranscribe-checkpoint") return;
      window.__checkpoints.push(m.doneMs);
      if (window.__checkpoints.length === 1) document.querySelector('[data-retrans="cancel"]')?.click();
    });
    const input = document.querySelector("#import-audio"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(() => ev("!!document.querySelector('.ask [data-choice=\"base\"]')"), "escolha do modelo", 20000);
  const askText = await ev("document.querySelector('.ask').textContent");
  assert.match(askText, /1h05/, "aviso com a duração: " + askText);
  assert.match(askText, /3 partes de 30 min/, "aviso das partes: " + askText);
  await ev("document.querySelector('.ask [data-choice=\"base\"]').click()");
  const banner = await waitFor(() => ev("(() => { const t = document.querySelector('#t-banner').textContent; return /parte \\d de 3/.test(t) ? t : null; })()"), "banner com a parte", 120000);
  assert.match(banner, /de 1h05 transcritos/, "banner com minutos: " + banner);
  const getImp = async () => { const r = await ev(`chrome.runtime.sendMessage({ type: "list" })`); const imp = r.filter((m) => m.platform === "import" && m.title === "Replay longo").sort((a, b) => b.id.localeCompare(a.id))[0]; return imp && ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(imp.id)} })`); };
  const paused = await waitFor(async () => { const s = await getImp(); return s && s.audio?.partial?.doneMs === 1800000 && (await ev("!!document.querySelector('[data-retrans=\"resume\"]')")) ? s : null; }, "cancelado no fim da parte 1", 300000).catch(async (err) => {
    const s = await getImp();
    console.log("diag:", JSON.stringify({ partial: s?.audio?.partial, asr: s?.asr.length, ev: s?.report.events.slice(-6), cps: await ev("window.__checkpoints"), banner: await ev("document.querySelector('#t-banner').textContent"), toast: await ev("document.querySelector('#toast').textContent") }));
    throw err;
  });
  assert.ok(paused.report.events.some((e) => e.kind === "retranscribe-cancelled"), "relatório registra o cancelamento");
  const startsOf = (s) => s.asr.map((a) => a.start - s.audio.startedAt);
  assert.ok(startsOf(paused).some((t) => Math.abs(t - AT[0]) < 5000), "fala dos 5 min já transcrita: " + startsOf(paused));
  assert.ok(startsOf(paused).every((t) => t < 1800000), "nada depois do ponto salvo: " + startsOf(paused));
  console.log("✓ parte 1 salva e cancelada:", startsOf(paused).map((t) => Math.round(t / 1000)).join(", "), "s");
  await ev("document.querySelector('[data-retrans=\"resume\"]').click()");
  const done = await waitFor(async () => { const s = await getImp(); return s && !s.audio.partial && s.report.events.filter((e) => e.kind === "retranscribe-done").length ? s : null; }, "continuação até o fim", 300000);
  const starts = startsOf(done);
  const near = AT.map((at) => starts.filter((t) => Math.abs(t - at) < 5000).length);
  assert.ok(near.every((n) => n >= 1), "as três falas transcritas: " + starts);
  assert.equal(new Set(done.asr.map((a) => a.id)).size, done.asr.length, "sem falas repetidas");
  const firstPass = paused.asr.filter((a) => Math.abs(a.start - paused.audio.startedAt - AT[0]) < 5000).length;
  assert.equal(near[0], firstPass, "a fala dos 5 min não foi transcrita de novo");
  assert.ok(done.report.events.some((e) => e.kind === "retranscribe-start" && e.detail?.fromMs === 1800000) || done.report.events.some((e) => e.fromMs === 1800000), "retomou dos 30 min");
  console.log("✓ continuou dos 30 min até o fim:", starts.map((t) => Math.round(t / 1000)).join(", "), "s");
  console.log("E2E IMPORT LONGO OK");
} finally {
  ws.close(); chrome.kill(); await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
