// Documento offscreen: captura o áudio da aba da reunião (e, opcionalmente, o
// microfone) e o entrega ao pipeline do Whisper local (src/asr/pipeline.js).
// O áudio nunca sai do computador; só o texto vai para o service worker.
import { createPipeline } from "../asr/pipeline.js";
import { openMic, watchMic } from "../asr/mic.js";
import { startKeeping } from "../asr/keep.js";
import { readTrack } from "../lib/audiovault.js";
import { probeAudio, decodeAudio } from "../asr/decode.js";
import { keepServerSegment } from "../asr/segmenter.js";

const state = { tabId: null, status: { state: "idle" }, play: null, mic: null, keep: null, retrans: null };

// Relatório de sessão: eventos vão para o service worker, que os guarda na reunião da aba.
function logEvent(kind, detail) {
  chrome.runtime.sendMessage({ type: "session-report", tabId: state.tabId, kind, detail }).catch(() => {});
}

function report(patch) {
  state.status = { ...state.status, ...patch };
  chrome.runtime.sendMessage({ type: "hq-status", tabId: state.tabId, status: state.status }).catch(() => {});
}

const pipe = createPipeline({
  onStatus: (patch) => {
    if (!state.retrans) return report(patch);
    // durante a retranscrição o avanço (%) é o do áudio, não o do carregamento do modelo
    if (patch.state === "running") { const { progress: _p, ...rest } = patch; return retransProgress(rest); }
    retransProgress(patch);
  },
  onResult: (seg) => {
    if (state.retrans && seg.mergeVoices) return chrome.runtime.sendMessage({ type: "asr-result", sessionId: state.retrans.sessionId, seg }).catch(() => {});
    if (state.retrans) {
      state.retrans.segments++;
      state.retrans.lastEnd = Math.max(state.retrans.lastEnd, seg.end - state.retrans.startedAt);
      return chrome.runtime.sendMessage({ type: "asr-result", sessionId: state.retrans.sessionId, seg }).catch(() => {});
    }
    return chrome.runtime.sendMessage({ type: "asr-result", tabId: state.tabId, seg }).catch(() => {});
  },
  onEvent: (kind, detail) => { if (state.retrans) chrome.runtime.sendMessage({ type: "session-report", sessionId: state.retrans.sessionId, kind, detail }).catch(() => {}); else logEvent(kind, detail); },
});

function retransProgress(patch) {
  const r = state.retrans;
  if (!r) return;
  Object.assign(r.status, patch);
  chrome.runtime.sendMessage({ type: "retranscribe-progress", sessionId: r.sessionId, status: { ...r.status, segments: r.segments } }).catch(() => {});
}

// Transcreve de novo (ou pela primeira vez, num arquivo importado) as faixas guardadas de uma reunião.
// Usa o mesmo pipeline da alta precisão, com fontes offline no relógio original (startedAt).
// O áudio é lido em fluxo (decode.js), em trechos de 30 s, com a fila do Whisper limitada: um arquivo
// de 3 h ocupa a mesma memória que um de 5 min. O avanço é contado em partes de 30 min; ao fim de cada
// parte a fila é esvaziada e o ponto é salvo, para retomar dali se o navegador fechar no meio.
// fromMs > 0 retoma: o começo do áudio é lido e descartado, sem transcrever.
const PART_MS = 30 * 60_000;
const QUEUE_MAX = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retranscribe({ sessionId, modelKey, lang, diarize, startedAt, tracks, profiles, fromMs = 0, server = null }) {
  if (state.tabId) throw new Error("A alta precisão está em uso numa reunião. Termine-a antes de transcrever de novo.");
  if (state.retrans) throw new Error("Já há uma transcrição em andamento.");
  const t0 = Date.now();
  const r = (state.retrans = { sessionId, startedAt, durationMs: 0, segments: 0, fromMs, lastEnd: fromMs, cancel: false, status: { state: "starting", progress: 0 } });
  const elapsed = () => Date.now() - t0;
  try {
    pipe.reset();
    retransProgress({ state: "decoding", fromMs });
    const inputs = [];
    for (const source of tracks) {
      const f = await readTrack(sessionId, source);
      if (!f || !f.size) continue;
      const probe = await probeAudio(f);
      inputs.push({ source, file: f, probe });
      r.durationMs = Math.max(r.durationMs, probe.durationMs || 0);
    }
    if (!inputs.length) throw new Error("O áudio desta reunião não está mais neste computador.");
    const parts = r.durationMs ? Math.max(1, Math.ceil(r.durationMs / PART_MS)) : null;
    if (server) return await serverTranscribe({ r, input: inputs[0], sessionId, startedAt, fromMs, lang, parts, server, elapsed });
    retransProgress({ state: "loading", durationMs: r.durationMs, parts });
    await pipe.run(modelKey, lang, { diarize: !!diarize, profiles });
    // a faixa dos outros entra antes do microfone: o filtro de eco compara com o que já chegou
    inputs.sort((a, b) => (a.source === "mic") - (b.source === "mic"));
    const streams = inputs.map((i) => ({
      source: i.source,
      it: decodeAudio(i.file, { probe: i.probe, onBytes: (got, total) => (i.bytes = got / total) })[Symbol.asyncIterator](),
      push: null,
      ms: 0,
      done: false,
      input: i,
    }));
    let nextCheckpoint = (Math.floor(fromMs / PART_MS) + 1) * PART_MS;
    let lastReport = 0;
    const readMs = () => Math.min(...streams.map((s) => (s.done ? Infinity : s.ms)).concat(r.durationMs || Infinity));
    const report = (force) => {
      if (!force && Date.now() - lastReport < 1000) return;
      lastReport = Date.now();
      const read = Math.max(0, ...streams.map((s) => s.ms));
      const done = Math.max(fromMs, Math.min(r.lastEnd, read));
      const total = r.durationMs || 0;
      const byBytes = Math.min(...streams.map((s) => s.input.bytes || 0));
      const progress = total ? Math.min(99, Math.round((done / total) * 100)) : Math.min(99, Math.round(byBytes * 100));
      const rate = (done - fromMs) / Math.max(1, elapsed()); // minutos de áudio por minuto de trabalho
      const etaMs = total && done - fromMs > 60_000 && rate > 0 ? Math.round((total - done) / rate) : null;
      retransProgress({ state: "running", progress, doneMs: done, readMs: Math.min(read, total || read), durationMs: total, part: Math.min(parts || Infinity, Math.floor(done / PART_MS) + 1), parts, elapsedMs: elapsed(), etaMs, fromMs });
    };
    for (;;) {
      if (r.cancel) break;
      const live = streams.filter((s) => !s.done);
      if (!live.length) break;
      // o microfone só avança quando a faixa dos outros já está 30 s à frente (ou acabou)
      const others = live.filter((s) => s.source !== "mic");
      const minOther = others.length ? Math.min(...others.map((s) => s.ms)) : Infinity;
      const pick = live.filter((s) => s.source !== "mic" || s.ms + 30_000 <= minOther).sort((a, b) => a.ms - b.ms)[0] || live[0];
      const { value, done } = await pick.it.next();
      if (done) { pick.done = true; continue; }
      const startMs = pick.ms;
      pick.ms += (value.length / 16) | 0;
      if (pick.ms <= fromMs) continue; // retomada: lido e descartado
      let samples = value;
      if (!pick.push) {
        // primeira amostra usada: a fonte começa no ponto de retomada (o horário segue o do áudio)
        const skip = Math.max(0, Math.round((fromMs - startMs) * 16));
        samples = value.subarray(skip);
        pick.push = pipe.addOfflineSource(pick.source, startedAt + startMs + skip / 16);
      }
      pick.push(samples);
      // fila do Whisper limitada: a leitura espera a transcrição alcançar
      while (pipe.queued > QUEUE_MAX && !r.cancel) { pipe.pump(); report(); await sleep(250); }
      report();
      if (readMs() >= nextCheckpoint) {
        // fim de uma parte: termina o que está na fila e salva o ponto de retomada
        while (pipe.busy && !r.cancel) { pipe.pump(); await sleep(250); }
        if (r.cancel) break;
        chrome.runtime.sendMessage({ type: "retranscribe-checkpoint", sessionId, doneMs: nextCheckpoint, durationMs: r.durationMs, modelKey }).catch(() => {});
        nextCheckpoint += PART_MS;
      }
    }
    for (const s of streams) s.it.return?.().catch?.(() => {});
    if (r.cancel) {
      pipe.reset();
      await pipe.stopCapture();
      retransProgress({ state: "cancelled" });
      return { cancelled: true, segments: r.segments, durationMs: r.durationMs };
    }
    pipe.flushSources();
    await pipe.drain();
    await pipe.stopCapture();
    if (!r.durationMs) r.durationMs = Math.max(...streams.map((s) => s.ms));
    chrome.runtime.sendMessage({ type: "retranscribe-checkpoint", sessionId, done: true, doneMs: r.durationMs, durationMs: r.durationMs, modelKey }).catch(() => {});
    retransProgress({ state: "done", progress: 100, doneMs: r.durationMs, durationMs: r.durationMs, elapsedMs: elapsed() });
    return { segments: r.segments, durationMs: r.durationMs };
  } catch (err) {
    retransProgress({ state: "error", message: err.message || String(err) });
    throw err;
  } finally {
    state.retrans = null;
  }
}
// Transcrição no servidor (Pro): o arquivo é lido aqui, em fluxo, e vai em pedaços de 10 min (WAV 16 kHz
// mono, ~19 MB) para a conta, que usa o Whisper large-v3-turbo do Groq. As falas voltam com o horário do
// áudio e entram na reunião como as do Whisper local. Mesmas partes de 30 min, ponto salvo e Cancelar.
const SERVER_CHUNK_MS = 10 * 60_000;
function wavBytes(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const w = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return out.buffer;
}
async function postChunk(server, wav, offsetMs, lang) {
  const url = `${server.base}/api/v1/asr/chunk?job=${encodeURIComponent(server.job)}&offsetMs=${offsetMs}&lang=${encodeURIComponent((lang || "pt").slice(0, 2))}`;
  for (let attempt = 0; ; attempt++) {
    let res, data;
    try {
      res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "audio/wav" }, body: wav });
      data = await res.json().catch(() => null);
    } catch {
      res = null;
    }
    if (res && res.ok) return data;
    // ocupado ou falha passageira: tenta de novo (até 4 vezes, esperando mais a cada vez)
    const retry = !res || res.status === 429 || res.status >= 500;
    if (!retry || attempt >= 3) throw new Error(data?.message || (res ? `Erro ${res.status} no servidor` : "Sem conexão com a conta Escribanote."));
    await sleep(2000 * 2 ** attempt);
  }
}
async function serverTranscribe({ r, input, sessionId, startedAt, fromMs, lang, parts, server, elapsed }) {
  const total = r.durationMs;
  retransProgress({ state: "running", progress: total ? Math.round((fromMs / total) * 100) : 0, doneMs: fromMs, durationMs: total, parts, part: Math.floor(fromMs / PART_MS) + 1, server: true, elapsedMs: elapsed() });
  let readMs = 0, doneMs = fromMs, nextCheckpoint = (Math.floor(fromMs / PART_MS) + 1) * PART_MS;
  let buf = [], bufLen = 0, bufStart = null;
  const send = async () => {
    if (!bufLen) return;
    const all = new Float32Array(bufLen);
    let o = 0;
    for (const p of buf) { all.set(p, o); o += p.length; }
    const offsetMs = bufStart;
    buf = []; bufLen = 0; bufStart = null;
    const out = await postChunk(server, wavBytes(all), Math.round(offsetMs), lang);
    for (const raw of out.segments || []) {
      const seg = keepServerSegment(all, offsetMs, raw);
      if (!seg) continue;
      r.segments++;
      await chrome.runtime.sendMessage({ type: "asr-result", sessionId, seg: { start: startedAt + seg.start, end: startedAt + seg.end, text: seg.text, source: input.source } }).catch(() => {});
    }
    doneMs = offsetMs + all.length / 16;
    const rate = (doneMs - fromMs) / Math.max(1, elapsed());
    retransProgress({ state: "running", progress: total ? Math.min(99, Math.round((doneMs / total) * 100)) : 0, doneMs, readMs, durationMs: total, parts, part: Math.min(parts || Infinity, Math.floor(doneMs / PART_MS) + 1), elapsedMs: elapsed(), etaMs: total && rate > 0 ? Math.round((total - doneMs) / rate) : null, segments: r.segments, server: true });
    while (doneMs >= nextCheckpoint) {
      chrome.runtime.sendMessage({ type: "retranscribe-checkpoint", sessionId, doneMs: nextCheckpoint, durationMs: total, modelKey: "server" }).catch(() => {});
      nextCheckpoint += PART_MS;
    }
  };
  const it = decodeAudio(input.file, { probe: input.probe })[Symbol.asyncIterator]();
  for (;;) {
    if (r.cancel) break;
    const { value, done } = await it.next();
    if (done) break;
    const start = readMs;
    readMs += value.length / 16;
    if (readMs <= fromMs) continue;
    const skip = Math.max(0, Math.round((fromMs - start) * 16));
    const part = skip ? value.subarray(skip) : value;
    if (bufStart == null) bufStart = start + skip / 16;
    buf.push(part);
    bufLen += part.length;
    if (bufLen >= SERVER_CHUNK_MS * 16) await send();
  }
  it.return?.().catch?.(() => {});
  if (r.cancel) {
    retransProgress({ state: "cancelled" });
    return { cancelled: true, segments: r.segments, durationMs: total };
  }
  await send();
  if (!r.durationMs) r.durationMs = readMs;
  chrome.runtime.sendMessage({ type: "retranscribe-checkpoint", sessionId, done: true, doneMs: r.durationMs, durationMs: r.durationMs, modelKey: "server" }).catch(() => {});
  retransProgress({ state: "done", progress: 100, doneMs: r.durationMs, durationMs: r.durationMs, elapsedMs: elapsed() });
  return { segments: r.segments, durationMs: r.durationMs };
}

async function cancelRetranscribe({ sessionId }) {
  if (state.retrans && (!sessionId || state.retrans.sessionId === sessionId)) state.retrans.cancel = true;
  return { ok: true };
}

async function stopCapture() {
  if (state.mic) state.mic.close();
  state.mic = null;
  if (state.keep) await state.keep.stop().catch(() => {}); // fecha as faixas antes de desligar as fontes
  state.keep = null;
  await pipe.stopCapture();
  if (state.play) await state.play.close().catch(() => {});
  state.play = null;
}

async function start({ tabId, streamId, modelKey, lang, mic, echo = true, diarize, keep = null, profiles = null }) {
  await stopCapture();
  pipe.reset();
  pipe.setEcho(echo);
  state.tabId = tabId;
  state.status = { state: "starting" };

  const tab = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  });
  // Capturar a aba silencia o áudio dela: devolve o som para os alto-falantes.
  state.play = new AudioContext();
  state.play.createMediaStreamSource(tab).connect(state.play.destination);
  await pipe.addStream(tab, "tab");

  if (mic) {
    try {
      const m = await openMic();
      await pipe.addStream(m, "mic");
      state.mic = watchMic(m, { onStream: (s) => pipe.replaceStream("mic", s), onEvent: logEvent });
    } catch (err) {
      logEvent("mic-denied", { error: err.name || String(err) });
      report({ warning: "Microfone indisponível (" + err.message + "). Sua própria fala segue pelas legendas." });
    }
  }
  logEvent("capture-started", { sources: mic ? ["tab", "mic"] : ["tab"], model: modelKey, diarize: !!diarize });
  if (keep && keep.sessionId) {
    try {
      state.keep = startKeeping({
        sessionId: keep.sessionId,
        streams: { tab: pipe.recordStream("tab"), mic: pipe.recordStream("mic") },
        onMeta: (meta) => chrome.runtime.sendMessage({ type: "audio-meta", sessionId: keep.sessionId, meta }).catch(() => {}),
      });
      if (state.keep) { logEvent("audio-keep-started", { tracks: mic ? ["tab", "mic"] : ["tab"] }); report({ audio: true }); }
    } catch (err) {
      logEvent("audio-keep-error", { message: err.message || String(err) });
    }
  }

  await pipe.run(modelKey, lang, { diarize: !!diarize, profiles });
}

// Teste/diagnóstico da identificação de falantes: devolve turnos e voz de cada amostra enviada.
async function analyzeSpeakers({ clips }) {
  let sp;
  try {
    sp = await pipe.loadSpeakers();
  } catch (err) {
    throw new Error("carregar modelos de voz: " + (err.message || err) + (err.stack ? " @ " + err.stack.split("\n")[1] : ""));
  }
  const out = [];
  for (const clip of clips) {
    const samples = Float32Array.from(clip);
    const t0 = performance.now();
    const parts = await sp.split(samples);
    out.push({ ms: Math.round(performance.now() - t0), parts: parts.map(({ samples: _s, ...p }) => p) });
  }
  return { results: out, voices: sp.book.size };
}

async function stop({ tabId } = {}) {
  if (tabId != null && state.tabId !== tabId) return; // a captura em andamento é de outra aba
  await stopCapture();
  // termina o que já estava na fila (inclusive o trecho que estava sendo transcrito) antes de avisar
  await Promise.race([pipe.drain(), new Promise((r) => setTimeout(r, 20_000))]);
  report({ state: "idle" });
  state.tabId = null;
}

// Teste/diagnóstico: transcreve amostras enviadas diretamente (sem captura).
// Sem amostras, transcreve o trecho de fala de referência embutido na extensão.
async function transcribeSamples({ samples, modelKey, lang }) {
  const engine = await pipe.loadEngine(modelKey, lang);
  if (!samples) return engine.selfTest();
  const t0 = performance.now();
  const text = await engine.transcribe(Float32Array.from(samples));
  return { text, device: engine.device, ms: Math.round(performance.now() - t0) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  // object-url: o service worker não tem URL.createObjectURL; o backup automático grande passa por aqui.
  const objectUrl = async ({ text, mime }) => ({ url: URL.createObjectURL(new Blob([text], { type: mime || "application/json" })) });
  const revokeUrl = async ({ url }) => URL.revokeObjectURL(url);
  const run = { start, stop, retranscribe, "retranscribe-cancel": cancelRetranscribe, "transcribe-samples": transcribeSamples, "analyze-speakers": analyzeSpeakers, status: async () => ({ ...state.status, tabId: state.tabId, retrans: !!state.retrans }), "object-url": objectUrl, "revoke-url": revokeUrl }[msg.type];
  if (!run) return;
  run(msg)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch(async (err) => {
      report({ state: "error", message: err.message });
      // início que falhou não pode deixar a aba como dona da captura
      if (msg.type === "start") {
        await stopCapture().catch(() => {});
        state.tabId = null;
      }
      sendResponse({ error: err.message });
    });
  return true;
});
