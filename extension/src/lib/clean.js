// Leitura limpa: tira hesitações ("ahn", "hum", "éé") e palavras repetidas em sequência ("eu eu eu").
// Só muda o que é mostrado ou exportado; o texto da transcrição fica intacto.
// Conservadora de propósito: "né", "ah", "tipo" e repetições com vírgula ("não, não") têm sentido e ficam.

const FILLER = /^(?:a+hn+|a+h{2,}n*|a{3,}h*|ã+h*n*|h+ã+|hu+m+|h+m+|u+h+m*|e+h+|é+h+|é{2,}h*|ê{2,})$/u;
const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const END = /[.!?…]+$/u;

const core = (tok) => tok.replace(EDGE, "").toLowerCase();
const upper = (tok) => tok.replace(/\p{Ll}/u, (c) => c.toUpperCase());

export function cleanSpeech(text) {
  if (!text) return text;
  const out = [];
  let capNext = false;
  for (const tok of text.split(/\s+/)) {
    if (!tok) continue;
    const c = core(tok);
    const prev = out[out.length - 1];
    if (c && FILLER.test(c)) {
      // A pontuação final da hesitação passa para a palavra anterior ("acho, ahn." → "acho.").
      const end = tok.match(END);
      if (end && prev) out[out.length - 1] = prev.replace(/[,;:]+$/u, "").replace(END, "") + end[0];
      if (!prev || END.test(out[out.length - 1]) || /^\p{Lu}/u.test(tok)) capNext = true;
      continue;
    }
    // Repetição colada ("eu eu eu"): fica a última, que carrega a pontuação.
    if (c && prev && !/\p{P}$/u.test(prev) && core(prev) === c && !/^\d+$/.test(c)) {
      out[out.length - 1] = /^\p{Lu}/u.test(prev) ? upper(tok) : tok;
      continue;
    }
    out.push(capNext ? upper(tok) : tok);
    capNext = false;
  }
  // Depois de tirar a hesitação do começo, a vírgula que sobrou não serve ("Ahn, eu" → "Eu").
  const res = out.join(" ").replace(/^[,;:]\s*/u, "");
  return res;
}
