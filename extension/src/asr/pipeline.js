// Pipeline de reconhecimento local: recebe MediaStreams de áudio, segmenta por pausas e
// transcreve com o Whisper. Usado pelo documento offscreen (áudio da aba da reunião) e pelo
// gravador (áudio do computador, para apps como o Slack). O áudio nunca sai do computador.
import { Segmenter } from "./segmenter.js";
import { createEngine, saveDiag } from "./engine.js";
import { createSpeakerEngine } from "./speakers.js";
import { HQ_MODELS, WHISPER_LANG } from "../lib/settings.js";

const SR = 16000;

// onResult({start, end, text, source}) a cada trecho transcrito; onStatus(patch) para progresso;
// onLevel(source, rms) a cada ~100 ms de áudio (para medidores de volume);
// onEvent(kind, detail) para o relatório de sessão (modelo carregado, fonte trocada, erros, totais).
export function createPipeline({ onResult, onStatus = () => {}, onLevel, onEvent = () => {} } = {}) {
  const state = {
    modelKey: null,
    engine: null,
    speakers: null, // motor de identificação de falantes (opcional)
    queue: [],
    busy: false,
    inputs: [], // {source, stream, ctx, node, src}
    segmenters: [],
    stats: { segments: 0, audioMs: 0, workMs: 0, coalesced: 0 },
  };
  const report = (patch) => onStatus({ ...patch, queue: state.queue.length });
  const emit = (kind, detail) => { try { onEvent(kind, detail); } catch {} };

  async function addStream(stream, source) {
    const ctx = new AudioContext({ sampleRate: SR });
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("src/offscreen/capture-worklet.js"));
    const node = new AudioWorkletNode(ctx, "escribanote-capture");
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node).connect(mute).connect(ctx.destination);
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
    state.inputs.push({ source, stream, ctx, node, src });
    state.segmenters.push(seg);
    emit("source-added", { source, label: trackLabel(stream) });
  }

  // Troca a fonte de áudio de uma entrada já ligada (ex.: o microfone padrão mudou). O relógio e o
  // segmentador continuam os mesmos: o tempo sem fonte virou silêncio no worklet, então os horários batem.
  function replaceStream(source, stream) {
    const inp = state.inputs.find((i) => i.source === source);
    if (!inp) return false;
    try { inp.src.disconnect(); } catch {}
    inp.stream.getTracks().forEach((t) => t.stop());
    inp.stream = stream;
    inp.src = inp.ctx.createMediaStreamSource(stream);
    inp.src.connect(inp.node);
    emit("source-replaced", { source, label: trackLabel(stream) });
    return true;
  }

  // Fonte offline (benchmark e retranscrição): amostras prontas com horário absoluto `t0` (ms) para
  // a amostra 0. Devolve push(samples); use flushSources() + drain() ao terminar.
  function addOfflineSource(source, t0) {
    let index = 0;
    const seg = new Segmenter({
      sampleRate: SR,
      onSegment: (s) => {
        state.queue.push({ ...s, source, start: Math.round(t0 + s.startSample / (SR / 1000)), end: Math.round(t0 + s.endSample / (SR / 1000)) });
        pump();
      },
    });
    state.segmenters.push(seg);
    return (samples) => {
      const CHUNK = SR; // 1 s por vez, para o segmentador trabalhar como ao vivo
      for (let off = 0; off < samples.length; off += CHUNK) {
        const part = samples.subarray(off, Math.min(samples.length, off + CHUNK));
        seg.push(part, index);
        index += part.length;
      }
    };
  }

  function flushSources() {
    for (const s of state.segmenters) s.flush();
  }

  // Fonte que entrega amostras prontas (mono 16 kHz), como o ajudante nativo do Windows. Devolve
  // push(Float32Array). O relógio é o de parede: se o ajudante ficou um tempo sem mandar áudio
  // (o Windows não entrega nada quando o computador está em silêncio), o buraco vira silêncio,
  // para os horários das falas continuarem certos.
  function addPushSource(source) {
    const wall0 = Date.now();
    let index = 0;
    const seg = new Segmenter({
      sampleRate: SR,
      onSegment: (s) => {
        state.queue.push({ ...s, source, start: Math.round(wall0 + s.startSample / (SR / 1000)), end: Math.round(wall0 + s.endSample / (SR / 1000)) });
        if (state.queue.length > 6) coalesceQueue();
        pump();
      },
    });
    state.segmenters.push(seg);
    return (samples) => {
      const expected = Math.round(((Date.now() - wall0) * SR) / 1000) - samples.length;
      const gap = expected - index;
      if (gap > SR * 0.15) {
        const fill = Math.min(gap, SR * 30);
        seg.push(new Float32Array(fill), index);
        index += fill;
      }
      seg.push(samples, index);
      index += samples.length;
      if (onLevel) {
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        onLevel(source, Math.sqrt(sum / samples.length));
      }
    };
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
      state.stats.coalesced++;
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
      emit("transcribe-error", { message: err.message || String(err) });
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
    const t0 = performance.now();
    report({ state: "loading", progress: 0, model: modelKey });
    const engine = await createEngine({
      preset: HQ_MODELS[modelKey],
      language: WHISPER_LANG[(lang || "pt").slice(0, 2)] || "portuguese",
      onFallback: (reason) => {
        emit("engine-fallback", { reason: String(reason || "").slice(0, 200) });
        report({ device: "wasm", warning: "A placa de vídeo deste computador não transcreveu corretamente; o Escribanote passou a usar o processador (mais lento, mas funciona)." });
      },
      onProgress: (p) => {
        files[p.file] = p;
        const list = Object.values(files);
        const total = list.reduce((a, f) => a + (f.total || 0), 0);
        const loaded = list.reduce((a, f) => a + (f.loaded || 0), 0);
        report({ state: "loading", progress: total ? Math.round((loaded / total) * 100) : 0 });
      },
    });
    state.engine = engine;
    emit("engine-loaded", { model: modelKey, device: engine.device, loadMs: Math.round(performance.now() - t0), check: engine.check ? { ok: true, ms: engine.check.ms } : null });
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
        emit("speakers-loaded", {});
      } catch (err) {
        saveDiag({ speakersError: err.message || String(err) });
        emit("speakers-error", { message: err.message || String(err) });
        report({ warning: "Não deu para carregar os modelos de identificação de falantes (" + err.message + "). A transcrição segue sem eles." });
      }
    } else await unloadSpeakers();
    report({ state: "running", device: engine.device, progress: 100, speakers: !!state.speakers });
    pump();
    return engine;
  }

  async function stopCapture() {
    for (const s of state.segmenters) s.flush();
    for (const i of state.inputs) i.stream.getTracks().forEach((t) => t.stop());
    for (const i of state.inputs) await i.ctx.close().catch(() => {});
    if (state.inputs.length || state.segmenters.length) emit("capture-stopped", { ...state.stats, rtf: +(state.stats.workMs / Math.max(1, state.stats.audioMs)).toFixed(2) });
    state.inputs = [];
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

  return { addStream, replaceStream, addOfflineSource, flushSources, addPushSource, loadEngine, loadSpeakers, run, stop, stopCapture, drain, reset, pump, get busy() { return state.busy || state.queue.length > 0; }, get speakers() { return state.speakers; }, get stats() { return state.stats; } };
}

function trackLabel(stream) {
  const t = stream.getAudioTracks()[0];
  return t ? (t.label || "").slice(0, 80) : "";
}
