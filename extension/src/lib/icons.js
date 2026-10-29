// Ícones do Escribanote, estilo duotone: traço de 1,75 px e o corpo com preenchimento suave na cor do texto.
// Script clássico de propósito: o widget (content script) carrega pelo manifest e as páginas fazem import "../lib/icons.js";
// os dois leem globalThis.EsIcons.
// Cada ícone: b = corpo (preenchido), d = detalhes (só traço). A força do preenchimento vem de --ic-fill (padrão .16).
(() => {
  const circ = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

  const I = {
    importante: { b: ["M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.6l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"] },
    decisao: { b: [circ(12, 12, 9)], d: ["M8.2 12.4l2.6 2.6 5-5.2"] },
    acao: { b: ["M5.5 4h11.8l-2.4 4 2.4 4H5.5z"], d: ["M5.5 4v16.5"] },
    pergunta: { b: [circ(12, 12, 9)], d: ["M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.5v.5", "M12 16.8v.2"] },
    risco: { b: ["M10.3 4.4a2 2 0 0 1 3.4 0l7.4 12.8a2 2 0 0 1-1.7 3H4.6a2 2 0 0 1-1.7-3z"], d: ["M12 9.5v4", "M12 16.7v.2"] },
    hq: { b: ["M4 14h3v6H5.2A1.2 1.2 0 0 1 4 18.8z", "M20 14h-3v6h1.8a1.2 1.2 0 0 0 1.2-1.2z"], d: ["M4 15.5V12a8 8 0 0 1 16 0v3.5"] },
    mic: { b: ["M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"], d: ["M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21"] },
    nota: { b: ["M5 4h10.5L19 7.5V20H5z"], d: ["M8.5 11h7", "M8.5 14.5h4.5"] },
    captura: { b: ["M3 8.2A1.7 1.7 0 0 1 4.7 6.5h2.1l1.6-2.2h7.2l1.6 2.2h2.1A1.7 1.7 0 0 1 21 8.2v9.6a1.7 1.7 0 0 1-1.7 1.7H4.7A1.7 1.7 0 0 1 3 17.8z"], d: [circ(12, 12.8, 3.3)] },
    chat: { b: ["M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9.5L5 20v-4h.5A1.5 1.5 0 0 1 4 14.5z"], d: ["M8.5 9h7", "M8.5 12h4"] },
    editar: { b: ["M4 20l1-4.6L15.4 5a2.1 2.1 0 0 1 3 3L8 18.6z"], d: ["M13.4 7l3.1 3.1"] },
    dividir: { b: [circ(6, 7, 2.5), circ(6, 17, 2.5)], d: ["M8.2 8.4L20 17", "M8.2 15.6L20 7"] },
    falante: { b: [circ(10, 8, 3.5), "M3.5 20a6.5 6.5 0 0 1 13 0z"], d: ["M17.5 8.5h4", "M19.8 6.3l2 2.2-2 2.2"] },
    apagar: { b: ["M6 7.5h12l-.9 11.6a1.6 1.6 0 0 1-1.6 1.4h-7a1.6 1.6 0 0 1-1.6-1.4z"], d: ["M4 7.5h16", "M9.5 4.5h5", "M10 11v5.5", "M14 11v5.5"] },
    desfazer: { d: ["M9 13.5L4.5 9 9 4.5", "M4.5 9h10a5.5 5.5 0 0 1 0 11H11"] },
    copiar: { b: ["M10.5 9h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 9 18.5v-8A1.5 1.5 0 0 1 10.5 9z"], d: ["M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"] },
    texto: { b: ["M6 3.5h8l4.5 4.5v12.5H6z"], d: ["M14 3.5V8h4.5", "M9 12.5h6", "M9 16h4"] },
    pdf: { b: ["M6 10h12a2 2 0 0 1 2 2v5h-3v3H7v-3H4v-5a2 2 0 0 1 2-2z"], d: ["M7 10V4h10v6", "M9.5 16.5h5"] },
    baixar: { b: ["M4 15.5h16v3.3a1.7 1.7 0 0 1-1.7 1.7H5.7A1.7 1.7 0 0 1 4 18.8z"], d: ["M12 3.5v9", "M8 8.8l4 4 4-4"] },
    capitulos: { b: ["M3.5 4.5h4v3.5h-4z", "M3.5 10.3h4v3.5h-4z", "M3.5 16h4v3.5h-4z"], d: ["M10.5 6.2H20", "M10.5 12H20", "M10.5 17.8H17"] },
    ia: { b: ["M11 3.5c.6 4.4 2.8 6.6 7.2 7.2-4.4.6-6.6 2.8-7.2 7.2-.6-4.4-2.8-6.6-7.2-7.2 4.4-.6 6.6-2.8 7.2-7.2z"], d: ["M19 15v5", "M16.5 17.5h5"] },
    versoes: { b: [circ(6, 6, 2.2), circ(6, 18, 2.2), circ(18, 12, 2.2)], d: ["M6 8.2v7.6", "M8.2 6H12a4 4 0 0 1 4 4"] },
    refazer: { d: ["M19.5 12a7.5 7.5 0 1 1-2.2-5.3", "M19.5 4v4.5H15"] },
    sync: { d: ["M7.5 20V4", "M4 7.5L7.5 4 11 7.5", "M16.5 4v16", "M13 16.5l3.5 3.5 3.5-3.5"] },
    manter: { b: ["M6.5 3.5h11v17l-5.5-3.8-5.5 3.8z"] },
    tag: { b: ["M3.5 11.6V5A1.5 1.5 0 0 1 5 3.5h6.6l8.9 8.9-8.1 8.1z"], d: ["M8 7.2v.2"] },
    anterior: { d: ["M9 6.5L4 11.5l5 5", "M4 11.5h11a5 5 0 0 0 5-5V5"] },
    aguarde: { b: ["M7 3.5h10c0 4-2.2 6.3-5 8.5-2.8-2.2-5-4.5-5-8.5z", "M7 20.5h10c0-4-2.2-6.3-5-8.5-2.8 2.2-5 4.5-5 8.5z"] },
    gravando: { b: [circ(12, 12, 9)], solid: [circ(12, 12, 5)] },
    pausar: { b: ["M7.5 5h2.5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M14 5h2.5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H14a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"] },
    tocar: { b: ["M8 5.6v12.8a1 1 0 0 0 1.5.9l10-6.4a1 1 0 0 0 0-1.7l-10-6.4A1 1 0 0 0 8 5.6z"] },
    parar: { b: ["M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"] },
    ok: { d: ["M5 12.5l4.5 4.5L19 7.5"] },
    fechar: { d: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"] },
    minimizar: { d: ["M5 12h14"] },
    enviar: { b: ["M4 11.5L20 4l-6.5 16-2.8-6.7z"], d: ["M10.7 13.3L20 4"] },
    ver: { b: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"], d: [circ(12, 12, 3)] },
    ocultar: { d: ["M3 3l18 18", "M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9", "M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.4-1"] },
    avisar: { b: ["M3.5 10v4H7l7 4.5v-13L7 10z"], d: ["M18 9a4 4 0 0 1 0 6"] },
    abrir: { d: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"] },
    lista: { b: ["M5.5 3.5h13v17h-13z"], d: ["M9 8h6", "M9 12h6", "M9 16h3"] },
    ajustes: { b: [circ(15.5, 7, 2.3), circ(8.5, 17, 2.3)], d: ["M4 7h9.2", "M17.8 7H20", "M4 17h2.2", "M10.8 17H20"] },
    seta: { d: ["M6.5 9.5l5.5 5.5 5.5-5.5"] },
    buscar: { b: [circ(10.5, 10.5, 6.5)], d: ["M15.5 15.5L20 20"] },
    // Só para a paleta das tags.
    ideia: { b: ["M12 3a6 6 0 0 1 3.6 10.8c-.7.5-1.1 1.3-1.1 2.2v.5h-5V16c0-.9-.4-1.7-1.1-2.2A6 6 0 0 1 12 3z"], d: ["M9.5 19h5", "M10.5 21.3h3"] },
    alvo: { b: [circ(12, 12, 9)], d: [circ(12, 12, 5), circ(12, 12, 1.3)] },
    prazo: { b: [circ(12, 12, 9)], d: ["M12 7.5V12l3 2"] },
    calendario: { b: ["M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"], d: ["M4 10h16", "M8 3v4", "M16 3v4"] },
    dinheiro: { b: [circ(12, 12, 9)], d: ["M14.5 9.3c-.5-.8-1.4-1.3-2.5-1.3-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.5-2.5-1.3", "M12 6.5V8", "M12 16v1.5"] },
    pessoa: { b: [circ(12, 8, 3.5), "M5.5 20a6.5 6.5 0 0 1 13 0z"] },
    coracao: { b: ["M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"] },
    raio: { b: ["M13 2.5L5 13.5h6l-1 8 8-11h-6z"] },
    cadeado: { b: ["M5.5 11.5A1.5 1.5 0 0 1 7 10h10a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5z"], d: ["M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10", "M12 14.5v2"] },
  };

  // Paleta das tags: o ícone e o emoji que o representa nas exportações em texto (Markdown, TXT, legendas).
  const TAG_ICONS = [
    ["importante", "⭐"], ["decisao", "✅"], ["acao", "📌"], ["pergunta", "❓"], ["risco", "⚠️"],
    ["ideia", "💡"], ["alvo", "🎯"], ["prazo", "⏰"], ["calendario", "📅"], ["dinheiro", "💰"],
    ["pessoa", "👤"], ["chat", "💬"], ["nota", "📝"], ["texto", "📄"], ["coracao", "❤️"],
    ["raio", "⚡"], ["cadeado", "🔒"], ["ia", "✨"], ["captura", "📷"], ["tag", "🏷"],
  ];
  const BY_EMOJI = new Map(TAG_ICONS.map(([n, e]) => [e.replace(/️/g, ""), n]));

  // Tags antigas só têm emoji: o desenho equivalente da paleta, ou a etiqueta genérica.
  function tagIcon(tag) {
    if (tag && I[tag.icon]) return tag.icon;
    return BY_EMOJI.get(String((tag && tag.emoji) || "").replace(/️/g, "")) || "tag";
  }

  function icon(name, { size, cls = "", label } = {}) {
    const ic = I[name];
    if (!ic) return "";
    const body = (ic.b || []).map((d) => `<path d="${d}" fill="currentColor" style="fill-opacity:var(--ic-fill,.16)"/>`).join("");
    const solid = (ic.solid || []).map((d) => `<path d="${d}" fill="currentColor" stroke="none"/>`).join("");
    const det = (ic.d || []).map((d) => `<path d="${d}"/>`).join("");
    const dim = size ? ` width="${size}" height="${size}"` : "";
    const a11y = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"';
    return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24"${dim}${a11y}><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}${solid}${det}</g></svg>`;
  }

  globalThis.EsIcons = { icon, tagIcon, TAG_ICONS, names: Object.keys(I) };
})();
