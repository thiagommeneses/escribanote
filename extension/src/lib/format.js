// Exportação da reunião em vários formatos.
import { toBlocks, speakerName, timeline, participantNames } from "./transcript.js";

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

function tagLabel(tags, id) {
  const t = (tags || DEFAULT_TAGS).find((x) => x.id === id);
  return t ? `${t.emoji} ${t.label}` : id;
}

function highlightsOf(session) {
  return toBlocks(session).filter((b) => b.tags.length);
}

export function toText(session, opts = {}) {
  const head = `${session.title}\n${PLATFORM[session.platform] || session.platform} · ${dateLabel(session.startedAt)}\n`;
  const body = timeline(session, opts)
    .map((it) => {
      const t = `[${clock(it.at - session.startedAt)}]`;
      if (it.type === "note") return `${t} 📝 Nota: ${it.note.text}`;
      if (it.type === "shot") return `${t} 📷 Captura de tela`;
      if (it.type === "chapter") return `--- ${it.chapter.n}. ${it.chapter.title} ---`;
      const b = it.block;
      const tag = b.kind === "chat" ? " (chat)" : "";
      const mark = b.tags.length ? ` [${b.tags.map((id) => tagLabel(opts.tags, id)).join(", ")}]` : "";
      return `${t} ${b.speaker}${tag}${mark}: ${blockText(session, b, (c) => `[${c}]`)}`;
    })
    .join("\n\n");
  return `${head}\n${body}\n`;
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
  if (session.summary && session.summary.text) lines.push("## Ata", "", session.summary.text.trim(), "");
  const hls = highlightsOf(session);
  if (hls.length) {
    lines.push("## Destaques", "");
    for (const b of hls) {
      lines.push(`- ${b.tags.map((id) => tagLabel(opts.tags, id)).join(" ")} **${b.speaker}** (\`${clock(b.startAt - session.startedAt)}\`): ${b.text.replace(/\s*\n+\s*/g, " ")}`);
    }
    lines.push("");
  }
  if (session.notes.text.trim()) lines.push("## Notas", "", session.notes.text.trim(), "");
  if (session.chapters && session.chapters.length) {
    lines.push("## Capítulos", "");
    for (const c of session.chapters) lines.push(`- \`${clock(c.startAt - session.startedAt)}\` ${c.title}`);
    lines.push("");
  }
  lines.push("## Transcrição", "");
  for (const it of timeline(session, opts)) {
    const t = `\`${clock(it.at - session.startedAt)}\``;
    if (it.type === "chapter") { lines.push(`### ${it.chapter.n}. ${it.chapter.title}`, ""); continue; }
    if (it.type === "note") lines.push(`> 📝 ${t} ${it.note.text}`, "");
    else if (it.type === "shot") lines.push(`> 📷 ${t} Captura de tela`, "");
    else {
      const b = it.block;
      const tag = b.kind === "chat" ? " _(chat)_" : "";
      const mark = b.tags.length ? " " + b.tags.map((id) => tagLabel(opts.tags, id)).join(" ") : "";
      lines.push(`**${b.speaker}**${tag} · ${t}${mark}`, "", blockText(session, b, (c) => `\`${c}\``), "");
    }
  }
  return lines.join("\n");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Markdown simples (títulos, listas, tarefas, negrito) para HTML seguro.
export function mdToHtml(md) {
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

// HTML autocontido: usado na cópia formatada (Docs, Notion, e-mail) e no PDF.
// shotUrls: mapa id -> dataURL das capturas (opcional).
export function toHtml(session, { tags, shotUrls = {} } = {}) {
  const parts = [
    `<h1>${esc(session.title)}</h1>`,
    `<p><b>Plataforma:</b> ${esc(PLATFORM[session.platform] || session.platform)} · <b>Data:</b> ${esc(dateLabel(session.startedAt))}<br><b>Participantes:</b> ${esc(participantNames(session).join(", ") || "—")}</p>`,
  ];
  if (session.summary && session.summary.text) parts.push("<h2>Ata</h2>", mdToHtml(session.summary.text));
  if (session.chapters && session.chapters.length) parts.push("<h2>Capítulos</h2><ul>", ...session.chapters.map((c) => `<li><span style="color:#888">${clock(c.startAt - session.startedAt)}</span> ${esc(c.title)}</li>`), "</ul>");
  const hls = highlightsOf(session);
  if (hls.length) {
    parts.push("<h2>Destaques</h2><ul>");
    for (const b of hls) {
      parts.push(`<li>${esc(b.tags.map((id) => tagLabel(tags, id)).join(" "))} <b>${esc(b.speaker)}</b> (${clock(b.startAt - session.startedAt)}): ${esc(b.text.replace(/\s*\n+\s*/g, " "))}</li>`);
    }
    parts.push("</ul>");
  }
  if (session.notes.text.trim()) parts.push("<h2>Notas</h2>", mdToHtml(session.notes.text));
  parts.push("<h2>Transcrição</h2>");
  for (const it of timeline(session)) {
    const t = clock(it.at - session.startedAt);
    if (it.type === "chapter") parts.push(`<h3>${it.chapter.n}. ${esc(it.chapter.title)}</h3>`);
    else if (it.type === "note") parts.push(`<blockquote>📝 <i>${t}</i> ${esc(it.note.text)}</blockquote>`);
    else if (it.type === "shot") {
      const url = shotUrls[it.shot.id];
      parts.push(url ? `<p><i>${t}</i><br><img src="${url}" alt="Captura de tela" style="max-width:100%;border:1px solid #ddd;border-radius:6px"></p>` : `<p><i>${t} 📷 Captura de tela</i></p>`);
    } else {
      const b = it.block;
      const mark = b.tags.length ? " " + esc(b.tags.map((id) => tagLabel(tags, id)).join(" ")) : "";
      const paras = (b.paras && b.paras.length ? b.paras : [{ at: b.startAt, text: b.text }])
        .map((p, i) => (i ? `<span style="color:#888;font-size:smaller">${clock(p.at - session.startedAt)}</span> ` : "") + esc(p.text).replace(/\n+/g, "<br>"))
        .join("<br><br>");
      parts.push(`<p><b>${esc(b.speaker)}</b> <span style="color:#888">${t}${b.kind === "chat" ? " · chat" : ""}</span>${mark}<br>${paras}</p>`);
    }
  }
  return parts.join("\n");
}

function cues(session) {
  // Uma legenda por fala (não agrupada), com duração mínima de 1 s.
  return session.entries
    .filter((e) => e.kind === "caption")
    .map((e, i, all) => {
      const start = e.at - session.startedAt;
      const next = all[i + 1] ? all[i + 1].at - session.startedAt : Infinity;
      const end = Math.min(Math.max(e.updatedAt - session.startedAt, start + 1000), next);
      return { start, end: Math.max(end, start + 1), speaker: speakerName(session, e.speakerId), text: e.text };
    });
}

export function toSrt(session) {
  return cues(session)
    .map((c, i) => `${i + 1}\n${cueTime(c.start, ",")} --> ${cueTime(c.end, ",")}\n${c.speaker}: ${c.text}\n`)
    .join("\n");
}

export function toVtt(session) {
  const body = cues(session)
    .map((c) => `${cueTime(c.start, ".")} --> ${cueTime(c.end, ".")}\n<v ${c.speaker}>${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toJson(session) {
  const { aliases, ...rest } = session;
  return JSON.stringify({ ...rest, blocks: toBlocks(session).map(({ texts, ...b }) => b) }, null, 2);
}

export const FORMATS = {
  md: { label: "Markdown (.md)", mime: "text/markdown", render: toMarkdown },
  txt: { label: "Texto (.txt)", mime: "text/plain", render: toText },
  srt: { label: "Legendas SRT (.srt)", mime: "application/x-subrip", render: toSrt },
  vtt: { label: "WebVTT (.vtt)", mime: "text/vtt", render: toVtt },
  json: { label: "JSON (.json)", mime: "application/json", render: toJson },
};

export function fileName(session, ext) {
  const d = new Date(session.startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = session.title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .toLowerCase();
  return `${stamp}_${slug || "reuniao"}.${ext}`;
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
  const d = new Date(session.startedAt);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slug = (session.title || "reuniao").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "reuniao";
  return `ata-${stamp}-${slug}.${ext}`;
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
