// Vocabulário da equipe: nomes, siglas, termos jurídicos, de tecnologia e em inglês que as legendas
// costumam errar. Cada linha é um termo; opcionalmente, depois de "=" (ou "→"), as formas erradas
// que as legendas produzem. Ex.: "Agno = argum, agnum". As formas erradas são corrigidas na hora,
// em toda fala que chega; o termo certo também vai para os prompts da revisão, da ata e do chat.

export function parseGlossary(text) {
  const rules = [];
  const terms = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(.+?)\s*(?:=|→|->)\s*(.+)$/);
    const to = (m ? m[1] : line).trim();
    if (!to) continue;
    terms.push(to);
    const from = m
      ? m[2].split(/[,;]+/).map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== to.toLowerCase())
      : [];
    if (from.length) rules.push({ to, from });
  }
  return { terms, rules };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Compila as regras uma vez (regex por termo, palavra inteira, sem diferenciar maiúsculas).
export function compileGlossary(text) {
  const { rules } = parseGlossary(text);
  return rules.map(({ to, from }) => ({
    to,
    re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${from.sort((a, b) => b.length - a.length).map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu"),
  }));
}

// Aplica as correções a um texto. Mantém a maiúscula inicial quando a forma errada começava a frase.
export function applyGlossary(text, compiled) {
  if (!compiled || !compiled.length || !text) return text;
  let out = text;
  for (const { to, re } of compiled) {
    out = out.replace(re, (m) => (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() && to[0] === to[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to));
  }
  return out;
}

// Texto do vocabulário para os prompts de IA: um termo por linha, com as formas erradas conhecidas
// (ajuda o modelo a reconhecer o erro quando ele aparece com outra variação) e o contexto da equipe.
export function glossaryForPrompt(text, teamContext = "") {
  const { terms, rules } = parseGlossary(text);
  const bad = new Map(rules.map((r) => [r.to, r.from]));
  const lines = terms.map((t) => (bad.has(t) ? `${t} (as legendas costumam escrever: ${bad.get(t).join(", ")})` : t));
  const ctx = String(teamContext || "").trim();
  if (ctx) lines.push(`Contexto das reuniões: ${ctx.replace(/\s+/g, " ")}`);
  return lines.join("\n");
}

// ----- Grafias parecidas -----
// O Whisper e as legendas erram nomes por uma ou duas letras ("Quitérria", "Domênico Failut",
// "Casper-Líbero"). Cada termo do glossário e cada nome de participante vira um alvo; um trecho
// da fala parecido o bastante é trocado pela grafia certa. Regras conservadoras, porque a troca é
// definitiva: mesma primeira letra, uma letra de diferença de 6 a 8 letras, duas a partir de 9, e
// nomes de participantes só trocam palavra com maiúscula (os curtos, só acento).

const fold = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[-‐–]+/g, " ").replace(/\s+/g, " ").trim();
const CORE = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su;

// Distância de edição com troca de letras vizinhas; para assim que passa do limite.
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const allowed = (len) => (len >= 9 ? 2 : len >= 6 ? 1 : 0);

// glossaryText: o texto do glossário (termos certos); names: nomes dos participantes.
export function fuzzyTargets(glossaryText, names = []) {
  const out = new Map();
  const add = (to, strict, exact = false) => {
    const f = fold(to);
    if (f.length < 4 || (out.has(f) && !out.get(f).strict)) return;
    out.set(f, { to, f, words: f.split(" ").length, strict, exact });
  };
  for (const t of parseGlossary(glossaryText).terms) add(t, false);
  for (const n of names) {
    const name = String(n || "").trim();
    if (!name || /^(Participante|Falante)\b/i.test(name)) continue;
    add(name, true);
    // nome curto ("André") só ganha o acento ou a maiúscula certa; de 6 letras em diante, também a grafia
    for (const w of name.split(/\s+/)) if (w.length >= 4) add(w, true, w.length < 6);
  }
  return [...out.values()];
}

export function applyFuzzy(text, targets) {
  if (!text || !targets || !targets.length) return text;
  const toks = text.split(/(\s+)/); // palavras nos índices pares, espaços nos ímpares
  const words = [];
  for (let i = 0; i < toks.length; i += 2) if (toks[i]) words.push(i);
  const replaced = new Set();
  for (const t of [...targets].sort((a, b) => b.f.length - a.f.length)) {
    for (let w = 0; w < words.length; w++) {
      for (let size = Math.max(1, t.words - 1); size <= t.words + 1 && w + size <= words.length; size++) {
        const idx = words.slice(w, w + size);
        if (idx.some((i) => replaced.has(i))) continue;
        const first = toks[idx[0]].match(CORE);
        const last = toks[idx[idx.length - 1]].match(CORE);
        const raw = idx.map((i) => toks[i]).join(" ");
        const inner = raw.slice(first[1].length, raw.length - last[3].length);
        if (!inner || /[.!?;:,]/.test(inner.replace(/[-‐–]/g, ""))) continue; // não atravessa pontuação
        const f = fold(inner);
        if (f[0] !== t.f[0]) continue;
        if (t.strict && !/^\p{Lu}/u.test(inner)) continue;
        if (f === t.f ? inner === t.to : t.exact || distance(f, t.f, allowed(t.f.length)) > allowed(t.f.length)) continue;
        // Termo em minúscula no começo da frase continua com maiúscula.
        const to = /^\p{Lu}/u.test(inner) && /^\p{Ll}/u.test(t.to) ? t.to[0].toUpperCase() + t.to.slice(1) : t.to;
        if (to === inner) continue;
        toks[idx[0]] = first[1] + to + last[3];
        for (const i of idx.slice(1)) { toks[i] = ""; toks[i - 1] = ""; }
        idx.forEach((i) => replaced.add(i));
        break;
      }
    }
  }
  return toks.join("");
}
