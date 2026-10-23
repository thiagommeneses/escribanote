// Documento offscreen: captura o áudio da aba da reunião (e, opcionalmente, o
// microfone) e o entrega ao pipeline do Whisper local (src/asr/pipeline.js).
// O áudio nunca sai do computador; só o texto vai para o service worker.
import { createPipeline } from "../asr/pipeline.js";

const state = { tabId: null, status: { state: "idle" }, play: null };

function report(patch) {
  state.status = { ...state.status, ...patch };
  chrome.runtime.sendMessage({ type: "hq-status", tabId: state.tabId, status: state.status }).catch(() => {});
}

const pipe = createPipeline({
  onStatus: report,
  onResult: (seg) => chrome.runtime.sendMessage({ type: "asr-result", tabId: state.tabId, seg }).catch(() => {}),
});

async function stopCapture() {
  await pipe.stopCapture();
  if (state.play) await state.play.close().catch(() => {});
  state.play = null;
}

async function start({ tabId, streamId, modelKey, lang, mic, diarize }) {
  await stopCapture();
  pipe.reset();
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
      const m = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      await pipe.addStream(m, "mic");
    } catch (err) {
      report({ warning: "Microfone indisponível (" + err.message + "). Sua própria fala segue pelas legendas." });
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

async function stop() {
  await stopCapture();
  // termina o que já estava na fila antes de avisar
  await pipe.pump();
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
  const run = { start, stop, "transcribe-samples": transcribeSamples, "analyze-speakers": analyzeSpeakers, status: async () => state.status }[msg.type];
  if (!run) return;
  run(msg)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((err) => {
      report({ state: "error", message: err.message });
      sendResponse({ error: err.message });
    });
  return true;
});
