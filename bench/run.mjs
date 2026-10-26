// Benchmark de transcrição do Escribanote: roda o pipeline real (segmentador, filtros e Whisper)
// dentro da extensão, num Chromium sem interface, sobre casos com verdade conhecida.
//
//   CHROME=/caminho/chrome node bench/run.mjs [--modelo base|small|turbo] [--verificar] [--caso nome] [--perfil dir]
//
// Cada caso é uma pasta em bench/casos/<nome> com caso.json (faixas "aba" e "mic": arquivo .wav 16 kHz
// mono 16 bits, .pcm s16/f32 ou "gerar:silencio:<segundos>") e verdade.json (linhas com quem, lado,
// inicio, fim em ms e texto). Métricas por caso: palavras encontradas perto do momento certo, lado
// correto, vazamento (fala dos outros atribuída ao microfone), linhas e segundos. Com --verificar,
// compara com bench/limiares.json e sai com erro se algum caso ficar abaixo.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(ROOT, "..", "extension");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const MODEL = opt("--modelo", process.env.MODEL || "base");
const ONLY = opt("--caso", null);
const CHECK = args.includes("--verificar");
const PROFILE = resolve(opt("--perfil", join(ROOT, ".perfil")));
const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME=/caminho/do/chrome"); process.exit(2); }
mkdirSync(PROFILE, { recursive: true });

const SR = 16000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- áudio ----
function loadTrack(spec, caseDir, formato) {
  if (!spec) return null;
  const gen = /^gerar:silencio:(\d+)$/.exec(spec);
  if (gen) return new Float32Array(SR * Number(gen[1]));
  const path = resolve(caseDir, spec);
  const buf = readFileSync(path);
  if (path.toLowerCase().endsWith(".wav")) return wavToFloat(buf);
  if (formato === "f32") return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const s16 = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return Float32Array.from(s16, (v) => v / 32768);
}
function wavToFloat(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("WAV inválido");
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") data = buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("WAV sem fmt/data");
  if (fmt.rate !== SR || fmt.bits !== 16) throw new Error(`WAV precisa ser 16 kHz, 16 bits (veio ${fmt.rate} Hz, ${fmt.bits} bits)`);
  const n = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < fmt.channels; c++) v += data.readInt16LE((i * fmt.channels + c) * 2);
    out[i] = v / fmt.channels / 32768;
  }
  return out;
}
const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64");

// ---- métricas ----
const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const SLACK = 3000;
function score(truth, segs) {
  const lines = truth.linhas || [];
  let total = 0, found = 0, side = 0;
  for (const ln of lines) {
    const near = segs.filter((s) => s.end >= ln.inicio - SLACK && s.start <= ln.fim + SLACK);
    const bag = new Map();
    for (const s of near) for (const w of norm(s.text)) bag.set(w, [...(bag.get(w) || []), s.source]);
    for (const w of norm(ln.texto)) {
      total++;
      const srcs = bag.get(w);
      if (!srcs || !srcs.length) continue;
      found++;
      if (srcs.includes(ln.lado)) side++;
      bag.set(w, srcs.slice(1));
    }
  }
  // vazamento: palavras ditas pelos outros (lado aba) que apareceram em trechos do microfone no mesmo momento
  let leakTotal = 0, leaked = 0;
  for (const s of segs.filter((x) => x.source === "mic")) {
    const others = lines.filter((ln) => ln.lado === "aba" && s.end >= ln.inicio - SLACK && s.start <= ln.fim + SLACK);
    const otherWords = new Set(others.flatMap((ln) => norm(ln.texto)));
    for (const w of norm(s.text)) { leakTotal++; if (otherWords.has(w) && w.length > 3) leaked++; }
  }
  return {
    encontradas: total ? found / total : null,
    lado: found ? side / found : null,
    vazamento: leakTotal ? leaked / leakTotal : 0,
    linhas: segs.length,
    palavras: segs.reduce((a, s) => a + norm(s.text).length, 0),
  };
}

// ---- navegador ----
async function withExtension(fn) {
  const PORT = 9700 + Math.floor(Math.random() * 100);
  const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
  let ws;
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
    } catch { ws = null; await sleep(200); }
  }
  if (!ws) { chrome.kill(); throw new Error("não conectou ao Chrome"); }
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result); }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  try {
    let extId;
    for (let i = 0; i < 100 && !extId; i++) {
      const { targetInfos } = await send("Target.getTargets");
      const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
      if (sw) extId = new URL(sw.url).host; else await sleep(200);
    }
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await sleep(800);
    const evaluate = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 1_800_000 }, sessionId).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
    return await fn(evaluate);
  } finally {
    ws.close();
    chrome.kill();
    await sleep(300);
  }
}

// Roda dentro da página do Escribanote: mesmo pipeline do modo alta precisão, com fontes offline.
const PAGE_RUNNER = `(async (modelKey, tracks) => {
  const { createPipeline } = await import(chrome.runtime.getURL("src/asr/pipeline.js"));
  const out = [];
  const events = [];
  const pipe = createPipeline({ onResult: (s) => out.push(s), onEvent: (k, d) => events.push({ k, d }) });
  const t0 = performance.now();
  await pipe.run(modelKey, "pt-BR");
  const loadMs = Math.round(performance.now() - t0);
  const dec = (s) => { const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Float32Array(u8.buffer); };
  const t1 = performance.now();
  for (const [source, b64] of Object.entries(tracks)) {
    const push = pipe.addOfflineSource(source, 0);
    push(dec(b64));
  }
  pipe.flushSources();
  await pipe.drain();
  const workMs = Math.round(performance.now() - t1);
  return { segs: out.map((s) => ({ start: s.start, end: s.end, text: s.text, source: s.source })), loadMs, workMs, events };
})`;

// ---- principal ----
const cases = readdirSync(join(ROOT, "casos")).filter((n) => existsSync(join(ROOT, "casos", n, "caso.json")) && (!ONLY || n === ONLY)).sort();
if (!cases.length) { console.error("nenhum caso encontrado"); process.exit(2); }
const limits = existsSync(join(ROOT, "limiares.json")) ? JSON.parse(readFileSync(join(ROOT, "limiares.json"), "utf8")) : {};
const results = [];
let failed = false;

await withExtension(async (evaluate) => {
  for (const name of cases) {
    const dir = join(ROOT, "casos", name);
    const caso = JSON.parse(readFileSync(join(dir, "caso.json"), "utf8"));
    const truth = existsSync(join(dir, "verdade.json")) ? JSON.parse(readFileSync(join(dir, "verdade.json"), "utf8")) : { linhas: [] };
    const tracks = {};
    for (const [side, spec] of Object.entries(caso.faixas || {})) {
      const f32 = loadTrack(spec, dir, caso.formato);
      if (f32) tracks[side === "aba" ? "tab" : side] = b64(f32);
    }
    const seconds = Math.max(...Object.values(tracks).map((b) => (Buffer.from(b, "base64").length / 4) / SR), 0);
    process.stdout.write(`${name.padEnd(22)} ${seconds.toFixed(0).padStart(4)} s de áudio … `);
    const r = await evaluate(`${PAGE_RUNNER}(${JSON.stringify(MODEL)}, ${JSON.stringify(tracks)})`);
    const segs = r.segs.map((s) => ({ ...s, source: s.source === "tab" ? "aba" : s.source }));
    const m = score(truth, segs);
    const lim = limits[name] || {};
    const problems = [];
    if (lim.encontradas != null && (m.encontradas ?? 0) < lim.encontradas) problems.push(`encontradas ${pct(m.encontradas)} < ${pct(lim.encontradas)}`);
    if (lim.lado != null && (m.lado ?? 0) < lim.lado) problems.push(`lado ${pct(m.lado)} < ${pct(lim.lado)}`);
    if (lim.vazamento_max != null && m.vazamento > lim.vazamento_max) problems.push(`vazamento ${pct(m.vazamento)} > ${pct(lim.vazamento_max)}`);
    if (lim.linhas_max != null && m.linhas > lim.linhas_max) problems.push(`linhas ${m.linhas} > ${lim.linhas_max}`);
    if (problems.length) failed = true;
    results.push({ caso: name, ...m, segundos: +(r.workMs / 1000).toFixed(1), modelo: MODEL, problemas: problems, saida: segs });
    console.log(`encontradas ${pct(m.encontradas)} · lado ${pct(m.lado)} · vazamento ${pct(m.vazamento)} · ${m.linhas} linhas · ${(r.workMs / 1000).toFixed(1)} s${problems.length ? "  ✗ " + problems.join("; ") : "  ✓"}`);
    for (const s of segs) console.log(`    [${(s.start / 1000).toFixed(1)}–${(s.end / 1000).toFixed(1)} s · ${s.source}] ${s.text}`);
  }
});

function pct(v) { return v == null ? "—" : Math.round(v * 100) + "%"; }
mkdirSync(join(ROOT, "resultados"), { recursive: true });
writeFileSync(join(ROOT, "resultados", "ultimo.json"), JSON.stringify({ modelo: MODEL, quando: new Date().toISOString(), casos: results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = ["| caso | encontradas | lado | vazamento | linhas | segundos | |", "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.caso} | ${pct(r.encontradas)} | ${pct(r.lado)} | ${pct(r.vazamento)} | ${r.linhas} | ${r.segundos} | ${r.problemas.length ? "✗ " + r.problemas.join("; ") : "✓"} |`)].join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Benchmark (${MODEL})\n\n${md}\n`, { flag: "a" });
}
if (CHECK && failed) { console.error("\nBenchmark abaixo dos limiares."); process.exit(1); }
console.log(CHECK ? "\nBenchmark dentro dos limiares." : "");
