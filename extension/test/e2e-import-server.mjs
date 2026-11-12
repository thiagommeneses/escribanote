// Transcrição no servidor (Pro), contra uma conta simulada: arquivo de 25 min lido em fluxo, enviado em
// pedaços de 10 min (WAV 16 kHz), falas voltam no horário certo, trabalho fechado no fim.
//   CHROME=... node test/e2e-import-server.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9600 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), "escribanote-import-srv-"));
import { createServer } from "node:http";
const calls = [];
const api = createServer((req, res) => {
  const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST", "content-type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    const url = new URL(req.url, "http://x");
    const reply = (code, obj) => { res.writeHead(code, cors); res.end(JSON.stringify(obj)); };
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, type: req.headers["content-type"], bytes: body.length, json: /json/.test(req.headers["content-type"] || "") ? JSON.parse(body.toString() || "{}") : null });
    if (url.pathname === "/api/v1/asr/start") return reply(200, { job: "job-1", credits: 1, balance: 8 });
    if (url.pathname === "/api/v1/asr/chunk") {
      const ms = Math.round(((body.length - 44) / 32000) * 1000);
      const off = Number(url.searchParams.get("offsetMs"));
      return reply(200, { ms, segments: [{ start: off + 1000, end: off + 3000, text: `Trecho que começa em ${Math.round(off / 60000)} min.` }] });
    }
    if (url.pathname === "/api/v1/asr/finish") return reply(200, { status: "done" });
    reply(404, { error: "not_found", message: "não" });
  });
}).listen(0);
const API = `http://127.0.0.1:${api.address().port}`;
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
  await ev(`chrome.storage.local.set({ accountApi: ${JSON.stringify(API)}, account: { token: "tok-teste", plan: "pro", balance: 9, email: "a@b.c" } })`);
  await ev(`(async () => {
    const total = 25 * 60 * 32000;
    const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); h.setUint32(4, 36 + total, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, total, true);
    // tom contínuo (não silêncio): falas em silêncio são descartadas como alucinação
    const pcm = new Int16Array(total / 2); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin(i * 0.17));
    const file = new File([h, pcm], "Aula no servidor.wav", { type: "audio/wav" });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector("#import-audio"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await waitFor(() => ev("!!document.querySelector('.ask [data-choice=\"server\"]')"), "opção No servidor", 20000);
  const label = await ev("document.querySelector('.ask [data-choice=\"server\"]').textContent");
  assert.match(label, /No servidor \(Pro, rápido\) · 1 crédito/);
  await ev("document.querySelector('.ask [data-choice=\"server\"]').click()");
  const getImp = async () => { const r = await ev(`chrome.runtime.sendMessage({ type: "list" })`); const imp = r.find((m) => m.title === "Aula no servidor"); return imp && ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(imp.id)} })`); };
  const done = await waitFor(async () => { const s = await getImp(); return s && s.report.events.some((e) => e.kind === "retranscribe-done") ? s : null; }, "transcrição no servidor concluída", 120000).catch(async (err) => {
    const s = await getImp();
    console.log("diag:", JSON.stringify({ calls: calls.map((c) => [c.path, c.query, c.bytes]), ev: s?.report.events.slice(-6), banner: await ev("document.querySelector('#t-banner').textContent"), toast: await ev("document.querySelector('#toast').textContent") }));
    throw err;
  });
  await sleep(500);
  const start = calls.find((c) => c.path === "/api/v1/asr/start");
  assert.equal(start.auth, "Bearer tok-teste");
  assert.equal(start.json.durationMs, 25 * 60_000);
  const chunks = calls.filter((c) => c.path === "/api/v1/asr/chunk");
  assert.deepEqual(chunks.map((c) => Number(c.query.offsetMs)), [0, 600_000, 1_200_000], "pedaços de 10 min");
  assert.deepEqual(chunks.map((c) => Math.round((c.bytes - 44) / 32000)), [600, 600, 300]);
  assert.ok(chunks.every((c) => c.type === "audio/wav" && c.query.job === "job-1" && c.query.lang === "pt"));
  const fin = calls.find((c) => c.path === "/api/v1/asr/finish");
  assert.deepEqual(fin.json, { job: "job-1", ok: true });
  const starts = done.asr.map((a) => a.start - done.audio.startedAt);
  assert.deepEqual(starts, [1000, 601_000, 1_201_000], "falas no horário do áudio");
  assert.ok(done.asr.every((a) => a.source === "import" && a.speakerId === "outros"));
  assert.ok(!done.audio.partial, "sem ponto de retomada pendente");
  assert.equal(done.audio.model, "server");
  console.log("✓ 25 min no servidor: 3 pedaços, falas em", starts.map((t) => Math.round(t / 1000)).join(", "), "s");
  console.log("E2E IMPORT SERVIDOR OK");
} finally {
  ws.close(); chrome.kill(); api.close(); await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
