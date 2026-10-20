// Segmentador de voz por energia (VAD simples), em amostras mono de 16 kHz.
// Corta nas pausas; se a pessoa fala sem parar, corta no ponto mais silencioso
// dos últimos segundos para não partir palavras no meio.

export class Segmenter {
  constructor({ sampleRate = 16000, onSegment, maxSec = 14, minSpeechMs = 350, endSilenceMs = 650, prerollMs = 300 } = {}) {
    this.sr = sampleRate;
    this.frame = Math.round(sampleRate * 0.03); // 30 ms
    this.onSegment = onSegment;
    this.maxFrames = Math.round((maxSec * 1000) / 30);
    this.minSpeechFrames = Math.round(minSpeechMs / 30);
    this.endSilenceFrames = Math.round(endSilenceMs / 30);
    this.prerollFrames = Math.round(prerollMs / 30);
    this.noise = 0.004;
    this.pending = new Float32Array(0);
    this.pendingStart = 0; // índice (em amostras) do primeiro item de `pending`
    this.preroll = []; // [{samples, start, rms}]
    this.seg = null; // {frames: [{samples, start, rms, speech}], silence, speech}
  }

  // Recebe áudio contínuo. `startSample` é o índice absoluto da 1ª amostra.
  push(samples, startSample) {
    if (!this.pending.length) this.pendingStart = startSample;
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let off = 0;
    while (merged.length - off >= this.frame) {
      this._frame(merged.subarray(off, off + this.frame).slice(), this.pendingStart + off);
      off += this.frame;
    }
    this.pending = merged.slice(off);
    this.pendingStart += off;
  }

  // Força o fim do segmento atual (ex.: ao parar a captura).
  flush() {
    if (this.seg) this._emit(this.seg.frames.length);
  }

  _frame(samples, start) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    // Piso de ruído: desce rápido, sobe devagar.
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 1.0015;
    this.noise = Math.min(Math.max(this.noise, 0.0015), 0.05);
    const speech = rms > Math.max(0.01, this.noise * 3);
    const f = { samples, start, rms, speech };

    if (!this.seg) {
      this.preroll.push(f);
      if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      if (speech) {
        this.seg = { frames: this.preroll, silence: 0, speech: 1 };
        this.preroll = [];
      }
      return;
    }
    const seg = this.seg;
    seg.frames.push(f);
    if (speech) {
      seg.speech++;
      seg.silence = 0;
    } else seg.silence++;

    if (seg.silence >= this.endSilenceFrames) {
      // termina deixando ~200 ms de silêncio no fim
      this._emit(seg.frames.length - seg.silence + Math.round(200 / 30));
    } else if (seg.frames.length >= this.maxFrames) {
      // fala contínua: corta no frame mais silencioso dos últimos 3 s
      const from = Math.max(1, seg.frames.length - Math.round(3000 / 30));
      let cut = seg.frames.length;
      let min = Infinity;
      for (let i = from; i < seg.frames.length; i++) {
        if (seg.frames[i].rms < min) {
          min = seg.frames[i].rms;
          cut = i;
        }
      }
      this._emit(cut, true);
    }
  }

  // Emite os primeiros `n` frames; com `keepRest`, o restante abre o próximo segmento.
  _emit(n, keepRest = false) {
    const seg = this.seg;
    const frames = seg.frames.slice(0, Math.max(1, n));
    const rest = keepRest ? seg.frames.slice(n) : [];
    const voiced = frames.filter((f) => f.speech).length;
    if (voiced >= this.minSpeechFrames) {
      const samples = new Float32Array(frames.length * this.frame);
      frames.forEach((f, i) => samples.set(f.samples, i * this.frame));
      const startSample = frames[0].start;
      this.onSegment?.({ samples, startSample, endSample: startSample + samples.length, voicedRatio: voiced / frames.length });
    }
    this.seg = rest.length ? { frames: rest, silence: 0, speech: rest.filter((f) => f.speech).length } : null;
  }
}

// Frases que o Whisper costuma "inventar" em silêncio ou ruído.
const HALLUCINATIONS = [
  /legendas? (pela|por|da) comunidade/i,
  /amara\.org/i,
  /^(obrigad[oa]|tchau|valeu)[.!]*( (por assistir|pela aten[cç][aã]o))?[.!]*$/i,
  /inscreva-se|deixe seu like|ative o sininho/i,
  /^\W*$/,
];

// Limpa o texto do Whisper: descarta alucinações conhecidas e repetições em loop.
export function cleanTranscript(text) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || HALLUCINATIONS.some((re) => re.test(t))) return "";
  // "a a a a a" / "sim, sim, sim, sim, sim" -> no máximo 3 repetições seguidas
  t = t.replace(/\b(\p{L}+(?:[,.]?\s+\p{L}+){0,3})(?:[,.]?\s+\1\b){3,}/giu, "$1 $1 $1");
  return t;
}
