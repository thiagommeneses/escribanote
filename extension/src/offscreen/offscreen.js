// Documento offscreen: captura o áudio da aba da reunião (e, opcionalmente, o
// microfone) e o entrega ao pipeline do Whisper local (src/asr/pipeline.js).
// O áudio nunca sai do computador; só o texto vai para o service worker.
import { createPipeline } from "../asr/pipeline.js";
import { openMic, watchMic } from "../asr/mic.js";
import { startKeeping } from "../asr/keep.js";
import { readTrack } from "../lib/audiovault.js";

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
  onStatus: (patch) => { if (state.retrans) retransProgress(patch); else report(patch); },
  onResult: (seg) => {
    if (state.retrans) {
      state.retrans.segments++;
      retransProgress({ progress: Math.min(99, Math.round(((seg.end - state.retrans.startedAt) / Math.max(1, state.retrans.durationMs)) * 100)) });
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

// Decodifica uma faixa do cofre (WebM/Opus gravado, ou mp3/wav/m4a importado) em mono 16 kHz.
async function decodeTrack(file) {
  const buf = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } finally {
    await ctx.close().catch(() => {});
  }
  const SR = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return { samples: out.getChannelData(0), durationMs: Math.round(decoded.duration * 1000) };
}

// Transcreve de novo (ou pela primeira vez, num arquivo importado) as faixas guardadas de uma reunião.
// Usa o mesmo pipeline da alta precisão, com fontes offline no relógio original (startedAt).
async function retranscribe({ sessionId, modelKey, lang, diarize, startedAt, tracks }) {
  if (state.tabId) throw new Error("A alta precisão está em uso numa reunião. Termine-a antes de transcrever de novo.");
  if (state.retrans) throw new Error("Já há uma transcrição em andamento.");
  state.retrans = { sessionId, startedAt, durationMs: 0, segments: 0, status: { state: "starting", progress: 0 } };
  try {
    pipe.reset();
    retransProgress({ state: "decoding" });
    const decoded = [];
    for (const source of tracks) {
      const f = await readTrack(sessionId, source);
      if (!f || !f.size) continue;
      const d = await decodeTrack(f);
      decoded.push({ source, ...d });
      state.retrans.durationMs = Math.max(state.retrans.durationMs, d.durationMs);
    }
    if (!decoded.length) throw new Error("O áudio desta reunião não está mais neste computador.");
    await pipe.run(modelKey, lang, { diarize: !!diarize });
    retransProgress({ state: "running", progress: 0 });
    // a faixa dos outros entra antes do microfone: o filtro de eco compara com o que já chegou
    decoded.sort((a, b) => (a.source === "mic") - (b.source === "mic"));
    for (const d of decoded) pipe.addOfflineSource(d.source, startedAt)(d.samples);
    pipe.flushSources();
    await pipe.drain();
    await pipe.stopCapture();
    retransProgress({ state: "done", progress: 100 });
    return { segments: state.retrans.segments, durationMs: state.retrans.durationMs };
  } catch (err) {
    retransProgress({ state: "error", message: err.message || String(err) });
    throw err;
  } finally {
    state.retrans = null;
  }
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

async function start({ tabId, streamId, modelKey, lang, mic, echo = true, diarize, keep = null }) {
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

  await pipe.run(modelKey, lang, { diarize: !!diarize });
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
  const run = { start, stop, retranscribe, "transcribe-samples": transcribeSamples, "analyze-speakers": analyzeSpeakers, status: async () => ({ ...state.status, tabId: state.tabId, retrans: !!state.retrans }), "object-url": objectUrl, "revoke-url": revokeUrl }[msg.type];
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
