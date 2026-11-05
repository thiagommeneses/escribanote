// Perfis de voz (opcional, Pro): a impressão de voz de quem participa sempre fica guardada SÓ neste
// computador, com o nome, para a pessoa ser reconhecida desde a primeira fala nas próximas reuniões.
// Impressão de voz é dado biométrico (dado sensível na LGPD): desligado por padrão, nunca sincroniza,
// não vai para backup nem para a conta, e pode ser apagado a qualquer momento em Ajustes.
import { canonicalSpeaker, isJunkName, nameKey } from "./transcript.js";

export const MAX_PROFILES = 60;
const MAX_W = 60; // segundos de fala acumulados por perfil (a média continua acompanhando a voz)
const GENERIC = /^(falante|participante|speaker|voz)\b/i;

// Nome de cada voz da reunião: o falante mais frequente nas falas do Whisper com aquela voz.
function nameForVoice(session, voiceId) {
  const count = new Map();
  for (const a of session.asr) {
    if (a.voice !== voiceId || !a.speakerId) continue;
    const id = canonicalSpeaker(session, a.speakerId);
    count.set(id, (count.get(id) || 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const id = top[0];
  const name = id === "me" ? session.myName : session.speakers[id];
  if (!name || isJunkName(name) || GENERIC.test(name.trim()) || id === "outros" || id === "desconhecido") return null;
  return name.trim();
}

// Junta as impressões desta reunião (prints: {voiceId: {c, w, name?}}) aos perfis salvos.
// Devolve a lista nova (não grava).
export function learnProfiles(session, prints, profiles, now = Date.now()) {
  const list = (profiles || []).map((p) => ({ ...p }));
  for (const [voiceId, pr] of Object.entries(prints || {})) {
    if (!pr || !Array.isArray(pr.c) || !pr.c.length) continue;
    const name = nameForVoice(session, voiceId) || pr.name || null;
    if (!name) continue;
    const key = nameKey(name);
    const cur = list.find((p) => nameKey(p.name) === key);
    const w = Math.max(1, Number(pr.w) || 1);
    if (cur && cur.c.length === pr.c.length) {
      const total = Math.min(MAX_W, cur.w + w);
      const a = cur.w / (cur.w + w);
      cur.c = cur.c.map((x, i) => Math.round((x * a + pr.c[i] * (1 - a)) * 1e5) / 1e5);
      cur.w = total;
      cur.at = now;
      cur.meetings = (cur.meetings || 1) + 1;
    } else if (!cur) {
      list.push({ name, c: pr.c, w: Math.min(MAX_W, w), at: now, meetings: 1 });
    }
  }
  return list.sort((a, b) => b.at - a.at).slice(0, MAX_PROFILES);
}

export async function loadProfiles() {
  const { voiceProfiles } = await chrome.storage.local.get("voiceProfiles");
  return Array.isArray(voiceProfiles) ? voiceProfiles : [];
}
export async function saveProfiles(list) {
  await chrome.storage.local.set({ voiceProfiles: list });
}
