// Renderiza lancamento.html quadro a quadro num Chromium headless e monta o MP4 com o ffmpeg.
//   CHROME=/caminho/chrome node render.mjs shorts|story [saida.mp4] [--stills]
// --stills salva só alguns quadros PNG em out/ para revisar as cenas.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME."); process.exit(2); }
const variant = process.argv[2] || "shorts";
const stills = process.argv.includes("--stills");
const out = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : resolve(import.meta.dirname, "out", `escribanote-${variant}.mp4`);
const FPS = 30;
mkdirSync(resolve(import.meta.dirname, "out"), { recursive: true });

const PORT = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--window-size=1080,1920",
  "--allow-file-access-from-files", `--user-data-dir=${mkdtempSync(join(tmpdir(), "escribanote-video-"))}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) { try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, f) => ((ws.onopen = ok), (ws.onerror = f))); break; } catch { await sleep(200); } }
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const durs = (process.argv.find((a) => a.startsWith("--d=")) || "").slice(4);
const url = "file://" + resolve(import.meta.dirname, "lancamento.html") + `?v=${variant}&still=1` + (durs ? `&d=${durs}` : "");
const { targetId } = await send("Target.createTarget", { url });
const { sessionId: sid } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sid);
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false }, sid);
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
await sleep(800);
await evaluate("document.fonts.ready.then(() => true)");
const duration = await evaluate("window.DURATION");
const frames = Math.round(duration * FPS);
console.log(`${variant}: ${duration.toFixed(1)} s, ${frames} quadros`);

const shot = async (t) => {
  await evaluate(`seek(${t})`);
  await sleep(8);
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sid);
  return Buffer.from(data, "base64");
};

if (stills) {
  const ts = Array.from({ length: Math.ceil(duration / 1.0) }, (_, i) => i * 1.0);
  for (const t of ts) writeFileSync(resolve(import.meta.dirname, "out", `${variant}-${String(Math.round(t * 10)).padStart(3, "0")}.png`), await shot(t));
  console.log("stills em out/");
  chrome.kill(); process.exit(0);
}

const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(FPS), out], { stdio: ["pipe", "inherit", "inherit"] });
for (let i = 0; i < frames; i++) {
  const png = await shot(i / FPS);
  if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % 60 === 0) process.stdout.write(`\r${i}/${frames}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`\nMP4: ${out}`);
chrome.kill();
process.exit(0);
