// Agrupamento de vozes ao vivo ("voz:1", "voz:2"…) a partir das impressões de voz do WeSpeaker.
// Sem dependências: roda no offscreen e nos testes do Node.
//
// Por que não basta "a mais parecida": um turno curto ou ruidoso no começo vira um centroide ruim e a
// mesma pessoa ganha uma segunda voz; depois, as duas vozes convergem e nada as junta. Daí três regras
// (ideias do diart e do pyannote):
// 1. o centroide é a média ponderada pelos segundos de fala: turno curto pesa pouco;
// 2. duas vozes com fala suficiente e centroides parecidos viram uma só (consolidação ao vivo);
// 3. no fim, voz com pouquíssima fala é absorvida pela mais parecida, se for plausível.
// As junções ficam registradas (takeMerges) para a sessão remapear as falas já gravadas.

export const SAME_VOICE = 0.45; // similaridade de cosseno a partir da qual é a mesma pessoa
export const NEW_VOICE_BELOW = 0.35; // abaixo disto é certamente outra pessoa; entre os dois, fica com a mais parecida
export const MERGE_AT = 0.6; // centroides com pelo menos isto de similaridade são a mesma pessoa
const MERGE_MIN_S = 3; // só consolida vozes com pelo menos 3 s de fala cada (centroide estável)
const SMALL_S = 4; // no fim, voz com menos de 4 s de fala é candidata a ser absorvida
const MAX_VOICES = 8;

export function cosine(a, b) {
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

// Peso de um turno: os segundos de fala, entre 0,5 e 10 (um monólogo não domina para sempre).
const weightOf = (ms) => Math.min(10, Math.max(0.5, (Number.isFinite(ms) ? ms : 2000) / 1000));

export class VoiceBook {
  constructor({ same = SAME_VOICE, newBelow = NEW_VOICE_BELOW, mergeAt = MERGE_AT, maxVoices = MAX_VOICES } = {}) {
    this.voices = []; // {id, sum: Float32Array, centroid: Float32Array, w (segundos), n (turnos)}
    this.alias = {}; // voz absorvida -> voz que ficou
    this.merges = []; // [{from, to}] ainda não entregues
    this.same = same;
    this.newBelow = newBelow;
    this.mergeAt = mergeAt;
    this.maxVoices = maxVoices;
    this.next = 1;
  }

  resolve(id) {
    for (let i = 0; i < 16 && this.alias[id]; i++) id = this.alias[id];
    return id;
  }

  // Devolve o id da voz deste turno; cria uma nova quando nenhuma conhecida é parecida.
  // durMs: duração da fala do turno (pesa no centroide).
  assign(embedding, durMs) {
    let best = null;
    for (const v of this.voices) {
      const sim = cosine(v.centroid, embedding);
      if (!best || sim > best.sim) best = { v, sim };
    }
    const w = weightOf(durMs);
    let v;
    if (best && best.sim >= this.newBelow && (best.sim >= this.same || this.voices.length >= this.maxVoices)) {
      v = best.v;
      for (let i = 0; i < v.sum.length; i++) v.sum[i] += embedding[i] * w;
      v.w += w;
      v.n++;
      this.#recenter(v);
    } else {
      v = { id: `voz:${this.next++}`, sum: Float32Array.from(embedding, (x) => x * w), centroid: Float32Array.from(embedding), w, n: 1 };
      this.voices.push(v);
    }
    this.consolidate();
    return this.resolve(v.id);
  }

  #recenter(v) {
    for (let i = 0; i < v.sum.length; i++) v.centroid[i] = v.sum[i] / v.w;
  }

  // Junta `from` em `to` (somando a fala) e registra a junção.
  #merge(from, to) {
    for (let i = 0; i < to.sum.length; i++) to.sum[i] += from.sum[i];
    to.w += from.w;
    to.n += from.n;
    this.#recenter(to);
    this.voices = this.voices.filter((x) => x !== from);
    this.alias[from.id] = to.id;
    this.merges.push({ from: from.id, to: to.id });
  }

  // Ao vivo: junta pares de vozes com fala suficiente e centroides muito parecidos. Fica a voz com
  // mais fala (a mais antiga em empate), para "Falante 1" não virar "Falante 3" à toa.
  consolidate() {
    let merged = 0;
    for (;;) {
      let best = null;
      for (let i = 0; i < this.voices.length; i++) {
        for (let j = i + 1; j < this.voices.length; j++) {
          const a = this.voices[i];
          const b = this.voices[j];
          if (a.w < MERGE_MIN_S || b.w < MERGE_MIN_S) continue;
          if (a.name && b.name) continue; // dois perfis salvos são duas pessoas
          const sim = cosine(a.centroid, b.centroid);
          if (sim >= this.mergeAt && (!best || sim > best.sim)) best = { a, b, sim };
        }
      }
      if (!best) return merged;
      // fica o perfil salvo (tem nome); senão, a voz com mais fala
      const [keep, drop] = best.b.name && !best.a.name ? [best.b, best.a] : best.a.name && !best.b.name ? [best.a, best.b] : best.b.w > best.a.w ? [best.b, best.a] : [best.a, best.b];
      this.#merge(drop, keep);
      merged++;
    }
  }

  // Fim da reunião: vozes com pouquíssima fala (uma tosse, um "ok" com ruído) vão para a voz mais
  // parecida, desde que passem do limite de "certamente outra pessoa".
  finalize() {
    this.consolidate();
    const small = this.voices.filter((v) => v.w < SMALL_S).sort((a, b) => a.w - b.w);
    for (const v of small) {
      if (this.voices.length < 2) break;
      let best = null;
      for (const o of this.voices) {
        if (o === v || o.w < v.w) continue;
        const sim = cosine(v.centroid, o.centroid);
        if (!best || sim > best.sim) best = { o, sim };
      }
      if (best && best.sim >= this.same) this.#merge(v, best.o);
    }
    return this.takeMerges();
  }

  // Junções desde a última chamada: [{from, to}], com `to` já resolvido para a voz que ficou.
  takeMerges() {
    const out = this.merges.map((m) => ({ from: m.from, to: this.resolve(m.to) }));
    this.merges = [];
    return out;
  }

  // Perfis de voz salvos (opcional, só neste computador): entram como vozes conhecidas, com nome.
  // profiles: [{name, c: number[], w}]. O peso é limitado para a voz de hoje ainda poder ajustar o centroide.
  seed(profiles) {
    for (const p of profiles || []) {
      if (!p || !p.name || !Array.isArray(p.c) || !p.c.length || this.voices.some((v) => v.name === p.name)) continue;
      const w = Math.min(20, Math.max(MERGE_MIN_S, Number(p.w) || MERGE_MIN_S));
      const centroid = Float32Array.from(p.c);
      this.voices.push({ id: `perfil:${this.next++}`, name: p.name, sum: Float32Array.from(centroid, (x) => x * w), centroid, w, n: 1, seeded: true });
    }
  }
  nameOf(id) {
    return this.voices.find((v) => v.id === this.resolve(id))?.name || null;
  }
  // Impressões de voz com fala suficiente para virar perfil: {id: {c, w, name?}}.
  snapshot(minS = 8) {
    const out = {};
    for (const v of this.voices) if (v.w >= minS) out[v.id] = { c: Array.from(v.centroid, (x) => Math.round(x * 1e5) / 1e5), w: Math.round(v.w), ...(v.name ? { name: v.name } : {}) };
    return out;
  }

  get size() {
    return this.voices.length;
  }
}
