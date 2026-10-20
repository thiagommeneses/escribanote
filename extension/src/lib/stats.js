// Estatísticas de fala de uma reunião.
import { speakerName, effectiveEntries } from "./transcript.js";

const WORDS_PER_SEC = 2.5; // ritmo médio de fala usado quando a legenda é curta demais

function words(text) {
  return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
}

// Estimativa de tempo de fala de uma entrada: o tempo em que a legenda ficou sendo
// atualizada, nunca menos do que o tempo necessário para dizer aquelas palavras.
function talkMs(e) {
  return Math.max(e.updatedAt - e.at, (words(e.text) / WORDS_PER_SEC) * 1000, 800);
}

export function computeStats(session) {
  const caps = effectiveEntries(session).filter((e) => e.kind === "caption" && e.speakerId !== "desconhecido");
  const by = new Map();
  for (const e of caps) {
    const s = by.get(e.speakerId) || { speakerId: e.speakerId, words: 0, talkMs: 0, turns: 0, questions: 0, longestMs: 0 };
    s.words += words(e.text);
    s.talkMs += talkMs(e);
    s.questions += (e.text.match(/\?/g) || []).length;
    by.set(e.speakerId, s);
  }
  // Turnos e maior monólogo vêm dos blocos contínuos do mesmo falante.
  let prev = null;
  let runMs = 0;
  for (const e of caps) {
    if (!prev || prev.speakerId !== e.speakerId) {
      by.get(e.speakerId).turns++;
      runMs = 0;
    }
    runMs += talkMs(e);
    const s = by.get(e.speakerId);
    s.longestMs = Math.max(s.longestMs, runMs);
    prev = e;
  }
  const totalTalk = [...by.values()].reduce((a, s) => a + s.talkMs, 0) || 1;
  const end = session.endedAt || session.updatedAt;
  const durationMs = Math.max(0, end - session.startedAt);
  const speakers = [...by.values()]
    .map((s) => ({
      ...s,
      name: speakerName(session, s.speakerId),
      share: s.talkMs / totalTalk,
      wpm: s.talkMs > 0 ? Math.round(s.words / (s.talkMs / 60000)) : 0,
    }))
    .sort((a, b) => b.talkMs - a.talkMs);

  return {
    durationMs,
    totalWords: speakers.reduce((a, s) => a + s.words, 0),
    totalTurns: speakers.reduce((a, s) => a + s.turns, 0),
    speakers,
    segments: caps.map((e) => ({ speakerId: e.speakerId, start: e.at - session.startedAt, end: e.at - session.startedAt + talkMs(e) })),
  };
}

// Encontra o participante que corresponde ao nome configurado como "você".
export function findMe(stats, myName) {
  const n = (myName || "").trim().toLowerCase();
  if (!n) return null;
  return stats.speakers.find((s) => s.name.toLowerCase() === n || s.name.toLowerCase().startsWith(n + " ")) || null;
}

export function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)} s`;
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
