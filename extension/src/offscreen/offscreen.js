// Documento offscreen: captura o áudio da aba da reunião (e, opcionalmente, o
// microfone) e o entrega ao pipeline do Whisper local (src/asr/pipeline.js).
// O áudio nunca sai do computador; só o texto vai para o service worker.
import { createPipeline } from "../asr/pipeline.js";
import { openMic, watchMic } from "../asr/mic.js";

const state = { tabId: null, status: { state: "idle" }, play: null, mic: null };

// Relatório de sessão: eventos vão para o service worker, que os guarda na reunião da aba.
function logEvent(kind, detail) {
  chrome.runtime.sendMessage({ type: "session-report", tabId: state.tabId, kind, detail }).catch(() => {});
}

function report(patch) {
  state.status = { ...state.status, ...patch };
  chrome.runtime.sendMessage({ type: "hq-status", tabId: state.tabId, status: state.status }).catch(() => {});
}

const pipe = createPipeline({
  onStatus: report,
  onResult: (seg) => chrome.runtime.sendMessage({ type: "asr-result", tabId: state.tabId, seg }).catch(() => {}),
  onEvent: logEvent,
});

async function stopCapture() {
  if (state.mic) state.mic.close();
  state.mic = null;
  await pipe.stopCapture();
  if (state.play) await state.play.close().catch(() => {});
  state.play = null;
}

async function start({ tabId, streamId, modelKey, lang, mic, echo = true, diarize }) {
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
  const run = { start, stop, "transcribe-samples": transcribeSamples, "analyze-speakers": analyzeSpeakers, status: async () => state.status, "object-url": objectUrl, "revoke-url": revokeUrl }[msg.type];
  if (!run) return;
  run(msg)
    .then((r) => sendResponse(r ?? { ok: true }))
    .catch((err) => {
      report({ state: "error", message: err.message });
      sendResponse({ error: err.message });
    });
  return true;
});
