// Pipeline de reconhecimento local: recebe MediaStreams de áudio, segmenta por pausas e
// transcreve com o Whisper. Usado pelo documento offscreen (áudio da aba da reunião) e pelo
// gravador (áudio do computador, para apps como o Slack). O áudio nunca sai do computador.
import { Segmenter } from "./segmenter.js";
import { createEngine, saveDiag } from "./engine.js";
import { createSpeakerEngine } from "./speakers.js";
import { HQ_MODELS, WHISPER_LANG } from "../lib/settings.js";

const SR = 16000;

// onResult({start, end, text, source}) a cada trecho transcrito; onStatus(patch) para progresso;
// onLevel(source, rms) a cada ~100 ms de áudio (para medidores de volume).
export function createPipeline({ onResult, onStatus = () => {}, onLevel } = {}) {
  const state = {
    modelKey: null,
    engine: null,
    speakers: null, // motor de identificação de falantes (opcional)
    queue: [],
    busy: false,
    streams: [],
    contexts: [],
    segmenters: [],
    stats: { segments: 0, audioMs: 0, workMs: 0 },
  };
  const report = (patch) => onStatus({ ...patch, queue: state.queue.length });

  async function addStream(stream, source) {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("src/offscreen/capture-worklet.js"));
    const node = new AudioWorkletNode(ctx, "escribanote-capture");
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
    // Relógio: amostra 0 corresponde a este instante (ms desde a época).
    const wall0 = Date.now() - ctx.currentTime * 1000;
    let index = 0;
    const seg = new Segmenter({
      sampleRate: SR,
      onSegment: (s) => {
        state.queue.push({ ...s, source, start: Math.round(wall0 + s.startSample / (SR / 1000)), end: Math.round(wall0 + s.endSample / (SR / 1000)) });
        // Se o computador não acompanhar, junta os segmentos mais antigos em vez de descartá-los.
        if (state.queue.length > 6) coalesceQueue();
        pump();
      },
    });
    node.port.onmessage = (e) => {
      seg.push(e.data, index);
      index += e.data.length;
      if (onLevel) {
        let sum = 0;
        for (let i = 0; i < e.data.length; i++) sum += e.data[i] * e.data[i];
        onLevel(source, Math.sqrt(sum / e.data.length));
      }
    };
    state.streams.push(stream);
    state.contexts.push(ctx);
    state.segmenters.push(seg);
  }

  // Junta pares de segmentos vizinhos da mesma fonte (até 28 s) para reduzir chamadas ao modelo.
  function coalesceQueue() {
    const q = state.queue;
    for (let i = 0; i < q.length - 1; i++) {
      const a = q[i];
      const b = q[i + 1];
      if (a.source !== b.source || b.end - a.start > 28_000) continue;
      const gap = Math.max(0, Math.round(((b.start - a.end) * SR) / 1000));
      const samples = new Float32Array(a.samples.length + Math.min(gap, SR) + b.samples.length);
      samples.set(a.samples);
      samples.set(b.samples, a.samples.length + Math.min(gap, SR));
      q.splice(i, 2, { ...a, samples, end: b.end });
      return;
    }
  }

  async function pump() {
    if (state.busy || !state.engine || !state.queue.length) return;
    state.busy = true;
    try {
      while (state.queue.length && state.engine) {
        const seg = state.queue.shift();
        const t0 = performance.now();
        // Com identificação de falantes, o trecho é dividido por voz e cada parte é transcrita
        // separadamente (falas de pessoas diferentes não se misturam num bloco só).
        let parts = [{ startMs: 0, endMs: seg.end - seg.start, samples: seg.samples, voice: null }];
        if (state.speakers) {
          try {
            parts = await state.speakers.split(seg.samples);
          } catch (err) {
            saveDiag({ speakersError: err.message || String(err) });
          }
        }
        for (const part of parts) {
          const text = await state.engine.transcribe(part.samples);
          if (text) onResult({ start: seg.start + part.startMs, end: seg.start + part.endMs, text, source: seg.source, ...(part.voice ? { voice: part.voice } : {}) });
        }
        state.stats.workMs += performance.now() - t0;
        state.stats.audioMs += (seg.samples.length / SR) * 1000;
        state.stats.segments++;
        // rtf < 1: transcreve mais rápido que o tempo real
        report({ state: "running", rtf: +(state.stats.workMs / Math.max(1, state.stats.audioMs)).toFixed(2), segments: state.stats.segments });
      }
    } catch (err) {
      saveDiag({ error: "transcrever: " + (err.message || String(err)) });
      report({ state: "error", message: "Falha ao transcrever: " + err.message });
    } finally {
      state.busy = false;
    }
  }

  async function loadEngine(modelKey, lang) {
    if (state.engine && state.modelKey === modelKey) return state.engine;
    if (state.engine) await state.engine.dispose();
    state.engine = null;
    state.modelKey = modelKey;
    const files = {};
    report({ state: "loading", progress: 0, model: modelKey });
    const engine = await createEngine({
      preset: HQ_MODELS[modelKey],
      language: WHISPER_LANG[(lang || "pt").slice(0, 2)] || "portuguese",
      onFallback: () =>
        report({ device: "wasm", warning: "A placa de vídeo deste computador não transcreveu corretamente; o Escribanote passou a usar o processador (mais lento, mas funciona)." }),
      onProgress: (p) => {
        files[p.file] = p;
        const list = Object.values(files);
        const total = list.reduce((a, f) => a + (f.total || 0), 0);
        const loaded = list.reduce((a, f) => a + (f.loaded || 0), 0);
        report({ state: "loading", progress: total ? Math.round((loaded / total) * 100) : 0 });
      },
    });
    state.engine = engine;
    return engine;
  }

  // Modelos de identificação de falantes (pyannote + WeSpeaker). Rodam no processador: são
  // pequenos e a placa de vídeo fica com o Whisper.
  async function loadSpeakers() {
    if (state.speakers) return state.speakers;
    const files = {};
    report({ state: "loading", progress: 0, model: "falantes" });
    state.speakers = await createSpeakerEngine({
      device: "wasm",
      onProgress: (p) => {
        files[p.file] = p;
        const list = Object.values(files);
        const total = list.reduce((a, f) => a + (f.total || 0), 0);
        const loaded = list.reduce((a, f) => a + (f.loaded || 0), 0);
        report({ state: "loading", progress: total ? Math.round((loaded / total) * 100) : 0, model: "falantes" });
      },
    });
    return state.speakers;
  }

  async function unloadSpeakers() {
    if (!state.speakers) return;
    await state.speakers.dispose().catch(() => {});
    state.speakers = null;
  }

  // Começa a transcrever o que já foi (e será) segmentado; o áudio capturado durante o
  // carregamento do modelo fica na fila, então nada se perde.
  async function run(modelKey, lang, { diarize = false } = {}) {
    state.stats = { segments: 0, audioMs: 0, workMs: 0 };
    const engine = await loadEngine(modelKey, lang);
    if (diarize) {
      try {
        await loadSpeakers();
      } catch (err) {
        saveDiag({ speakersError: err.message || String(err) });
        report({ warning: "Não deu para carregar os modelos de identificação de falantes (" + err.message + "). A transcrição segue sem eles." });
      }
    } else await unloadSpeakers();
    report({ state: "running", device: engine.device, progress: 100, speakers: !!state.speakers });
    pump();
    return engine;
  }

  async function stopCapture() {
    for (const s of state.segmenters) s.flush();
    for (const st of state.streams) st.getTracks().forEach((t) => t.stop());
    for (const c of state.contexts) await c.close().catch(() => {});
    state.streams = [];
    state.contexts = [];
    state.segmenters = [];
  }

  // Para a captura e termina o que já estava na fila.
  async function stop() {
    await stopCapture();
    await pump();
  }

  // Espera a fila esvaziar (usado ao parar o gravador, para não perder o fim da conversa).
  async function drain() {
    while (state.engine && (state.busy || state.queue.length)) {
      if (!state.busy) pump();
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  function reset() {
    state.queue = [];
  }

  return { addStream, loadEngine, loadSpeakers, run, stop, stopCapture, drain, reset, pump, get busy() { return state.busy || state.queue.length > 0; }, get speakers() { return state.speakers; } };
}
