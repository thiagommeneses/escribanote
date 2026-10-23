// Modelo de transcrição: aplica atualizações incrementais de legenda (mesmo id,
// versões crescentes), remove duplicatas entre canais e guarda destaques, notas,
// capturas de tela e conversas com a IA de cada reunião.

const DUP_WINDOW_MS = 1500;

export function createSession({ id, platform, url, title, startedAt }) {
  return normalize({
    id,
    platform,
    url,
    title: title || "Reunião sem título",
    startedAt,
    updatedAt: startedAt,
    speakers: {},
    entries: [],
    aliases: {},
    summary: null,
  });
}

// Garante os campos novos em sessões salvas por versões anteriores.
export function normalize(s) {
  s.speakers ||= {};
  s.entries ||= [];
  s.aliases ||= {};
  s.highlights ||= {}; // entryId -> [tagId]
  s.notes ||= { text: "", items: [] }; // items: {id, at, text}
  s.shots ||= []; // {id, at}
  s.chats ||= []; // {id, createdAt, messages: [{role, text, at}]}
  s.asr ||= []; // segmentos do Whisper local: {id, start, end, text, source, speakerId}
  s.fixes ||= {}; // id -> texto corrigido pela revisão da IA
  s.reviewed ||= {}; // id -> true (já passou pela revisão)
  s.langs ||= {}; // código de idioma informado pelas legendas -> contagem
  s.uiLang ??= null; // idioma da interface do Meet (as legendas costumam seguir esse)
  s.voices ||= {}; // voz identificada pelo Whisper ("voz:1") -> { speakerId: votos } aprendidos pelas legendas
  s.part ??= 1; // 1ª, 2ª… parte de uma reunião com o mesmo link no mesmo dia
  s.paused ??= false;
  s.endedAt ??= null;
  s.summary ??= null;
  return s;
}

function norm(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

// Aplica um evento vindo do coletor. Retorna true se a sessão mudou.
export function applyEvent(session, ev, now = Date.now()) {
  if (ev.kind === "ui-lang") {
    if (!ev.lang || session.uiLang === ev.lang) return false;
    session.uiLang = ev.lang;
    return true;
  }
  if (ev.kind === "speaker") {
    if (!ev.speakerId || !ev.name || session.speakers[ev.speakerId] === ev.name) return false;
    // Nome lido da tela (casado pelo texto) só preenche lacunas; o nome do protocolo tem prioridade.
    if (ev.weak && session.speakers[ev.speakerId]) return false;
    session.speakers[ev.speakerId] = ev.name;
    session.updatedAt = now;
    return true;
  }
  if (ev.kind === "meeting-title") {
    if (!ev.title || session.title === ev.title) return false;
    session.title = ev.title;
    return true;
  }
  if (ev.kind !== "caption" && ev.kind !== "chat") return false;

  const text = norm(ev.text);
  if (!ev.id || !ev.speakerId) return false;
  if (ev.speakerName && !session.speakers[ev.speakerId]) {
    session.speakers[ev.speakerId] = ev.speakerName;
  }

  if (ev.lang) session.langs[ev.lang] = (session.langs[ev.lang] || 0) + 1;

  const id = session.aliases[ev.id] || ev.id;
  const existing = session.entries.find((e) => e.id === id);
  if (existing) {
    if ((ev.version || 0) < (existing.version || 0)) return false;
    // Na tela, o Meet descarta o começo de falas longas/rápidas: acumula em vez de substituir.
    const next = ev.source === "dom" ? mergeRolling(existing.text, text) : text;
    if (existing.text === next) return false;
    existing.text = next;
    delete session.reviewed[existing.id];
    delete session.fixes[existing.id];
    existing.version = ev.version || 0;
    existing.updatedAt = now;
    session.updatedAt = now;
    return true;
  }
  if (!text) return false;

  // Mesmo falante + mesmo texto num intervalo curto = mesma fala vinda de outro canal.
  // (só para textos longos: "sim", "ok" repetidos rápido são falas diferentes)
  const dup = text.length >= 12 && session.entries.find(
    (e) =>
      e.speakerId === ev.speakerId &&
      e.text === text &&
      e.kind === ev.kind &&
      now - e.updatedAt <= DUP_WINDOW_MS,
  );
  if (dup) {
    session.aliases[ev.id] = dup.id;
    return false;
  }

  session.entries.push({
    id: ev.id,
    kind: ev.kind,
    speakerId: ev.speakerId,
    text,
    version: ev.version || 0,
    lang: ev.lang,
    source: ev.source || "protocol",
    at: now,
    updatedAt: now,
  });
  session.updatedAt = now;
  return true;
}

// Junta o texto anterior com o novo quando a legenda "rola" (o começo some da tela).
// Ex.: "a gente precisa fechar" + "precisa fechar o orçamento" -> "a gente precisa fechar o orçamento".
export function mergeRolling(prev, next) {
  if (!prev) return next;
  if (!next || next.startsWith(prev) || prev.includes(next)) return next.length >= prev.length ? next : prev;
  const a = prev.split(" ");
  const b = next.split(" ");
  // maior sufixo de `prev` que é prefixo de `next` (mínimo 2 palavras para não colar por acaso)
  for (let k = Math.min(a.length, b.length); k >= 2; k--) {
    if (a.slice(-k).join(" ").toLowerCase() === b.slice(0, k).join(" ").toLowerCase()) {
      return [...a, ...b.slice(k)].join(" ");
    }
  }
  // Sem sobreposição: a legenda foi revisada pelo reconhecedor, vale a versão nova.
  return next;
}

const CAPTION_LAG_MS = 1200; // a legenda chega um pouco depois da fala

function captionWindow(e) {
  const start = e.at - CAPTION_LAG_MS;
  return [start, Math.max(e.updatedAt - CAPTION_LAG_MS / 2, start + 1000)];
}

function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

// Quem falou durante [start, end], pelas legendas (o Whisper não sabe quem é quem).
export function resolveSpeaker(session, start, end) {
  const score = new Map();
  for (const e of session.entries) {
    if (e.kind !== "caption") continue;
    const [w0, w1] = captionWindow(e);
    const o = overlap(start, end, w0, w1);
    if (o > 0) score.set(e.speakerId, (score.get(e.speakerId) || 0) + o);
  }
  let best = null;
  for (const [id, v] of score) if (!best || v > best[1]) best = [id, v];
  return best ? best[0] : null;
}

// Palavras em comum entre dois textos, em relação ao menor (0 a 1).
function wordSimilarity(a, b) {
  const wa = new Set(a.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  const wb = new Set(b.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

// Sem fone de ouvido, o microfone também capta a voz dos outros saindo da caixa de som.
// Um trecho do microfone que repete, no mesmo momento, o que veio do áudio do sistema é eco.
const ECHO_TOLERANCE_MS = 1500;
function echoOf(session, seg, text) {
  const other = seg.source === "mic" ? "system" : "mic";
  return session.asr.find(
    (a) => a.source === other && overlap(seg.start - ECHO_TOLERANCE_MS, seg.end + ECHO_TOLERANCE_MS, a.start, a.end) > 0 && wordSimilarity(a.text, text) >= 0.6,
  );
}

// Adiciona um segmento do Whisper. source "mic" é sempre a própria pessoa; "system" é o áudio
// do computador (gravador de apps como o Slack), atribuído a "outros" por não ter nomes.
export function addAsrSegment(session, seg, meId) {
  const text = norm(seg.text);
  if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) return false; // "[música]", "(risos)"
  if (seg.source === "mic" || seg.source === "system") {
    const echo = echoOf(session, seg, text);
    if (echo && seg.source === "mic") return false;
    if (echo) session.asr.splice(session.asr.indexOf(echo), 1); // o eco chegou antes: fica a versão limpa
  }
  let speakerId;
  if (seg.source === "mic") speakerId = meId || "me";
  else {
    const byCaption = seg.source === "system" ? null : resolveSpeaker(session, seg.start, seg.end);
    if (seg.voice) {
      // Voz identificada pelo Whisper: aprende a quem ela pertence pelas legendas e, quando as
      // legendas faltam (ou no gravador, que não tem legendas), usa a voz como falante.
      const votes = (session.voices[seg.voice] ||= {});
      if (byCaption) votes[byCaption] = (votes[byCaption] || 0) + 1;
      const learned = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
      speakerId = byCaption || (learned && learned[1] >= 2 ? learned[0] : seg.voice);
    } else speakerId = seg.source === "system" ? "outros" : byCaption;
  }
  session.asr.push({ id: `asr/${seg.start}/${seg.source}`, start: seg.start, end: seg.end, text, source: seg.source, speakerId, ...(seg.voice ? { voice: seg.voice } : {}) });
  session.updatedAt = Math.max(session.updatedAt, seg.end);
  return true;
}

// Falas efetivas: legendas + segmentos do Whisper (que substituem as legendas que cobrem)
// + correções da IA. Cada item guarda o texto original para comparação.
export function effectiveEntries(session) {
  const fixes = session.fixes || {};
  const asr = (session.asr || []).map((s) => ({
    id: s.id,
    kind: "caption",
    speakerId: s.speakerId || resolveSpeaker(session, s.start, s.end) || "desconhecido",
    text: s.text,
    at: s.start,
    updatedAt: s.end,
    source: "whisper",
    coveredIds: [],
  }));
  const out = [];
  for (const e of session.entries) {
    if (e.kind === "caption" && asr.length) {
      const [w0, w1] = captionWindow(e);
      let best = null;
      let total = 0;
      for (const a of asr) {
        if (a.speakerId !== e.speakerId && !(a.speakerId === "me" && e.speakerId)) continue;
        const o = overlap(w0, w1, a.at, a.updatedAt);
        total += o;
        if (o > 0 && (!best || o > best[1])) best = [a, o];
      }
      if (best && total >= 0.5 * (w1 - w0)) {
        best[0].coveredIds.push(e.id);
        continue;
      }
    }
    out.push({ ...e });
  }
  out.push(...asr);
  out.sort((a, b) => a.at - b.at);
  for (const e of out) {
    e.original = e.text;
    if (fixes[e.id] && fixes[e.id] !== e.text) {
      e.text = fixes[e.id];
      e.fixed = true;
    }
  }
  return out;
}

export function speakerName(session, speakerId) {
  if (session.speakers[speakerId]) return session.speakers[speakerId];
  if (!speakerId || speakerId === "desconhecido") return "Desconhecido";
  if (speakerId === "me") return session.myName || "Você";
  if (speakerId.startsWith("dom:")) return speakerId.slice(4);
  if (speakerId.startsWith("voz:")) return "Falante " + speakerId.slice(4);
  return "Participante " + shortId(speakerId);
}

function shortId(id) {
  const tail = id.split("/").pop() || id;
  return tail.slice(-4);
}

// Agrupa falas consecutivas do mesmo falante (até `gapMs` de distância) em blocos.
// Cada bloco carrega os ids das falas e a união das tags de destaque delas.
export function toBlocks(session, { gapMs = 60_000, includeChat = true } = {}) {
  const hl = session.highlights || {};
  const blocks = [];
  for (const e of effectiveEntries(session)) {
    if (!includeChat && e.kind === "chat") continue;
    const last = blocks[blocks.length - 1];
    if (
      last &&
      last.speakerId === e.speakerId &&
      last.kind === e.kind &&
      e.at - last.endAt <= gapMs
    ) {
      last.texts.push(e.text);
      last.originals.push(e.original);
      last.ids.push(e.id, ...(e.coveredIds || []));
      last.endAt = Math.max(last.endAt, e.updatedAt);
      last.fixed ||= !!e.fixed;
      last.hq ||= e.source === "whisper";
      continue;
    }
    blocks.push({
      speakerId: e.speakerId,
      speaker: speakerName(session, e.speakerId),
      kind: e.kind,
      startAt: e.at,
      endAt: e.updatedAt,
      texts: [e.text],
      originals: [e.original],
      ids: [e.id, ...(e.coveredIds || [])],
      fixed: !!e.fixed,
      hq: e.source === "whisper",
    });
  }
  return blocks.map((b) => ({
    ...b,
    key: b.ids[0],
    text: b.texts.join(" "),
    original: b.originals.join(" "),
    tags: [...new Set(b.ids.flatMap((id) => hl[id] || []))],
  }));
}

// Define as tags de um bloco (todas as falas dele). tags vazio remove o destaque.
export function setBlockTags(session, ids, tags) {
  session.highlights ||= {};
  for (const id of ids) delete session.highlights[id];
  if (tags.length) session.highlights[ids[0]] = [...new Set(tags)];
}

// Liga/desliga uma tag no último bloco de fala (atalho "destacar o último bloco").
export function toggleLastBlockTag(session, tagId) {
  const blocks = toBlocks(session, { includeChat: false });
  const b = blocks[blocks.length - 1];
  if (!b) return null;
  const tags = b.tags.includes(tagId) ? b.tags.filter((t) => t !== tagId) : [...b.tags, tagId];
  setBlockTags(session, b.ids, tags);
  return { key: b.key, tags };
}

// Linha do tempo unificada: blocos de fala, notas com horário e capturas de tela.
export function timeline(session, opts) {
  const items = [
    ...toBlocks(session, opts).map((b) => ({ type: "block", at: b.startAt, block: b })),
    ...session.notes.items.map((n) => ({ type: "note", at: n.at, note: n })),
    ...session.shots.map((s) => ({ type: "shot", at: s.at, shot: s })),
  ];
  return items.sort((a, b) => a.at - b.at);
}

export function participantNames(session) {
  const ids = [...new Set(effectiveEntries(session).filter((e) => e.kind === "caption").map((e) => e.speakerId))];
  return ids.filter((id) => id !== "desconhecido").map((id) => speakerName(session, id));
}
