// Exportação da reunião em vários formatos.
import { toBlocks, speakerName, timeline, participantNames } from "./transcript.js";
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

export const PLATFORM = { meet: "Google Meet", teams: "Microsoft Teams", zoom: "Zoom", slack: "Slack", desktop: "Áudio do computador" };

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
      const b = it.block;
      const tag = b.kind === "chat" ? " (chat)" : "";
      const mark = b.tags.length ? ` [${b.tags.map((id) => tagLabel(opts.tags, id)).join(", ")}]` : "";
      return `${t} ${b.speaker}${tag}${mark}: ${b.text}`;
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
      lines.push(`- ${b.tags.map((id) => tagLabel(opts.tags, id)).join(" ")} **${b.speaker}** (\`${clock(b.startAt - session.startedAt)}\`): ${b.text}`);
    }
    lines.push("");
  }
  if (session.notes.text.trim()) lines.push("## Notas", "", session.notes.text.trim(), "");
  lines.push("## Transcrição", "");
  for (const it of timeline(session, opts)) {
    const t = `\`${clock(it.at - session.startedAt)}\``;
    if (it.type === "note") lines.push(`> 📝 ${t} ${it.note.text}`, "");
    else if (it.type === "shot") lines.push(`> 📷 ${t} Captura de tela`, "");
    else {
      const b = it.block;
      const tag = b.kind === "chat" ? " _(chat)_" : "";
      const mark = b.tags.length ? " " + b.tags.map((id) => tagLabel(opts.tags, id)).join(" ") : "";
      lines.push(`**${b.speaker}**${tag} · ${t}${mark}`, "", b.text, "");
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
  const hls = highlightsOf(session);
  if (hls.length) {
    parts.push("<h2>Destaques</h2><ul>");
    for (const b of hls) {
      parts.push(`<li>${esc(b.tags.map((id) => tagLabel(tags, id)).join(" "))} <b>${esc(b.speaker)}</b> (${clock(b.startAt - session.startedAt)}): ${esc(b.text)}</li>`);
    }
    parts.push("</ul>");
  }
  if (session.notes.text.trim()) parts.push("<h2>Notas</h2>", mdToHtml(session.notes.text));
  parts.push("<h2>Transcrição</h2>");
  for (const it of timeline(session)) {
    const t = clock(it.at - session.startedAt);
    if (it.type === "note") parts.push(`<blockquote>📝 <i>${t}</i> ${esc(it.note.text)}</blockquote>`);
    else if (it.type === "shot") {
      const url = shotUrls[it.shot.id];
      parts.push(url ? `<p><i>${t}</i><br><img src="${url}" alt="Captura de tela" style="max-width:100%;border:1px solid #ddd;border-radius:6px"></p>` : `<p><i>${t} 📷 Captura de tela</i></p>`);
    } else {
      const b = it.block;
      const mark = b.tags.length ? " " + esc(b.tags.map((id) => tagLabel(tags, id)).join(" ")) : "";
      parts.push(`<p><b>${esc(b.speaker)}</b> <span style="color:#888">${t}${b.kind === "chat" ? " · chat" : ""}</span>${mark}<br>${esc(b.text)}</p>`);
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
