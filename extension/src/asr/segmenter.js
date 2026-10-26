// Segmentador de voz por energia (VAD simples), em amostras mono de 16 kHz.
// Corta nas pausas; se a pessoa fala sem parar, corta no ponto mais silencioso
// dos últimos segundos para não partir palavras no meio.
//
// O limiar de fala é por faixa (`profile`):
// - "mic": margem acima do piso de ruído proporcional à distância entre o nível de fala (percentil 95
//   dos últimos 20 s) e o piso (percentil 10), limitada entre 3 e 12 dB. Uma margem fixa de 12 dB
//   perdia fala em microfone ruidoso; uma margem fixa pequena deixava o ruído virar "fala".
// - "tab" (os outros, áudio da aba ou do computador): barra fixa de 4x o piso.
// Em ambos, nunca abaixo de MIN_SPEECH_RMS (abaixo disso só há alucinação).
const MIN_SPEECH_RMS = 0.003;
const HISTORY_FRAMES = 667; // ~20 s

export class Segmenter {
  constructor({ sampleRate = 16000, onSegment, onFrame, profile = "tab", maxSec = 14, minSpeechMs = 350, endSilenceMs = 650, prerollMs = 300 } = {}) {
    this.sr = sampleRate;
    this.frame = Math.round(sampleRate * 0.03); // 30 ms
    this.onSegment = onSegment;
    this.onFrame = onFrame;
    this.profile = profile;
    this.maxFrames = Math.round((maxSec * 1000) / 30);
    this.minSpeechFrames = Math.round(minSpeechMs / 30);
    this.endSilenceFrames = Math.round(endSilenceMs / 30);
    this.prerollFrames = Math.round(prerollMs / 30);
    this.noise = 0.004;
    this.history = new Float32Array(HISTORY_FRAMES);
    this.histLen = 0;
    this.histPos = 0;
    this.framesSeen = 0;
    this.threshold = 0.01;
    this.pending = new Float32Array(0);
    this.pendingStart = 0; // índice (em amostras) do primeiro item de `pending`
    this.preroll = []; // [{samples, start, rms}]
    this.seg = null; // {frames: [{samples, start, rms, speech}], silence, speech}
  }

  // Recalcula o limiar a cada 30 quadros a partir do histórico (percentis 10 e 95).
  _updateThreshold() {
    const n = this.histLen;
    if (n < 30) return;
    const sorted = Array.from(this.history.subarray(0, n)).sort((a, b) => a - b);
    // Piso: o percentil 10 do histórico, mas nunca acima do rastreador de ruído (numa fala contínua
    // de 20 s o percentil 10 seria a própria fala, e nada mais contaria como voz).
    const floor = Math.max(Math.min(sorted[Math.floor(n * 0.1)], this.noise), 0.0005);
    if (this.profile === "mic") {
      const speech = sorted[Math.floor(n * 0.95)];
      const gapDb = 20 * Math.log10(Math.max(speech, floor * 1.001) / floor);
      const marginDb = Math.min(12, Math.max(3, gapDb / 3));
      this.threshold = Math.max(floor * Math.pow(10, marginDb / 20), MIN_SPEECH_RMS);
    } else {
      this.threshold = Math.max(floor * 4, MIN_SPEECH_RMS);
    }
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
    // Piso de ruído: desce rápido, sobe devagar (reação imediata; o histórico refina o limiar).
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 1.0015;
    this.noise = Math.min(Math.max(this.noise, 0.0015), 0.05);
    this.history[this.histPos] = rms;
    this.histPos = (this.histPos + 1) % HISTORY_FRAMES;
    if (this.histLen < HISTORY_FRAMES) this.histLen++;
    if (++this.framesSeen % 30 === 0) this._updateThreshold();
    // Enquanto o histórico é curto, vale a regra antiga (piso x3, mínimo 0,01) para não disparar com ruído.
    const bar = this.histLen < 100 ? Math.max(0.01, this.noise * 3) : Math.max(this.threshold, this.noise * 2);
    const speech = rms > bar;
    const f = { samples, start, rms, speech };
    this.onFrame?.(start, rms, speech);

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
      const levels = Float32Array.from(frames, (f) => f.rms);
      const speechMask = Uint8Array.from(frames, (f) => (f.speech ? 1 : 0));
      let acc = 0;
      for (const f of frames) if (f.speech) acc += f.rms * f.rms;
      const speechRms = Math.sqrt(acc / Math.max(1, voiced));
      this.onSegment?.({ samples, startSample, endSample: startSample + samples.length, voicedRatio: voiced / frames.length, levels, speechMask, speechRms });
    }
    this.seg = rest.length ? { frames: rest, silence: 0, speech: rest.filter((f) => f.speech).length } : null;
  }
}

// Frases que o Whisper costuma "inventar" em silêncio ou ruído: sempre descartadas.
const HALLUCINATIONS = [
  /legendas? (pela|por|da) comunidade/i,
  /amara\.org/i,
  /^(obrigad[oa]|thank you|thanks)[.,!]* ?(por assistir|for watching)/i,
  /inscreva-se|deixe seu like|ative o sininho/i,
  /^\W*$/,
];
// Frases prontas de legenda ("obrigado", "tchau"): também são ditas de verdade, então só caem
// quando o trecho inteiro é a frase e o áudio estava baixo (ver isStockPhrase + nível no pipeline).
const STOCK_PHRASES = /^(obrigad[oa]|tchau|valeu|até (logo|mais|a próxima)|thank you|thanks|bye|legendas?|subtitles?( by)?)[.!…]*( (por assistir|pela aten[cç][aã]o|for watching))?[.!…]*$/i;
export const isStockPhrase = (t) => STOCK_PHRASES.test((t || "").trim());
// "[música]", "(risos)", "*aplausos*" ou texto sem letras nem números.
export const isNoiseMarker = (t) => {
  const s = (t || "").trim();
  return !s || /^[\[(*].*[\])*]$/.test(s) || !/[\p{L}\p{N}]/u.test(s);
};

// Limpa o texto do Whisper: descarta alucinações conhecidas e repetições em loop.
export function cleanTranscript(text) {
  let t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || HALLUCINATIONS.some((re) => re.test(t)) || isNoiseMarker(t)) return "";
  // "a a a a a" / "sim, sim, sim, sim, sim" -> no máximo 3 repetições seguidas
  t = t.replace(/\b(\p{L}+(?:[,.]?\s+\p{L}+){0,3})(?:[,.]?\s+\1\b){3,}/giu, "$1 $1 $1");
  return t;
}

// Nivelamento: traz a fala do trecho para a mesma intensidade (alvo em RMS dos quadros com fala),
// com ganho limitado e sem estourar o pico. Devolve uma cópia; não altera o original.
export const LEVEL_TARGET_RMS = 0.08;
export function levelSamples(samples, speechRms) {
  if (!speechRms || speechRms <= 0) return samples;
  let gain = Math.min(8, Math.max(0.5, LEVEL_TARGET_RMS / speechRms));
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  if (peak * gain > 0.95) gain = 0.95 / peak;
  if (Math.abs(gain - 1) < 0.05) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

// Filtro de eco por energia: um quadro do microfone só conta como fala própria se a sua energia for ao
// menos metade da maior energia da faixa dos outros nos quadros vizinhos (±around ms). Devolve a fração
// dos quadros de fala do trecho que passam; abaixo de ECHO_KEEP_RATIO o trecho é eco da caixa de som.
export const ECHO_KEEP_RATIO = 0.4;
export function ownSpeechRatio(seg, segStartMs, otherLevels, { frameMs = 30, around = 90 } = {}) {
  // otherLevels: {t: number[], rms: number[]} ordenados por t (ms)
  const { levels, speechMask } = seg;
  if (!levels || !speechMask || !otherLevels || !otherLevels.t.length) return 1;
  let speech = 0, own = 0;
  let lo = 0;
  for (let i = 0; i < levels.length; i++) {
    if (!speechMask[i]) continue;
    speech++;
    const t = segStartMs + i * frameMs;
    while (lo < otherLevels.t.length && otherLevels.t[lo] < t - around) lo++;
    let loudest = 0;
    for (let j = lo; j < otherLevels.t.length && otherLevels.t[j] <= t + around; j++) if (otherLevels.rms[j] > loudest) loudest = otherLevels.rms[j];
    if (levels[i] * 2 >= loudest) own++;
  }
  return speech ? own / speech : 1;
}
