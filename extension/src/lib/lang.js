// Verifica se as legendas estão no idioma esperado. Legenda configurada em inglês
// numa reunião em português é a principal causa de transcrição ruim.
import { effectiveEntries } from "./transcript.js";

const STOP = {
  pt: ["de", "que", "não", "uma", "para", "com", "você", "isso", "mas", "está", "por", "como", "mais", "então", "gente", "também", "aqui", "tem", "ele", "ela", "muito", "já", "vai", "foi", "são", "eu", "o", "a", "os", "as", "do", "da", "no", "na", "em", "é"],
  en: ["the", "and", "that", "you", "this", "with", "have", "for", "not", "are", "but", "what", "about", "just", "we", "they", "is", "it", "of", "to", "in", "so", "do", "be", "was", "will", "can", "i"],
  es: ["que", "el", "los", "las", "una", "con", "por", "para", "pero", "como", "está", "muy", "también", "aquí", "nosotros", "usted", "es", "lo", "del", "y", "en"],
};

export const LANG_NAMES = { pt: "português", en: "inglês", es: "espanhol", fr: "francês", de: "alemão", it: "italiano", ja: "japonês" };

export function detectLang(text) {
  const words = (text.toLowerCase().match(/[\p{L}']+/gu) || []);
  if (words.length < 4) return null;
  const score = {};
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list);
    score[lang] = words.filter((w) => set.has(w)).length / words.length;
  }
  // "que", "como", "está" existem em pt e es: desempata por marcas típicas
  if (/[ãõç]|\b(não|você|então|isso)\b/.test(text.toLowerCase())) score.pt += 0.15;
  if (/[ñ¿¡]|\b(usted|nosotros|muy|pero)\b/.test(text.toLowerCase())) score.es += 0.15;
  const [best, val] = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  return val >= 0.12 ? best : null;
}

// Retorna null se está tudo bem, ou { seen, expected } quando as legendas parecem
// estar em outro idioma. expected: "pt-BR", "en-US"...
export function captionLanguageIssue(session, expected = "pt-BR") {
  const want = expected.slice(0, 2).toLowerCase();
  // 1) Código informado pelo próprio Meet nas legendas (captions_v2).
  const codes = Object.entries(session.langs || {}).sort((a, b) => b[1] - a[1]);
  if (codes.length && codes[0][1] >= 3) {
    const code = codes[0][0].slice(0, 2).toLowerCase();
    return code === want ? null : { seen: code, expected: want, source: "plataforma" };
  }
  // 2) Sem código: estima pelo texto das últimas falas.
  const recent = effectiveEntries(session).filter((e) => e.kind === "caption" && e.source !== "whisper").slice(-15);
  if (recent.length < 6) return null;
  const votes = {};
  for (const e of recent) {
    const l = detectLang(e.text);
    if (l) votes[l] = (votes[l] || 0) + 1;
  }
  const [top, n] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || [];
  if (!top || top === want || n < recent.length * 0.6) return null;
  return { seen: top, expected: want, source: "texto" };
}
