// Importar um arquivo de áudio pelo painel e transcrevê-lo com o Whisper (precisa do modelo base já
// baixado: use PROFILE=bench/.perfil, o mesmo do benchmark).
//   PROFILE=../bench/.perfil CHROME=... node test/e2e-import.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9600 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), "escribanote-import-"));
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
  // monta um WAV (16 kHz, 16 bits) a partir do clipe real embutido e "escolhe" o arquivo no botão Transcrever arquivo
  await ev(`(async () => {
    const pcm = new Uint8Array(await (await fetch(chrome.runtime.getURL("src/asr/fala-teste.pcm"))).arrayBuffer());
    const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, pcm.length, true);
    const file = new File([h, pcm], "Reunião de teste.wav", { type: "audio/wav", lastModified: Date.now() - 3600000 });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector("#import-audio"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(() => ev("!!document.querySelector('.ask [data-choice=\"base\"]')"), "escolha do modelo", 15000).catch(async (err) => {
    console.log("diag:", JSON.stringify(await ev(`(async () => ({ toast: document.querySelector("#toast").textContent, list: (await chrome.runtime.sendMessage({ type: "list" })).map((m) => [m.platform, m.title]), player: document.querySelector("#player").hidden, ask: !!document.querySelector(".ask"), title: document.querySelector("#m-title").value }))()`)));
    throw err;
  });
  await ev("document.querySelector('.ask [data-choice=\"base\"]').click()");
  await waitFor(() => ev("!document.querySelector('#player').hidden"), "player da reunião importada", 20000);
  const rec = await waitFor(async () => { const r = await ev(`chrome.runtime.sendMessage({ type: "list" })`); const imp = r.find((m) => m.platform === "import"); if (!imp) return null; const s = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(imp.id)} })`); return s.asr.length ? s : null; }, "transcrição do arquivo importado", 240000);
  const text = rec.asr.map((a) => a.text).join(" ");
  assert.ok(/am[eé]rica/i.test(text), "texto transcrito: " + text);
  assert.equal(rec.asr[0].source, "import");
  assert.ok(rec.report.events.some((e) => e.kind === "retranscribe-done"), "relatório registra a transcrição");
  assert.ok(rec.audio.tracks.includes("import") && rec.title === "Reunião de teste" && rec.endedAt, "reunião importada: " + JSON.stringify({ t: rec.title, a: rec.audio }));
  await waitFor(() => ev("!document.querySelector('#timeline .blk') ? false : true").then(() => ev("document.querySelectorAll('#timeline .blk').length > 0")), "painel mostra a fala transcrita", 20000);
  console.log("✓ arquivo importado transcrito:", text);
  // transcrever de novo pelo botão ↻ substitui a transcrição (mesmo modelo, mesmo resultado)
  await ev("document.querySelector('#p-retrans').click()");
  await waitFor(() => ev("!!document.querySelector('.ask [data-choice=\"base\"]')"), "escolha do modelo (de novo)");
  await ev("document.querySelector('.ask [data-choice=\"base\"]').click()");
  const again = await waitFor(async () => { const s = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(rec.id)} })`); return s.report.events.filter((e) => e.kind === "retranscribe-done").length >= 2 ? s : null; }, "segunda transcrição", 240000);
  assert.ok(again.asr.length >= 1 && /am[eé]rica/i.test(again.asr.map((a) => a.text).join(" ")));
  console.log("✓ transcrever de novo funciona\nE2E IMPORT OK");
} finally {
  ws.close(); chrome.kill(); await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
