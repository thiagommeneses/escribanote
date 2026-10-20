// Teste do motor Whisper dentro da extensão (Chrome real). Baixa o modelo na 1ª vez.
//   CHROME=... node test/e2e-asr.mjs <audio1.f32> [audio2.f32 ...]   (PCM float32, mono, 16 kHz)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";

const CHROME = process.env.CHROME;
const MODEL = process.env.MODEL || "base";
const files = process.argv.slice(2);
if (!CHROME || !files.length) {
  console.error("uso: CHROME=... node test/e2e-asr.mjs arquivo.f32 [...]");
  process.exit(2);
}
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9800 + Math.floor(Math.random() * 100);
// Perfil persistente opcional (PROFILE=...) para reaproveitar o modelo já baixado.
const profile = process.env.PROFILE || mkdtempSync(join(tmpdir(), "reunilo-asr-"));
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
  for (const f of files) {
    const buf = readFileSync(f);
    const samples = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4), (x) => Math.round(x * 1e4) / 1e4);
    const t0 = Date.now();
    const r = await send("Runtime.evaluate", {
      expression: `chrome.runtime.sendMessage({ type: "hq-test", modelKey: ${JSON.stringify(MODEL)}, lang: "pt-BR", samples: ${JSON.stringify(samples)} })`,
      awaitPromise: true, returnByValue: true, timeout: 600000,
    }, sessionId);
    const v = r.result.value || {};
    console.log(`\n[${basename(f)}] ${(samples.length / 16000).toFixed(1)} s de áudio · ${v.device || "?"} · ${v.ms ?? "?"} ms de inferência · ${Math.round((Date.now() - t0) / 1000)} s no total`);
    console.log(v.error ? "ERRO: " + v.error : v.text);
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
