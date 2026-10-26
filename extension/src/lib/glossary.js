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
