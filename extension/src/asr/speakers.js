// Identificação de falantes pela voz (diarização local): o pyannote segmenta cada trecho em
// turnos de fala e o WeSpeaker gera uma "impressão digital" (embedding) de cada turno. Vozes
// parecidas viram o mesmo falante ("voz:1", "voz:2"…) ao longo da reunião. Tudo roda no
// computador, com os mesmos modelos ONNX do transformers.js empacotado; nada sai da máquina.
import { AutoProcessor, AutoModelForAudioFrameClassification, WeSpeakerResNetModel, WeSpeakerFeatureExtractor } from "../../vendor/transformers/transformers.min.js";

export const SPEAKER_MODELS = {
  segmentation: "onnx-community/pyannote-segmentation-3.0", // ~6 MB
  embedding: "onnx-community/wespeaker-voxceleb-resnet34-LM", // ~26 MB
};

const SR = 16000;
const MIN_TURN_MS = 700; // turnos mais curtos não têm voz suficiente para comparar
const SAME_VOICE = 0.45; // similaridade de cosseno a partir da qual é a mesma pessoa
const NEW_VOICE_BELOW = 0.35; // abaixo disto é certamente outra pessoa; entre os dois, fica com a mais parecida

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Agrupa embeddings em vozes conhecidas, atualizando a média de cada voz (centroide).
export class VoiceBook {
  constructor({ same = SAME_VOICE, newBelow = NEW_VOICE_BELOW } = {}) {
    this.voices = []; // {id, centroid: Float32Array, n}
    this.same = same;
    this.newBelow = newBelow;
  }
  // Devolve o id da voz ("voz:N"); cria uma nova quando nenhuma conhecida é parecida.
  assign(embedding) {
    let best = null;
    for (const v of this.voices) {
      const sim = cosine(v.centroid, embedding);
      if (!best || sim > best.sim) best = { v, sim };
    }
    if (best && best.sim >= this.newBelow && (best.sim >= this.same || this.voices.length >= 8)) {
      const v = best.v;
      for (let i = 0; i < v.centroid.length; i++) v.centroid[i] = (v.centroid[i] * v.n + embedding[i]) / (v.n + 1);
      v.n++;
      return v.id;
    }
    const id = `voz:${this.voices.length + 1}`;
    this.voices.push({ id, centroid: Float32Array.from(embedding), n: 1 });
    return id;
  }
  get size() {
    return this.voices.length;
  }
}

// Carrega os dois modelos (baixados uma vez, ficam no cache do navegador).
export async function createSpeakerEngine({ device = "wasm", onProgress } = {}) {
  const progress_callback = (p) => {
    if (p.status === "progress" && onProgress) onProgress({ file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
  };
  const opts = { device, dtype: "fp32", session_options: { logSeverityLevel: 3 }, progress_callback };
  const [segProcessor, segModel, embExtractor, embModel] = await Promise.all([
    AutoProcessor.from_pretrained(SPEAKER_MODELS.segmentation, { progress_callback }),
    AutoModelForAudioFrameClassification.from_pretrained(SPEAKER_MODELS.segmentation, opts),
    WeSpeakerFeatureExtractor.from_pretrained(SPEAKER_MODELS.embedding, { progress_callback }),
    WeSpeakerResNetModel.from_pretrained(SPEAKER_MODELS.embedding, opts),
  ]);
  const book = new VoiceBook();

  // Turnos de fala de um trecho (amostras mono 16 kHz): [{start, end, label}] em ms relativos ao trecho.
  async function turns(samples) {
    const inputs = await segProcessor(samples);
    const { logits } = await segModel(inputs);
    const [frames] = segProcessor.post_process_speaker_diarization(logits, samples.length);
    const out = [];
    for (const f of frames) {
      if (f.id === 0) continue; // 0 = silêncio/ruído no pyannote-segmentation-3.0
      const start = Math.round(f.start * 1000);
      const end = Math.round(f.end * 1000);
      const last = out[out.length - 1];
      if (last && last.label === f.id && start - last.end < 300) last.end = end;
      else out.push({ start, end, label: f.id });
    }
    return out.filter((t) => t.end - t.start >= MIN_TURN_MS);
  }

  async function embed(samples) {
    const inputs = await embExtractor(samples);
    const out = await embModel(inputs);
    // o nome da saída varia com a exportação ONNX ("embeddings", "logits"…): pega o primeiro tensor
    const tensor = out.embeddings ?? out.logits ?? out[Object.keys(out)[0]];
    if (!tensor?.data) throw new Error("saída inesperada do modelo de voz: " + Object.keys(out).join(","));
    return Float32Array.from(tensor.data);
  }

  // Divide o trecho em partes por falante: [{startMs, endMs, voice, samples}].
  // Com uma voz só (o caso comum), devolve uma parte com o trecho inteiro.
  async function split(samples) {
    const t = await turns(samples);
    const labels = [...new Set(t.map((x) => x.label))];
    if (labels.length <= 1) {
      const voice = book.assign(await embed(samples));
      return [{ startMs: 0, endMs: Math.round((samples.length / SR) * 1000), voice, samples }];
    }
    // Vários falantes no mesmo trecho: cada turno vira uma parte com a própria voz.
    const parts = [];
    for (const x of t) {
      const piece = samples.subarray(Math.round((x.start * SR) / 1000), Math.round((x.end * SR) / 1000));
      if (piece.length < SR * 0.5) continue;
      const voice = book.assign(await embed(piece));
      const last = parts[parts.length - 1];
      if (last && last.voice === voice && x.start - last.endMs < 600) {
        last.endMs = x.end;
        last.samples = samples.subarray(Math.round((last.startMs * SR) / 1000), Math.round((x.end * SR) / 1000));
      } else parts.push({ startMs: x.start, endMs: x.end, voice, samples: piece });
    }
    return parts.length ? parts : [{ startMs: 0, endMs: Math.round((samples.length / SR) * 1000), voice: book.assign(await embed(samples)), samples }];
  }

  return {
    turns,
    embed,
    split,
    book,
    async dispose() {
      await Promise.all([segModel.dispose?.(), embModel.dispose?.()].map((p) => p?.catch?.(() => {})));
    },
  };
}
