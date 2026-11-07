// Exportação da reunião em vários formatos.
import { toBlocks, speakerName, timeline, participantNames } from "./transcript.js";
import { cleanSpeech } from "./clean.js";

// Texto de um bloco com os parágrafos separados; do segundo em diante, o horário em que começou.
// `wrap` formata o horário no estilo de cada saída (texto, Markdown, HTML).
function blockText(session, b, wrap, sep = "\n\n") {
  const paras = b.paras && b.paras.length ? b.paras : [{ at: b.startAt, text: b.text }];
  return paras.map((p, i) => (i ? wrap(clock(p.at - session.startedAt)) + " " : "") + p.text).join(sep);
}
import { DEFAULT_TAGS } from "./settings.js";

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

// Tempo relativo ao início da reunião: HH:MM:SS
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function cueTime(ms, sep) {
  const v = Math.max(0, ms);
  return `${clock(v)}${sep}${pad(v % 1000, 3)}`;
}

export function dateLabel(ts) {
  return new Date(ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export const PLATFORM = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom", slack: "Slack", desktop: "Áudio do computador", import: "Arquivo importado" };

// O que entra na exportação (opts.include). Sem escolha, fica como sempre foi: tudo, menos as conversas com a IA.
export const EXPORT_PARTS = [
  ["chat", "Chat da reunião"],
  ["notes", "Notas"],
  ["highlights", "Destaques"],
  ["chapters", "Capítulos"],
  ["ai", "Perguntas e respostas da IA"],
];
export const EXPORT_DEFAULT = { chat: true, notes: true, highlights: true, chapters: true, ai: false };
function inc(opts, key) {
  const v = opts && opts.include && opts.include[key];
  return typeof v === "boolean" ? v : EXPORT_DEFAULT[key];
}
// Linha do tempo com só as partes escolhidas (capítulos, notas, chat da reunião; destaques viram só a marca).
function items(session, opts = {}) {
  return timeline(session, { ...opts, includeChat: inc(opts, "chat") }).filter(
    (it) =>
      (it.type !== "chapter" || inc(opts, "chapters")) &&
      (it.type !== "note" || inc(opts, "notes")) &&
      (it.type !== "block" || it.block.kind !== "chat" || inc(opts, "chat")),
  );
}
function marks(b, opts) {
  return inc(opts, "highlights") ? b.tags : [];
}
// Conversas da aba IA: [{ title, pairs: [{ q, a }] }]. A pergunta sai sem as reuniões anteriores coladas como consulta.
export function aiConversations(session) {
  const strip = (s) => String(s || "").replace(/<reuniao_anterior[^>]*>[\s\S]*?<\/reuniao_anterior>/g, "").trim();
  return (session.chats || [])
    .map((c) => {
      const pairs = [];
      for (const m of c.messages || []) {
        if (m.role === "user") pairs.push({ q: strip(m.text), a: "" });
        else if (m.role === "assistant" && pairs.length) pairs[pairs.length - 1].a = String(m.text || "").trim();
      }
      return { auto: !!c.auto, pairs: pairs.filter((p) => p.q && p.a) };
    })
    .filter((c) => c.pairs.length);
}

function tagLabel(tags, id) {
  const t = (tags || DEFAULT_TAGS).find((x) => x.id === id);
  return t ? `${t.emoji} ${t.label}` : id;
}

function highlightsOf(session, opts) {
  return toBlocks(session, opts).filter((b) => b.tags.length);
}

export function toText(session, opts = {}) {
  const head = `${session.title}\n${PLATFORM[session.platform] || session.platform} · ${dateLabel(session.startedAt)}\n`;
  const body = items(session, opts)
    .map((it) => {
      const t = `[${clock(it.at - session.startedAt)}]`;
      if (it.type === "note") return `${t} 📝 Nota: ${it.note.text}`;
      if (it.type === "shot") return `${t} 📷 Captura de tela`;
      if (it.type === "chapter") return `--- ${it.chapter.n}. ${it.chapter.title} ---`;
      const b = it.block;
      const tag = b.kind === "chat" ? " (chat)" : "";
      const m = marks(b, opts);
      const mark = m.length ? ` [${m.map((id) => tagLabel(opts.tags, id)).join(", ")}]` : "";
      return `${t} ${b.speaker}${tag}${mark}: ${blockText(session, b, (c) => `[${c}]`)}`;
    })
    .join("\n\n");
  let ai = "";
  if (inc(opts, "ai")) {
    const convs = aiConversations(session);
    if (convs.length) ai = "\n\n=== Perguntas à IA ===\n\n" + convs.flatMap((c) => c.pairs.map((p) => `Pergunta: ${p.q}\n\nResposta:\n${p.a}`)).join("\n\n---\n\n") + "\n";
  }
  return `${head}\n${body}\n${ai}`;
}

export function toMarkdown(session, opts = {}) {
  const lines = [
    `# ${session.title}`,
    "",
    `- **Plataforma:** ${PLATFORM[session.platform] || session.platform}`,
    `- **Data:** ${dateLabel(session.startedAt)}`,
    `- **Participantes:** ${participantNames(session).join(", ") || "—"}`,
    "",
  ];
  if (opts.ata !== false && session.summary && session.summary.text) lines.push("## Ata", "", session.summary.text.trim(), "");
  const hls = inc(opts, "highlights") ? highlightsOf(session, opts) : [];
  if (hls.length) {
    lines.push("## Destaques", "");
    for (const b of hls) {
      lines.push(`- ${b.tags.map((id) => tagLabel(opts.tags, id)).join(" ")} **${b.speaker}** (\`${clock(b.startAt - session.startedAt)}\`): ${b.text.replace(/\s*\n+\s*/g, " ")}`);
    }
    lines.push("");
  }
  if (inc(opts, "notes") && session.notes.text.trim()) lines.push("## Notas", "", session.notes.text.trim(), "");
  if (inc(opts, "chapters") && session.chapters && session.chapters.length) {
    lines.push("## Capítulos", "");
    for (const c of session.chapters) lines.push(`- \`${clock(c.startAt - session.startedAt)}\` ${c.title}`);
    lines.push("");
  }
  if (inc(opts, "ai")) {
    const convs = aiConversations(session);
    if (convs.length) {
      lines.push("## Perguntas à IA", "");
      for (const c of convs) for (const p of c.pairs) lines.push(`### ${firstLine(p.q)}`, "", ...(p.q.length > firstLine(p.q).length ? ["**Pergunta:**", "", p.q, ""] : []), "**Resposta:**", "", p.a, "");
    }
  }
  lines.push("## Transcrição", "");
  for (const it of items(session, opts)) {
    const t = `\`${clock(it.at - session.startedAt)}\``;
    if (it.type === "chapter") { lines.push(`### ${it.chapter.n}. ${it.chapter.title}`, ""); continue; }
    if (it.type === "note") lines.push(`> 📝 ${t} ${it.note.text}`, "");
    else if (it.type === "shot") lines.push(`> 📷 ${t} Captura de tela`, "");
    else {
      const b = it.block;
      const tag = b.kind === "chat" ? " _(chat)_" : "";
      const m = marks(b, opts);
      const mark = m.length ? " " + m.map((id) => tagLabel(opts.tags, id)).join(" ") : "";
      lines.push(`**${b.speaker}**${tag} · ${t}${mark}`, "", blockText(session, b, (c) => `\`${c}\``), "");
    }
  }
  return lines.join("\n");
}

// Primeira linha da pergunta, sem "#" de título, para o subtítulo da conversa na exportação.
function firstLine(q) {
  const l = String(q).split("\n").map((x) => x.replace(/^#+\s*/, "").trim()).find(Boolean) || "Pergunta";
  return l.length > 120 ? l.slice(0, 117) + "…" : l;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Blocos de código cercados (```lang nome.ext). A IA não cria arquivos: escreve o conteúdo de cada um num bloco
// com o nome na linha de abertura, e o app oferece o download (um por bloco ou todos num .zip).
const FENCE = /^\s*(`{3,}|~{3,})\s*(.*)$/;
const LANG_EXT = { js: "js", javascript: "js", ts: "ts", typescript: "ts", py: "py", python: "py", json: "json", md: "md", markdown: "md", html: "html", css: "css", sql: "sql", sh: "sh", bash: "sh", shell: "sh", ps1: "ps1", powershell: "ps1", mql5: "mq5", mq5: "mq5", mql4: "mq4", ntsl: "ntsl", pascal: "pas", csharp: "cs", cs: "cs", java: "java", c: "c", cpp: "cpp", go: "go", rust: "rs", yaml: "yml", yml: "yml", xml: "xml", csv: "csv", txt: "txt", text: "txt" };
const safeName = (n) => n.replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/").split("/").filter((x) => x && x !== "." && x !== "..").map((x) => x.replace(/[<>:"|?*\x00-\x1f]/g, "_")).join("/");
function fenceInfo(info, n) {
  const parts = String(info).trim().split(/\s+/).filter(Boolean);
  const named = parts.map((x) => x.replace(/^(file(name)?|title|nome)=/i, "")).find((x) => /[\w-]\.[A-Za-z0-9]{1,8}["'`]?$/.test(x));
  const lang = (parts[0] && parts[0] !== named && !/=/.test(parts[0]) ? parts[0] : "").toLowerCase();
  const name = named ? safeName(named) : "";
  return { lang, name: name || `trecho-${n}.${LANG_EXT[lang] || "txt"}`, named: !!name };
}
// Divide o Markdown em trechos de texto e blocos de código. Um bloco aberto sem fechamento vai até o fim.
function splitFences(md) {
  const out = [];
  let text = [], code = null, n = 0;
  for (const line of String(md).split("\n")) {
    const f = line.match(FENCE);
    if (code) {
      if (f && f[1][0] === code.fence[0] && f[1].length >= code.fence.length && !f[2].trim()) out.push(code), (code = null);
      else code.lines.push(line);
    } else if (f) {
      if (text.length) out.push({ type: "text", text: text.join("\n") }), (text = []);
      code = { type: "code", fence: f[1], ...fenceInfo(f[2], ++n), lines: [] };
    } else text.push(line);
  }
  if (code) out.push(code);
  if (text.length) out.push({ type: "text", text: text.join("\n") });
  return out.map((p) => (p.type === "code" ? { type: "code", lang: p.lang, name: p.name, named: p.named, text: p.lines.join("\n") + "\n" } : p));
}

// Arquivos escritos pela IA numa resposta: [{ name, lang, text, named }]. Nomes repetidos ganham sufixo.
export function codeFiles(md) {
  const seen = new Map();
  return splitFences(md)
    .filter((p) => p.type === "code")
    .map((p) => {
      const k = p.name.toLowerCase();
      const c = seen.get(k) || 0;
      seen.set(k, c + 1);
      return { ...p, name: c ? p.name.replace(/(\.[^./]+)?$/, (ext) => `-${c + 1}${ext}`) : p.name };
    });
}

// Markdown simples (títulos, listas, tarefas, negrito, blocos de código) para HTML seguro.
// files: true põe o botão de baixar em cada bloco de código (só na tela do app; exportação e cópia ficam sem).
export function mdToHtml(md, { files = false } = {}) {
  const out = [];
  const names = files ? codeFiles(md).map((f) => f.name) : [];
  let k = 0;
  for (const part of splitFences(md)) {
    if (part.type === "code") {
      const i = k++;
      const head = files ? `<div class="code-head"><span>${esc(names[i])}</span><button type="button" class="linkish" data-file="${i}">Baixar</button></div>` : part.named ? `<div class="code-head"><span>${esc(part.name)}</span></div>` : "";
      out.push(`<div class="code">${head}<pre><code>${esc(part.text.replace(/\n$/, ""))}</code></pre></div>`);
    } else out.push(mdLines(part.text));
  }
  return out.join("");
}
function mdLines(md) {
  const out = [];
  let inList = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  for (const line of String(md).split("\n")) {
    const li = line.match(/^\s*[-*]\s+(\[( |x)\]\s+)?(.*)$/i);
    if (li) {
      if (!inList) out.push("<ul>"), (inList = true);
      out.push(li[1] ? `<li class="task">${li[2].trim() ? "☑" : "☐"} ${inline(li[3])}</li>` : `<li>${inline(li[3])}</li>`);
      continue;
    }
    if (inList) out.push("</ul>"), (inList = false);
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) out.push(`<h3>${inline(h[2])}</h3>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("");
}

// .zip sem compressão (método "store"), suficiente para pacotes de código; nomes em UTF-8.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipFiles(files, date = new Date()) {
  const enc = new TextEncoder();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.text === "string" ? enc.encode(f.text) : f.data;
    const crc = crc32(data);
    const head = (sig, central) => {
      const b = new DataView(new ArrayBuffer(central ? 46 : 30));
      let p = 0;
      const u32 = (v) => (b.setUint32(p, v, true), (p += 4));
      const u16 = (v) => (b.setUint16(p, v, true), (p += 2));
      u32(sig);
      if (central) u16(20);
      u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0);
      if (central) u16(0), u16(0), u16(0), u32(0), u32(offset);
      return new Uint8Array(b.buffer);
    };
    centrals.push(head(0x02014b50, true), name);
    locals.push(head(0x04034b50, false), name, data);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((s, x) => s + x.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// HTML autocontido: usado na cópia formatada (Docs, Notion, e-mail) e no PDF.
// shotUrls: mapa id -> dataURL das capturas (opcional). ata: false deixa a ata de fora. clean: leitura limpa.
export function toHtml(session, { tags, shotUrls = {}, ata = true, clean = false, include } = {}) {
  const opts = { clean, include };
  const parts = [
    `<h1>${esc(session.title)}</h1>`,
    `<p><b>Plataforma:</b> ${esc(PLATFORM[session.platform] || session.platform)} · <b>Data:</b> ${esc(dateLabel(session.startedAt))}<br><b>Participantes:</b> ${esc(participantNames(session).join(", ") || "—")}</p>`,
  ];
  if (ata && session.summary && session.summary.text) parts.push("<h2>Ata</h2>", mdToHtml(session.summary.text));
  if (inc(opts, "chapters") && session.chapters && session.chapters.length) parts.push("<h2>Capítulos</h2><ul>", ...session.chapters.map((c) => `<li><span style="color:#888">${clock(c.startAt - session.startedAt)}</span> ${esc(c.title)}</li>`), "</ul>");
  const hls = inc(opts, "highlights") ? highlightsOf(session, { clean }) : [];
  if (hls.length) {
    parts.push("<h2>Destaques</h2><ul>");
    for (const b of hls) {
      parts.push(`<li>${esc(b.tags.map((id) => tagLabel(tags, id)).join(" "))} <b>${esc(b.speaker)}</b> (${clock(b.startAt - session.startedAt)}): ${esc(b.text.replace(/\s*\n+\s*/g, " "))}</li>`);
    }
    parts.push("</ul>");
  }
  if (inc(opts, "notes") && session.notes.text.trim()) parts.push("<h2>Notas</h2>", mdToHtml(session.notes.text));
  if (inc(opts, "ai")) {
    const convs = aiConversations(session);
    if (convs.length) {
      parts.push("<h2>Perguntas à IA</h2>");
      for (const c of convs)
        for (const p of c.pairs)
          parts.push(`<h3>${esc(firstLine(p.q))}</h3>`, p.q.length > firstLine(p.q).length ? `<p><b>Pergunta:</b><br>${esc(p.q).replace(/\n/g, "<br>")}</p>` : "", "<p><b>Resposta:</b></p>", mdToHtml(p.a));
    }
  }
  parts.push("<h2>Transcrição</h2>");
  for (const it of items(session, opts)) {
    const t = clock(it.at - session.startedAt);
    if (it.type === "chapter") parts.push(`<h3>${it.chapter.n}. ${esc(it.chapter.title)}</h3>`);
    else if (it.type === "note") parts.push(`<blockquote>📝 <i>${t}</i> ${esc(it.note.text)}</blockquote>`);
    else if (it.type === "shot") {
      const url = shotUrls[it.shot.id];
      parts.push(url ? `<p><i>${t}</i><br><img src="${url}" alt="Captura de tela" style="max-width:100%;border:1px solid #ddd;border-radius:6px"></p>` : `<p><i>${t} 📷 Captura de tela</i></p>`);
    } else {
      const b = it.block;
      const m = marks(b, opts);
      const mark = m.length ? " " + esc(m.map((id) => tagLabel(tags, id)).join(" ")) : "";
      const paras = (b.paras && b.paras.length ? b.paras : [{ at: b.startAt, text: b.text }])
        .map((p, i) => (i ? `<span style="color:#888;font-size:smaller">${clock(p.at - session.startedAt)}</span> ` : "") + esc(p.text).replace(/\n+/g, "<br>"))
        .join("<br><br>");
      parts.push(`<p><b>${esc(b.speaker)}</b> <span style="color:#888">${t}${b.kind === "chat" ? " · chat" : ""}</span>${mark}<br>${paras}</p>`);
    }
  }
  return parts.join("\n");
}

function cues(session, { clean = false } = {}) {
  // Uma legenda por fala (não agrupada), com duração mínima de 1 s.
  return session.entries
    .filter((e) => e.kind === "caption" && (!clean || cleanSpeech(e.text)))
    .map((e, i, all) => {
      const start = e.at - session.startedAt;
      const next = all[i + 1] ? all[i + 1].at - session.startedAt : Infinity;
      const end = Math.min(Math.max(e.updatedAt - session.startedAt, start + 1000), next);
      return { start, end: Math.max(end, start + 1), speaker: speakerName(session, e.speakerId), text: clean ? cleanSpeech(e.text) : e.text };
    });
}

export function toSrt(session, opts) {
  return cues(session, opts)
    .map((c, i) => `${i + 1}\n${cueTime(c.start, ",")} --> ${cueTime(c.end, ",")}\n${c.speaker}: ${c.text}\n`)
    .join("\n");
}

export function toVtt(session, opts) {
  const body = cues(session, opts)
    .map((c) => `${cueTime(c.start, ".")} --> ${cueTime(c.end, ".")}\n<v ${c.speaker}>${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

// ata: false tira a ata, o histórico dela e o modelo usado (o JSON fica só com a reunião).
export function toJson(session, { ata = true } = {}) {
  const { aliases, ...all } = session;
  const { summary, summaryHistory, ataTemplateId, ataPrompt, ...noAta } = all;
  const rest = ata ? all : noAta;
  return JSON.stringify({ ...rest, blocks: toBlocks(session).map(({ texts, ...b }) => b) }, null, 2);
}

export const FORMATS = {
  md: { label: "Markdown (.md)", mime: "text/markdown", render: toMarkdown },
  txt: { label: "Texto (.txt)", mime: "text/plain", render: toText },
  srt: { label: "Legendas SRT (.srt)", mime: "application/x-subrip", render: toSrt },
  vtt: { label: "WebVTT (.vtt)", mime: "text/vtt", render: toVtt },
  json: { label: "JSON (.json)", mime: "application/json", render: toJson },
};

// Nome sugerido no download: "Nome da reunião - Google Meet - 2026-11-05 08h45.md".
// Mantém acentos (o Windows aceita) e troca só os caracteres proibidos em nomes de arquivo.
function cleanName(t) {
  return String(t || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim().slice(0, 90);
}
function exportBase(session) {
  const d = new Date(session.startedAt);
  const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
  const parts = [cleanName(session.title) || "Reunião", cleanName(PLATFORM[session.platform] || session.platform), when].filter(Boolean);
  return parts.join(" - ");
}
export function fileName(session, ext) {
  return `${exportBase(session)}.${ext}`;
}

// Ata em texto puro (para colar em sistemas que não aceitam Markdown): remove a marcação, mantém títulos e listas.
export function ataPlainText(md) {
  return (md || "")
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s+(.*)$/gm, (_, t) => t.toUpperCase())
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*(?!\*)([^*\n]+)\*/g, "$1$2")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/^\s*-\s+\[( |x|X)\]\s+/gm, (_, c) => (c === " " ? "[ ] " : "[x] "))
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*(\d+)\.\s+/gm, "$1. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "――――――――――――――――――――")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ataFileName(session, ext) {
  return `Ata - ${exportBase(session)}.${ext}`;
}

// HTML no formato que o editor do Atena (TinyMCE) produz: parágrafos justificados com rótulo em
// negrito, listas com <li><p>, <hr /> entre seções, bloco de assinatura centralizado. Para colar
// direto no editor ou no "Código-fonte" dele.
export function ataEditorHtml(md) {
  const P = (t, align = "justify") => `<p style="text-align: ${align};">${t}</p>`;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*(?!\*)([^*\n]+)\*/g, "$1<em>$2</em>").replace(/_([^_\n]+)_/g, "<em>$1</em>").replace(/`([^`]+)`/g, "$1");
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  // 1) agrupa em blocos: title | label | list | para | rule
  const blocks = [];
  let list = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*]\s+(\[( |x|X)\]\s+)?(.*)$/);
    if (li) {
      if (!list) blocks.push((list = { kind: "list", items: [] }));
      list.items.push((li[1] ? (li[2].trim() ? "☑ " : "☐ ") : "") + li[3].trim());
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ kind: "rule" }); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { blocks.push({ kind: "title", text: h[1].replace(/\*\*/g, "").trim() }); continue; }
    const onlyBold = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (onlyBold) { blocks.push({ kind: "title", text: onlyBold[1].trim() }); continue; }
    const label = line.match(/^\*\*([^*]+?:)\*\*\s*(.*)$/);
    if (label) { blocks.push({ kind: "label", label: label[1].trim(), text: label[2].trim() }); continue; }
    blocks.push({ kind: "para", text: line.trim() });
  }
  // 2) bloco de assinatura: até 4 linhas curtas no fim, sem dois-pontos, depois do último conteúdo
  let sig = [];
  while (blocks.length && blocks[blocks.length - 1].kind === "rule") blocks.pop();
  for (let i = blocks.length - 1; i >= 0 && sig.length < 4; i--) {
    const b = blocks[i];
    if ((b.kind === "para" || b.kind === "title") && b.text.length <= 70 && !/[:.]$/.test(b.text) && !/[:]/.test(b.text)) sig.unshift(b.text);
    else break;
  }
  if (sig.length >= 2) blocks.splice(blocks.length - sig.length, sig.length);
  else sig = [];
  while (blocks.length && blocks[blocks.length - 1].kind === "rule") blocks.pop();
  // 3) monta o HTML
  const out = [];
  let prev = null;
  for (const b of blocks) {
    if (b.kind === "rule") { if (prev && prev !== "rule") out.push("<hr />"); prev = "rule"; continue; }
    if (b.kind === "title") {
      const needsRule = prev === "list" || prev === "longpara";
      if (needsRule) out.push("<hr />");
      else if (prev && prev !== "rule" && prev !== "title") out.push(P("&nbsp;"));
      out.push(P(`<strong>${inline(b.text)}</strong>`));
      prev = "title";
      continue;
    }
    if (b.kind === "label") { out.push(P(`<strong>${inline(b.label)}</strong>${b.text ? " " + inline(b.text) : ""}`)); prev = "label"; continue; }
    if (b.kind === "list") {
      out.push(`<ul style="text-align: justify;">\n${b.items.map((t) => `<li>\n<p>${inline(t)}</p>\n</li>`).join("\n")}\n</ul>`);
      prev = "list";
      continue;
    }
    out.push(P(inline(b.text)));
    prev = b.text.length > 120 ? "longpara" : "para";
  }
  if (sig.length) {
    out.push("<hr />", P("&nbsp;", "center"));
    sig.forEach((t, i) => out.push(P(i === 0 ? `<strong>${inline(t)}</strong>` : inline(t), "center")));
  }
  return out.join("\n");
}
