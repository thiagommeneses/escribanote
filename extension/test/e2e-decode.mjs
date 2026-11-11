// Leitura em fluxo de arquivos (src/asr/decode.js) num Chromium real: gera arquivos com o ffmpeg em
// vários formatos (tom de 440 Hz) e confere duração, frequência e que a saída é mono 16 kHz.
//   CHROME=... node test/e2e-decode.mjs [--longo]     (--longo inclui um arquivo de 2 h)
// AAC/H.264 não existem no Chromium de código aberto: nesses casos confere só a leitura do índice.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "escribanote-decode-"));
const LONG = process.argv.includes("--longo");
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const tone = (sec, rate = 44100, ch = 2) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${rate}:duration=${sec}`, "-ac", String(ch)];
const cases = [
  { name: "pcm16-estereo.wav", sec: 150, make: (o) => ff([...tone(150), "-c:a", "pcm_s16le", o]) },
  { name: "float-mono-48k.wav", sec: 90, make: (o) => ff([...tone(90, 48000, 1), "-c:a", "pcm_f32le", o]) },
  { name: "cbr.mp3", sec: 150, make: (o) => ff([...tone(150), "-c:a", "libmp3lame", "-b:a", "128k", o]) },
  { name: "vbr.mp3", sec: 150, make: (o) => ff([...tone(150), "-c:a", "libmp3lame", "-q:a", "4", o]) },
  { name: "vorbis.ogg", sec: 150, make: (o) => ff([...tone(150), "-c:a", "libvorbis", "-q:a", "3", o]) },
  { name: "opus.ogg", sec: 150, make: (o) => ff([...tone(150, 48000), "-c:a", "libopus", "-b:a", "48k", o]) },
  { name: "opus.webm", sec: 150, make: (o) => ff([...tone(150, 48000), "-c:a", "libopus", "-b:a", "48k", o]) },
  { name: "ao-vivo.webm", sec: 120, live: true, make: (o) => ff([...tone(120, 48000, 1), "-c:a", "libopus", "-b:a", "32k", "-f", "webm", "-live", "1", "-cluster_time_limit", "5000", o]) },
  { name: "video-mp3.mp4", sec: 120, make: (o) => ff(["-f", "lavfi", "-i", "color=c=gray:s=160x120:r=10:d=120", ...tone(120), "-c:v", "mpeg4", "-c:a", "libmp3lame", "-b:a", "96k", "-shortest", o]) },
  { name: "aac.m4a", sec: 150, aac: true, make: (o) => ff([...tone(150), "-c:a", "aac", "-b:a", "96k", o]) },
  { name: "aac-moov-fim.mp4", sec: 90, aac: true, make: (o) => ff(["-f", "lavfi", "-i", "color=c=gray:s=160x120:r=10:d=90", ...tone(90), "-c:v", "mpeg4", "-c:a", "aac", "-shortest", o]) },
  { name: "aac.mov", sec: 90, aac: true, make: (o) => ff([...tone(90), "-c:a", "aac", "-f", "mov", o]) },
];
if (LONG) cases.push({ name: "duas-horas.ogg", sec: 7200, make: (o) => ff([...tone(7200, 48000, 1), "-c:a", "libopus", "-b:a", "16k", o]) });
for (const c of cases) c.make(join(dir, c.name));

const server = createServer((req, res) => {
  try {
    const body = readFileSync(join(dir, decodeURIComponent(req.url.slice(1))));
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const FILES = `http://127.0.0.1:${server.address().port}/`;

const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "escribanote-decode-prof-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail))); } catch { ws = null; await sleep(200); }
}
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
let failed = 0;
try {
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/print.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1000);
  const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  for (const c of cases) {
    const t0 = Date.now();
    const r = await ev(`(async () => {
      const { probeAudio, decodeAudio, OUT_RATE } = await import("/src/asr/decode.js");
      const blob = await (await fetch(${JSON.stringify(FILES + c.name)})).blob();
      const file = new File([blob], ${JSON.stringify(c.name)});
      const probe = await probeAudio(file);
      const out = { format: probe.format, durationMs: probe.durationMs, codec: probe.info?.config?.codec || null, streaming: probe.streaming };
      if (probe.info?.config) out.supported = (await AudioDecoder.isConfigSupported(probe.info.config)).supported;
      if (${!!c.aac} && !out.supported) return out;
      let n = 0, cross = 0, prev = 0, sq = 0, chunks = 0, maxChunk = 0;
      for await (const x of decodeAudio(file, { probe })) {
        chunks++; maxChunk = Math.max(maxChunk, x.length);
        for (let i = 0; i < x.length; i++) { const v = x[i]; if ((v >= 0) !== (prev >= 0)) cross++; prev = v; sq += v * v; }
        n += x.length;
      }
      return { ...out, decodedMs: Math.round(n / OUT_RATE * 1000), hz: Math.round(cross / 2 / (n / OUT_RATE)), rms: +Math.sqrt(sq / n).toFixed(3), chunks, maxChunkSec: Math.round(maxChunk / OUT_RATE) };
    })()`);
    const ms = Date.now() - t0;
    try {
      const expect = c.sec * 1000;
      if (!c.live) assert.ok(Math.abs(r.durationMs - expect) < expect * 0.02, `duração do índice ${r.durationMs} ≠ ${expect}`);
      if (c.aac && !r.supported) { console.log(`~ ${c.name}: índice ok (${r.format}, ${r.codec}, ${r.durationMs} ms); AAC não decodifica neste Chromium`); continue; }
      assert.ok(Math.abs(r.decodedMs - expect) < expect * 0.02 + 200, `decodificado ${r.decodedMs} ms ≠ ${expect}`);
      assert.ok(Math.abs(r.hz - 440) <= 3, `frequência ${r.hz} Hz`);
      assert.ok(r.rms > 0.04 && r.rms < 0.1, `volume ${r.rms}`); // seno do ffmpeg: amplitude 1/8 (e ×0,7 ao duplicar o canal)
      assert.ok(r.maxChunkSec <= 45, `trecho de ${r.maxChunkSec} s`);
      console.log(`✓ ${c.name}: ${r.format}/${r.codec || "pcm"} ${r.decodedMs} ms, ${r.hz} Hz, ${r.chunks} trechos, ${ms} ms`);
    } catch (err) {
      failed++;
      console.log(`✗ ${c.name}: ${err.message}`, JSON.stringify(r));
    }
  }
} finally {
  chrome.kill();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
