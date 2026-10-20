// Motor Whisper local (transformers.js + ONNX Runtime Web), empacotado na extensão.
// O modelo é baixado do Hugging Face na primeira vez e fica no cache do navegador.
import { pipeline, env } from "../../vendor/transformers/transformers.min.js";
import { cleanTranscript } from "./segmenter.js";

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
// Sem isolamento de origem não há SharedArrayBuffer: roda numa thread só.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// Avisos inofensivos que poluiriam a página de erros da extensão (chrome://extensions):
// - o Chrome no Windows ignora powerPreference e avisa a cada requestAdapter();
// - o ONNX Runtime avisa que operações pequenas de forma rodam no processador (proposital);
// - o download do modelo às vezes vem sem Content-Length (só muda a alocação do buffer).
env.backends.onnx.logLevel = "error";
if (env.backends.onnx.webgpu) env.backends.onnx.webgpu.powerPreference = undefined;
const QUIET = ["Unable to determine content-length", "VerifyEachNodeIsAssignedToAnEp"];
const quiet = (fn) => (...args) => {
  if (typeof args[0] === "string" && QUIET.some((q) => args[0].includes(q))) return;
  fn(...args);
};
// o ONNX Runtime escreve os avisos nativos pelo console.error
console.warn = quiet(console.warn.bind(console));
console.error = quiet(console.error.bind(console));

export async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

// Trecho de fala de referência (3,6 s, Wikipédia Falada, CC0): "...da América do Sul e da região da
// América Latina...". Serve para conferir se o modelo transcreve de verdade neste computador.
let clipCache = null;
export async function speechClip() {
  if (!clipCache) {
    const buf = await (await fetch(chrome.runtime.getURL("src/asr/fala-teste.pcm"))).arrayBuffer();
    const pcm = new Int16Array(buf);
    clipCache = Float32Array.from(pcm, (v) => v / 32768);
  }
  return clipCache;
}
const clipOk = (text) => {
  const t = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return t.includes("america") && (t.includes("sul") || t.includes("latina"));
};

async function gpuInfo() {
  try {
    const a = await navigator.gpu.requestAdapter();
    const i = a.info || (await a.requestAdapterInfo?.()) || {};
    return [i.vendor, i.architecture, i.description].filter(Boolean).join(" / ") || "?";
  } catch {
    return "?";
  }
}

// Diagnóstico guardado em chrome.storage.local ("asrDiag") para investigar problemas depois.
// O documento offscreen não tem chrome.storage: lá o registro vai pelo service worker.
export async function saveDiag(patch) {
  try {
    if (!chrome.storage?.local) return await chrome.runtime.sendMessage({ type: "asr-diag", patch });
    const { asrDiag = {} } = await chrome.storage.local.get("asrDiag");
    await chrome.storage.local.set({ asrDiag: { ...asrDiag, ...patch, at: Date.now() } });
  } catch {}
}

// preset: um item de HQ_MODELS. onProgress recebe {file, progress (0-100), loaded, total}.
// Na placa de vídeo (WebGPU) o modelo é conferido com o trecho de referência: se não transcrever
// direito, ou falhar depois, o motor passa sozinho para o processador (WASM) e chama onFallback.
export async function createEngine({ preset, language = "portuguese", onProgress, forceDevice, onFallback }) {
  const gpu = forceDevice ? forceDevice === "webgpu" : await hasWebGPU();
  let device = gpu && preset.webgpu ? "webgpu" : "wasm";
  if (!preset[device]) throw new Error("Este modelo precisa de uma placa de vídeo com WebGPU. Escolha o modo Rápido ou Equilibrado.");

  const load = (dev) =>
    pipeline("automatic-speech-recognition", preset.id, {
      device: dev,
      dtype: preset[dev].dtype,
      session_options: { logSeverityLevel: 3 }, // só erros do ONNX Runtime
      progress_callback: (p) => {
        if (p.status === "progress") onProgress?.({ file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
      },
    });
  const run = async (asr, samples, lang = language) => {
    const out = await asr(samples, { language: lang, task: "transcribe", chunk_length_s: 30, stride_length_s: 0 });
    return cleanTranscript(Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text);
  };

  let asr = await load(device);
  let check = null;
  const diag = { model: preset.id, gpu: gpu ? await gpuInfo() : "sem WebGPU", fallback: null, error: null };

  async function toWasm(reason) {
    diag.fallback = reason;
    if (!preset.wasm) {
      diag.error = reason;
      saveDiag(diag);
      throw new Error(`A placa de vídeo falhou (${reason}) e este modelo não roda no processador. Escolha o modo Rápido ou Equilibrado.`);
    }
    await asr.dispose?.().catch(() => {});
    device = "wasm";
    asr = await load("wasm");
    onFallback?.(reason);
  }

  if (device === "webgpu" && !forceDevice) {
    try {
      const t0 = performance.now();
      const text = await run(asr, await speechClip(), "portuguese");
      check = { device: "webgpu", text, ms: Math.round(performance.now() - t0) };
      if (!clipOk(text)) await toWasm(`transcreveu o teste como "${text.slice(0, 60)}"`);
    } catch (err) {
      if (device === "webgpu") await toWasm(err.message || String(err));
      else throw err;
    }
  }
  diag.device = device;
  diag.check = check;
  saveDiag(diag);

  return {
    get device() {
      return device;
    },
    check,
    async transcribe(samples) {
      try {
        return await run(asr, samples);
      } catch (err) {
        if (device !== "webgpu") throw err;
        await toWasm(err.message || String(err)); // erro da placa no meio da conversa: segue no processador
        saveDiag(diag);
        return run(asr, samples);
      }
    },
    // Transcreve o trecho de referência (diagnóstico em Ajustes).
    async selfTest() {
      const t0 = performance.now();
      const text = await run(asr, await speechClip(), "portuguese");
      return { text, ok: clipOk(text), device, ms: Math.round(performance.now() - t0), fallback: diag.fallback };
    },
    async dispose() {
      await asr.dispose?.();
    },
  };
}
