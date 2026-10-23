// Teste da identificação de falantes (pyannote + WeSpeaker) dentro da extensão, num Chrome real.
// Baixa os modelos na 1ª vez (~32 MB). Usa o trecho de fala embutido: o mesmo trecho duas vezes
// tem de dar a mesma voz; uma cópia com o tom alterado (reamostrada) tem de dar outra voz.
//   CHROME=... node test/e2e-speakers.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error("uso: CHROME=... node test/e2e-speakers.mjs");
  process.exit(2);
}
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE || mkdtempSync(join(tmpdir(), "escribanote-spk-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });

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
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

// Trecho de referência (PCM int16 16 kHz) e uma versão "mais aguda": reamostrada a 1,22x
// (mesma fala, tom e ritmo diferentes, como outra pessoa).
const pcm = new Int16Array(readFileSync(join(EXT, "src/asr/fala-teste.pcm")).buffer);
const a = Float32Array.from(pcm, (v) => v / 32768);
const ratio = 1.22;
const b = new Float32Array(Math.floor(a.length / ratio));
for (let i = 0; i < b.length; i++) {
  const x = i * ratio;
  const i0 = Math.floor(x);
  const f = x - i0;
  b[i] = a[i0] * (1 - f) + (a[Math.min(a.length - 1, i0 + 1)] || 0) * f;
}
const q = (arr) => Array.from(arr, (x) => Math.round(x * 1e4) / 1e4);

try {
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1000);
  const t0 = Date.now();
  const r = await send("Runtime.evaluate", {
    expression: `chrome.runtime.sendMessage({ type: "speakers-test", clips: ${JSON.stringify([q(a), q(a), q(b)])} })`,
    awaitPromise: true, returnByValue: true, timeout: 600000,
  }, sessionId);
  const v = r.result.value || {};
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  if (v.error) throw new Error(v.error);
  console.log(`modelos carregados e 3 trechos analisados em ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const [i, res] of v.results.entries()) console.log(`  trecho ${i + 1}: ${res.ms} ms ·`, res.parts.map((p) => `${p.voice} ${p.startMs}-${p.endMs} ms`).join(", "));
  const voices = v.results.map((res) => res.parts[0].voice);
  assert.equal(voices[0], voices[1], "o mesmo trecho duas vezes tem de dar a mesma voz");
  assert.notEqual(voices[0], voices[2], "o trecho com o tom alterado tem de dar outra voz");
  assert.equal(v.voices, 2);
  console.log("✓ identificação de falantes OK (2 vozes)");
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
