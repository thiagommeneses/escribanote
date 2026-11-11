// "Transcrever esta aba": uma página comum tocando fala em loop vira uma sessão "Página da web" transcrita
// pelo Whisper a partir do som da aba; Parar encerra a captura. (precisa do modelo base no perfil)
//   PROFILE=<cópia de bench/.perfil> CHROME=... node test/e2e-webtab.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9600 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), "escribanote-webtab-"));
import { createServer } from "node:http";
const PAGE = `<!doctype html><title>Aula de geografia - YouTube</title><audio id="a" loop autoplay></audio><script>
fetch("/fala.pcm").then((r) => r.arrayBuffer()).then((b) => {
  const pcm = new Uint8Array(b), gap = 16000 * 2 * 2, total = pcm.length + gap;
  const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); h.setUint32(4, 36 + total, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, total, true);
  const a = document.getElementById("a"); a.src = URL.createObjectURL(new Blob([h, pcm, new Uint8Array(gap)], { type: "audio/wav" })); a.play();
});
</script>`;
const { readFileSync } = await import("node:fs");
const server = createServer((req, res) => {
  if (req.url === "/fala.pcm") { res.writeHead(200); return res.end(readFileSync(resolve(import.meta.dirname, "../src/asr/fala-teste.pcm"))); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE);
}).listen(0);
const PAGE_URL = `http://127.0.0.1:${server.address().port}/aula`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [...(process.env.HEADED ? [] : ["--headless=new"]), "--no-sandbox", "--no-first-run", "--allowlisted-extension-id=ohbnmfogdcbgegnpcaphidkjinplednd", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
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
  // a página com o áudio, numa aba ao lado do painel
  const { targetId: pageTarget } = await send("Target.createTarget", { url: PAGE_URL });
  await sleep(1500);
  const tabId = await ev(`(async () => { const me = await chrome.tabs.getCurrent(); const all = await chrome.tabs.query({}); return all.find((t) => t.id !== me.id && t.url === undefined || (t.url || "").startsWith("http://127.0.0.1"))?.id; })()`);
  assert.ok(tabId, "aba da página");
  const id = await ev(`chrome.runtime.sendMessage({ type: "web-start", tabId: ${tabId} }).then((r) => r && r.error ? "ERRO " + r.error : r)`);
  assert.ok(id && !String(id).startsWith("ERRO"), "web-start: " + id);
  // a captura e o motor ligam sempre; a fala só chega onde a página consegue tocar som (máquina com saída de
  // áudio). Sem saída (CI, WSL), o teste confere o resto e avisa; REQUIRE_AUDIO=1 exige a fala.
  await waitFor(() => ev(`chrome.runtime.sendMessage({ type: "hq-get", tabId: ${tabId} }).then((h) => h && h.state === "running")`), "captura da aba ligada", 60000);
  const started = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })`);
  assert.equal(started.platform, "web");
  assert.ok(started.web && !started.endedAt, "sessão da página ao vivo");
  assert.ok(started.title === "Aula de geografia" || started.title === "página da web", "título: " + started.title);
  assert.ok(started.report.events.some((e) => e.kind === "hq-start" && e.detail?.mic === false), "sem microfone");
  console.log("✓ sessão \"Página da web\" criada e áudio da aba em captura");
  const s = await waitFor(async () => { const x = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })`); return x && x.asr.length >= 2 ? x : null; }, "fala transcrita do som da aba", process.env.REQUIRE_AUDIO ? 120000 : 40000).catch((err) => {
    if (process.env.REQUIRE_AUDIO) throw err;
    console.log("~ nenhuma fala: este ambiente não tem saída de áudio (a página não toca). Use REQUIRE_AUDIO=1 numa máquina com som.");
    return null;
  });
  if (s) {
    const text = s.asr.map((a) => a.text).join(" ");
    assert.ok(/am[eé]rica/i.test(text), "texto: " + text);
    assert.ok(s.asr.every((a) => a.source === "tab" && a.speakerId === "outros"), "falante: " + JSON.stringify(s.asr.map((a) => [a.source, a.speakerId])));
    console.log("✓ som da aba transcrito:", text.slice(0, 120));
  }
  const ended = await ev(`chrome.runtime.sendMessage({ type: "end-live", id: ${JSON.stringify(id)} })`);
  assert.ok(ended.endedAt, "Parar encerra a sessão");
  const hq = await waitFor(() => ev(`chrome.runtime.sendMessage({ type: "hq-get", tabId: ${tabId} }).then((h) => !h || h.state === "idle" ? "idle" : null)`), "captura parada", 30000);
  console.log("✓ Parar encerrou a sessão e a captura (" + hq + ")");
  await send("Target.closeTarget", { targetId: pageTarget });
  console.log("E2E WEBTAB OK");
} finally {
  ws.close(); chrome.kill(); server.close(); await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
