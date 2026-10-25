import { toBlocks, speakerName, timeline, participantNames, normalize } from "../lib/transcript.js";
import { FORMATS, fileName, clock, toText, toHtml, mdToHtml, PLATFORM, dateLabel, ataPlainText, ataFileName, ataEditorHtml } from "../lib/format.js";
import { computeStats, findMe, fmtDuration } from "../lib/stats.js";
import { QUICK_PROMPTS, API_ORIGIN } from "../lib/ai.js";
import { getSettings, setSettings, DEFAULT_TAGS, MODELS, DEFAULTS, HQ_MODELS } from "../lib/settings.js";
import { LANG_NAMES } from "../lib/lang.js";
import { diffDocument, diffStats, diffHtml as versionDiffHtml } from "../lib/diff.js";
import { getBackupDir, setBackupDir, backupPermission, resolveBackupFolder, readBackupFolder } from "../lib/backup.js";

const $ = (id) => document.getElementById(id);
const PALETTE = ["#2f6bff", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#65a30d"];
const params = new URLSearchParams(location.search);
const IS_TAB = params.has("id") || params.has("tab");

const state = {
  view: "meeting",
  tab: "transcript",
  tabId: null,
  session: null,
  pinned: false,
  settings: { ...DEFAULTS },
  query: "",
  hidden: new Set(),
  follow: true,
  listQuery: "",
  listFilter: "all",
  searchHits: null,
  index: [],
  shots: {},
  chatId: null,
  aiPort: null,
  busy: null, // "ata" | "chat" | "review"
  hq: { state: "idle" },
  hqAutoTried: new Set(),
  showOrig: new Set(),
  langIssue: null,
};

const send = async (msg) => {
  const r = await chrome.runtime.sendMessage(msg);
  if (r && r.error) throw new Error(r.error);
  return r;
};

// ---------------- Utilidades ----------------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function highlight(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(name) {
  const p = String(name).replace(/^Participante\s+/, "#").split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function avatar(id, name, size) {
  const st = size ? `width:${size}px;height:${size}px;` : "";
  // A cor segue o nome, para ser a mesma na lista, na transcrição e no widget.
  return `<span class="av" style="${st}background:${colorFor(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
}
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2400);
}
// Destaca as palavras que a revisão mudou (LCS por palavra).
function diffHtml(original, fixed) {
  const a = original.split(/\s+/);
  const b = fixed.split(/\s+/);
  if (a.length * b.length > 250_000) return esc(fixed);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i].toLowerCase() === b[j].toLowerCase() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i].toLowerCase() === b[j].toLowerCase()) {
      out.push(esc(b[j]));
      i++;
      j++;
    } else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else out.push(`<ins>${esc(b[j++])}</ins>`);
  }
  return out.join(" ").replace(/<\/ins> <ins>/g, " ");
}

function tags() {
  return state.settings.tags && state.settings.tags.length ? state.settings.tags : DEFAULT_TAGS;
}
function tagById(id) {
  return tags().find((t) => t.id === id) || { id, label: id, emoji: "🏷", color: "#888" };
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
}
function isLive(s) {
  return s && !s.endedAt && Date.now() - s.updatedAt < 5 * 60 * 1000;
}
async function ensureApiPermission() {
  if (await chrome.permissions.contains({ origins: [API_ORIGIN] })) return true;
  return chrome.permissions.request({ origins: [API_ORIGIN] });
}

// ---------------- Layout ----------------
function applyLayout() {
  const wide = IS_TAB && innerWidth >= 860;
  document.body.classList.toggle("wide", wide);
  document.body.classList.toggle("narrow", innerWidth < 420);
  $("pop-out").hidden = IS_TAB;
  render();
}
addEventListener("resize", () => {
  clearTimeout(applyLayout.t);
  applyLayout.t = setTimeout(applyLayout, 120);
});

function nav(view) {
  state.view = view;
  // No painel lateral, "Reunião" sempre volta para a reunião da aba atual.
  if (view === "meeting" && (!IS_TAB || !state.session)) {
    state.pinned = false;
    followCurrent();
  }
  render();
}
for (const b of document.querySelectorAll("[data-nav]")) b.addEventListener("click", () => nav(b.dataset.nav));
$("pop-out").addEventListener("click", () =>
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/app.html?${state.session ? "id=" + state.session.id : "tab=1"}`) }),
);

function render() {
  const wide = document.body.classList.contains("wide");
  document.body.classList.toggle("on-settings", state.view === "settings");
  for (const b of document.querySelectorAll(".nav [data-nav]")) b.setAttribute("aria-current", b.dataset.nav === state.view);
  $("view-settings").hidden = state.view !== "settings";
  $("view-meeting").hidden = state.view === "settings" || (!wide && state.view === "list");
  $("view-list").hidden = wide ? state.view === "settings" : state.view !== "list";
  $("live-badge").hidden = !isLive(state.session) || state.pinned;
  if (state.view === "settings") renderSettings();
  if (!$("view-list").hidden) renderList();
  if (!$("view-meeting").hidden) renderMeeting();
}

// ---------------- Sessão atual ----------------
async function followCurrent() {
  if (IS_TAB) {
    // Na aba cheia, "Reunião" mostra a reunião mais recente.
    const index = await send({ type: "list" });
    return openSession(index[0] ? index[0].id : null, false);
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  const id = state.tabId != null ? await send({ type: "active-for-tab", tabId: state.tabId }) : null;
  await openSession(id, false);
}

async function openSession(id, pinned) {
  const changedSession = !state.session || state.session.id !== id;
  state.pinned = pinned;
  if (changedSession) {
    state.hidden.clear();
    state.follow = true;
    state.query = "";
    $("t-search").value = "";
    state.chatId = null;
    state.shots = {};
  }
  const s = id ? await send({ type: "get", id }) : null;
  state.session = s ? normalize(s) : null;
  if (state.session && state.session.shots.length && Object.keys(state.shots).length !== state.session.shots.length) {
    state.shots = (await send({ type: "get-shots", id })) || {};
  }
  if (IS_TAB && state.session) history.replaceState(null, "", `?id=${state.session.id}`);
  if (state.session) {
    state.hq = (await send({ type: "hq-get", tabId: state.tabId, id: state.session.id })) || { state: "idle" };
    state.langIssue = isLive(state.session) ? await send({ type: "lang-issue", id: state.session.id }) : null;
  }
  render();
  maybeAutoHq();
}

// Com "Alta precisão" ligada nos ajustes, liga sozinho quando o painel abre na aba da reunião.
async function maybeAutoHq() {
  const s = state.session;
  if (IS_TAB || !s || !isLive(s) || (state.settings.hq === "off" && s.platform !== "slack") || state.hq.state !== "idle") return;
  if (state.tabId == null || state.hqAutoTried.has(state.tabId)) return;
  state.hqAutoTried.add(state.tabId);
  try {
    await send({ type: "hq-start", tabId: state.tabId, id: s.id });
  } catch (err) {
    toast(err.message);
  }
}

async function reloadSession() {
  if (!state.session) return;
  await openSession(state.session.id, state.pinned);
}

// ---------------- Reunião ----------------
function renderMeeting() {
  const s = state.session;
  $("m-empty").hidden = !!s;
  $("m").hidden = !s;
  if (!s) return renderRecent();

  if (document.activeElement !== $("m-title")) $("m-title").value = s.title;
  const names = participantNames(s);
  const end = s.endedAt || s.updatedAt;
  $("m-meta").innerHTML = [
    `<span>${esc(PLATFORM[s.platform] || s.platform)}</span>`,
    `<span>${esc(dateLabel(s.startedAt))}</span>`,
    `<span>${fmtDuration(end - s.startedAt)}</span>`,
    `<span>${names.length} participante${names.length === 1 ? "" : "s"}</span>`,
    isLive(s) ? `<span style="color:var(--danger);font-weight:600">● ${s.paused ? "pausado" : "gravando"}</span>` : "",
  ].join("");
  $("m-pause").hidden = !isLive(s);
  renderHqButton();
  renderBanner();
  $("m-pause").innerHTML = s.paused
    ? '<svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>Retomar'
    : '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>Pausar';

  const hlCount = toBlocks(s).filter((b) => b.tags.length).length;
  $("c-hl").textContent = hlCount || "";
  $("c-notes").textContent = s.notes.items.length || "";
  for (const b of document.querySelectorAll(".subtabs button")) b.setAttribute("aria-selected", b.dataset.tab === state.tab);
  const nv = (s.summaryHistory || []).length;
  $("c-ata").textContent = nv > 1 ? `v${nv}` : "";
  for (const p of ["transcript", "highlights", "notes", "ata", "ai", "stats"]) $(`pane-${p}`).hidden = p !== state.tab;

  ({ transcript: renderTranscript, highlights: renderHighlights, notes: renderNotes, ata: renderAta, ai: renderAI, stats: renderStats })[state.tab]();
}

function renderHqButton() {
  const s = state.session;
  const b = $("m-hq");
  b.hidden = !isLive(s) || s.recorder; // o gravador do computador já transcreve com o Whisper
  const h = state.hq || { state: "idle" };
  const label = {
    idle: "🎧 Alta precisão",
    starting: "🎧 Iniciando…",
    loading: `🎧 Baixando modelo ${h.progress || 0}%`,
    running: `🎧 Alta precisão ativa${h.device === "webgpu" ? " · GPU" : ""}`,
    error: "🎧 Tentar de novo",
  }[h.state] || "🎧 Alta precisão";
  b.textContent = label;
  b.classList.toggle("on", h.state === "running");
  b.title = h.state === "running"
    ? `Whisper rodando neste computador${h.rtf ? ` · ${h.rtf < 1 ? "mais rápido que" : "mais lento que"} o tempo real (${h.rtf}x)` : ""}. Clique para desligar.`
    : "Transcreve de novo o áudio da reunião com o Whisper, neste computador";
}

function renderBanner() {
  const parts = [];
  // Aberto sozinho ao sair da chamada (ajuste "Ao sair da reunião")
  if (params.get("fim") && state.session?.endedAt && params.get("id") === state.session.id) {
    parts.push(`<div class="banner"><b>A chamada terminou e a transcrição foi encerrada.</b> ${state.session.summary?.text ? "A ata já está na aba <b>Ata</b>." : state.settings.autoAta ? "A ata está sendo gerada e aparece na aba <b>Ata</b>." : "Gere a ata na aba <b>Ata</b>,"} revise os destaques ou exporte pelo botão <b>Exportar</b>.</div>`);
  }
  const li = state.langIssue;
  if (li) {
    parts.push(`<div class="banner warn"><b>As legendas parecem estar em ${esc(LANG_NAMES[li.seen] || li.seen)}</b>, mas a reunião é em ${esc(LANG_NAMES[li.expected] || li.expected)}.
      Isso derruba a qualidade da transcrição. No Meet: <i>Mais opções › Configurações › Legendas › Idioma da reunião</i>.${state.hq.state === "running" ? "" : " Ou ligue a <b>Alta precisão</b>, que não depende das legendas."}</div>`);
  }
  if (state.hq.state === "error" && state.hq.message) parts.push(`<div class="banner warn">🎧 ${esc(state.hq.message)}</div>`);
  if (state.hq.warning) parts.push(`<div class="banner">${esc(state.hq.warning)}</div>`);
  $("t-banner").innerHTML = parts.join("");
}

$("m-hq").addEventListener("click", async () => {
  const s = state.session;
  if (!s) return;
  try {
    if (["running", "loading", "starting"].includes(state.hq.state)) {
      await send({ type: "hq-stop", tabId: state.tabId, id: s.id });
      toast("Alta precisão desligada");
    } else {
      if (state.settings.hq === "off") state.settings = await setSettings({ hq: "base" });
      await send({ type: "hq-start", tabId: state.tabId, id: s.id });
    }
  } catch (err) {
    toast(err.message);
  }
});

async function renderRecent() {
  const index = await send({ type: "list" });
  $("recent").innerHTML = index.length
    ? `<div class="day">Reuniões recentes</div>` + index.slice(0, 4).map(cardHtml).join("")
    : `<p class="restore-hint">Reinstalou o Escribanote ou trocou de computador?
        <button type="button" class="linkish" data-bk-restore>Restaurar de uma pasta de backup</button></p>`;
}

for (const b of document.querySelectorAll(".subtabs button")) {
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    renderMeeting();
    scrollPaneTop();
  });
}
// Volta ao topo da área rolável ao trocar de aba (senão a aba nova abre no meio).
function scrollPaneTop() {
  let el = document.querySelector(".subtabs");
  while (el && el !== document.body) {
    const o = getComputedStyle(el).overflowY;
    if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) { el.scrollTop = 0; return; }
    el = el.parentElement;
  }
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-goto-view]");
  if (v) return nav(v.dataset.gotoView);
  const b = e.target.closest("[data-goto-tab]");
  if (!b) return;
  state.tab = b.dataset.gotoTab;
  renderMeeting();
  scrollPaneTop();
});

$("m-title").addEventListener("change", async (e) => {
  if (!state.session) return;
  state.session = normalize(await send({ type: "update", id: state.session.id, title: e.target.value }));
  renderMeeting();
});

$("m-pause").addEventListener("click", async () => {
  state.session = normalize(await send({ type: "pause", id: state.session.id, paused: !state.session.paused }));
  toast(state.session.paused ? "Transcrição pausada" : "Transcrição retomada");
  renderMeeting();
});

$("m-delete").addEventListener("click", async () => {
  if (!state.session || !confirm(`Apagar “${state.session.title}”? Esta ação não pode ser desfeita.`)) return;
  await send({ type: "delete", id: state.session.id });
  state.session = null;
  toast("Reunião apagada");
  render();
});

// ----- Exportar -----
function buildExportMenu() {
  const items = [
    ["rich", "📋", "Copiar formatado", "Docs, Notion, e-mail"],
    ["plain", "📄", "Copiar como texto", ""],
    ["pdf", "🖨️", "Salvar como PDF", "com capturas"],
    null,
    ...Object.entries(FORMATS).map(([ext, f]) => [ext, "⬇", f.label, ""]),
  ];
  $("export-menu").innerHTML = items
    .map((it) => (it ? `<button data-exp="${it[0]}"><span>${it[1]}</span>${esc(it[2])}${it[3] ? `<small>${esc(it[3])}</small>` : ""}</button>` : "<hr>"))
    .join("");
}
buildExportMenu();
$("m-export").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("export-menu");
  menu.hidden = !menu.hidden;
  if (menu.hidden) return;
  // No painel lateral (estreito) o menu não cabe à direita do botão: ancora pela direita.
  menu.classList.remove("flip");
  const r = menu.getBoundingClientRect();
  if (r.right > document.documentElement.clientWidth - 8) menu.classList.add("flip");
});
document.addEventListener("click", () => ($("export-menu").hidden = true));
$("export-menu").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-exp]");
  if (!b || !state.session) return;
  const s = state.session;
  const kind = b.dataset.exp;
  try {
    if (kind === "rich") {
      const html = toHtml(s, { tags: tags() });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([toText(s, { tags: tags() })], { type: "text/plain" }) }),
      ]);
      toast("Copiado — cole no Google Docs, Notion ou e-mail");
    } else if (kind === "plain") {
      await navigator.clipboard.writeText(toText(s, { tags: tags() }));
      toast("Transcrição copiada");
    } else if (kind === "pdf") {
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/print.html?id=${s.id}`) });
    } else {
      const f = FORMATS[kind];
      const url = URL.createObjectURL(new Blob([f.render(s, { tags: tags() })], { type: `${f.mime};charset=utf-8` }));
      const a = Object.assign(document.createElement("a"), { href: url, download: fileName(s, kind) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  } catch (err) {
    toast("Não foi possível exportar: " + err.message);
  }
});

// ----- Editor flutuante (o painel lateral bloqueia prompt()) -----
// Abre um cartão ancorado no elemento clicado com um campo de texto; resolve com o texto ou null.
function askInline(anchor, { label, value = "", placeholder = "", suggestions = [] } = {}) {
  closeInline();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<label class="field-label">${esc(label)}</label>
      <input maxlength="120" list="pop-list" placeholder="${esc(placeholder)}">
      <datalist id="pop-list">${suggestions.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div class="ask-acts"><button class="btn sm" data-cancel>Cancelar</button><button class="btn sm primary" data-ok>Salvar</button></div>`;
    document.body.appendChild(pop);
    const input = pop.querySelector("input");
    input.value = value;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(280, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    const below = r.bottom + 8;
    pop.style.top = (below + 130 > innerHeight ? Math.max(12, r.top - 130) : below) + "px";
    const done = (v) => {
      pop.remove();
      document.removeEventListener("mousedown", outside, true);
      closeInline.current = null;
      resolve(v);
    };
    const outside = (ev) => !pop.contains(ev.target) && done(null);
    pop.querySelector("[data-ok]").onclick = () => done(input.value.trim() || null);
    pop.querySelector("[data-cancel]").onclick = () => done(null);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") done(input.value.trim() || null);
      if (ev.key === "Escape") done(null);
    });
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
    closeInline.current = () => done(null);
    input.focus();
    input.select();
  });
}
function closeInline() {
  if (closeInline.current) closeInline.current();
}
// Pergunta com até três respostas; resolve com a chave da escolhida (ou null).
function askChoice(anchor, { title, text, choices }) {
  closeInline();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<b>${esc(title)}</b><p class="muted tiny" style="margin:0">${esc(text)}</p>
      <div class="ask-acts">${choices.map((c) => `<button class="btn sm${c.primary ? " primary" : ""}" data-choice="${esc(c.key)}">${esc(c.label)}</button>`).join("")}</div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = Math.min(320, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + 8 + 150 > innerHeight ? Math.max(12, r.top - 150) : r.bottom + 8) + "px";
    const done = (v) => {
      pop.remove();
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      closeInline.current = null;
      resolve(v);
    };
    const outside = (ev) => !pop.contains(ev.target) && done(null);
    const onKey = (ev) => ev.key === "Escape" && done(null);
    pop.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-choice]");
      if (b) done(b.dataset.choice);
    });
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    closeInline.current = () => done(null);
    (pop.querySelector(".primary") || pop.querySelector("button")).focus();
  });
}
// Outro falante que já usa esse nome (ignorando maiúsculas e espaços)?
function speakerWithName(s, name, exceptId) {
  const key = name.trim().toLowerCase();
  const ids = [...new Set([...Object.keys(s.speakers), ...s.entries.map((e) => e.speakerId), ...s.asr.map((a) => a.speakerId)])];
  return ids.find((id) => id && id !== exceptId && !s.merged?.[id] && speakerName(s, id).trim().toLowerCase() === key) || null;
}

// Renomeia um falante (vale para a reunião ao vivo e para as já encerradas).
async function renameSpeaker(id, anchor) {
  const s = state.session;
  if (!s || !id) return;
  const current = speakerName(s, id);
  const others = [...new Set(Object.values(s.speakers))].filter((n) => n && n !== current);
  const name = await askInline(anchor, { label: "Nome do participante", value: current, placeholder: "Como aparece na ata", suggestions: others });
  if (!name || name === current) return;
  const other = speakerWithName(s, name, id);
  if (other) {
    // Já existe alguém com esse nome: oferece juntar os dois num só participante.
    const choice = await askChoice(anchor, {
      title: `Mesclar com ${speakerName(s, other)}?`,
      text: `As falas de ${current} passam a ser de ${speakerName(s, other)}, e os dois viram um único participante. Isso não pode ser desfeito.`,
      choices: [{ key: "merge", label: "Mesclar", primary: true }, { key: "rename", label: "Manter separados" }, { key: "cancel", label: "Cancelar" }],
    });
    if (!choice || choice === "cancel") return;
    if (choice === "merge") {
      const r = await send({ type: "merge-speakers", id: s.id, from: id, to: other });
      state.session = normalize(r);
      state.hidden.delete(id);
      renderMeeting();
      toast(`${current} mesclado em ${speakerName(state.session, other)}`);
      return;
    }
  }
  state.session = normalize(await send({ type: "update", id: s.id, speakers: { [id]: name.slice(0, 120) } }));
  renderMeeting();
  toast(`${current} agora é ${name}`);
}

// ----- Transcrição -----
function renderSpeakers(s) {
  const ids = [...new Set(s.entries.map((e) => e.speakerId))];
  $("speakers").innerHTML = ids
    .map((id) => {
      const name = speakerName(s, id);
      return `<span class="spk${state.hidden.has(id) ? " off" : ""}" data-id="${esc(id)}" title="Clique para mostrar ou ocultar as falas">${avatar(id, name)}${esc(name)}<button class="spk-edit" data-rename title="Renomear"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button></span>`;
    })
    .join("");
}

$("speakers").addEventListener("click", (e) => {
  const chip = e.target.closest(".spk");
  if (!chip) return;
  const id = chip.dataset.id;
  if (e.target.closest("[data-rename]")) return; // tratado no pointerdown
  state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
  renderTranscript();
});
// Renomear no pointerdown: com a reunião ao vivo, a transcrição é redesenhada a cada fala e um clique
// completo (mousedown → mouseup no mesmo elemento) pode se perder no redesenho.
for (const el of [$("timeline"), $("speakers")]) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const who = e.target.closest("[data-speaker]");
    if (who) {
      e.preventDefault();
      return renameSpeaker(who.dataset.speaker, who);
    }
    const pencil = e.target.closest("[data-rename]");
    if (pencil) {
      e.preventDefault();
      return renameSpeaker(pencil.closest(".spk").dataset.id, pencil.closest(".spk"));
    }
  });
}
$("speakers").addEventListener("dblclick", (e) => {
  const chip = e.target.closest(".spk");
  if (chip) renameSpeaker(chip.dataset.id, chip);
});

function blockHtml(s, b, q) {
  const tagChips = b.tags
    .map((id) => {
      const t = tagById(id);
      return `<span class="tag" style="color:${t.color};border-color:${t.color}">${t.emoji} ${esc(t.label)}</span>`;
    })
    .join("");
  const acts = tags().map((t) => `<button data-tag="${t.id}" class="${b.tags.includes(t.id) ? "on" : ""}" title="${esc(t.label)}">${t.emoji}</button>`).join("");
  const badges =
    (b.hq ? '<span class="badge-hq" title="Transcrito pela alta precisão (Whisper local)">🎧</span>' : "") +
    (b.fixed ? `<span class="badge-fix" data-act="orig" title="Revisado pela IA — clique para ver o original">✓ revisado</span>` : "");
  const body = q ? highlight(b.text, q) : b.fixed ? diffHtml(b.original, b.text) : esc(b.text);
  const orig = b.fixed && state.showOrig.has(b.key) ? `<p class="orig">${esc(b.original)}</p>` : "";
  return `<li class="blk${b.kind === "chat" ? " chat" : ""}" data-key="${esc(b.key)}" data-ids="${esc(JSON.stringify(b.ids))}" data-tags="${esc(JSON.stringify(b.tags))}" data-at="${b.endAt}">
    ${avatar(b.speakerId, b.speaker, 32)}
    <div><div class="who"><b style="color:${colorFor(b.speaker)}" data-speaker="${esc(b.speakerId)}" title="Clique para renomear">${highlight(b.speaker, q)}</b><time>${clock(b.startAt - s.startedAt)}</time>${b.kind === "chat" ? '<span class="muted tiny">chat</span>' : ""}${badges}${tagChips}</div>
    <p>${body}</p>${orig}</div>
    <div class="acts">${acts}<button data-act="copy" title="Copiar"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg></button><button data-act="note" title="Nota neste ponto"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button></div>
  </li>`;
}

function renderTranscript() {
  const s = state.session;
  if (!s) return;
  renderSpeakers(s);
  const q = state.query.trim().toLowerCase();
  const items = timeline(s).filter((it) => {
    if (it.type !== "block") return !q;
    const b = it.block;
    return !state.hidden.has(b.speakerId) && (!q || b.text.toLowerCase().includes(q) || b.speaker.toLowerCase().includes(q));
  });
  const html = items
    .map((it) => {
      if (it.type === "block") return blockHtml(s, it.block, q);
      const t = clock(it.at - s.startedAt);
      if (it.type === "note") return `<li class="tl-note">📝 <time>${t}</time><span>${esc(it.note.text)}</span><button class="x" data-del-note="${esc(it.note.id)}" title="Apagar nota">✕</button></li>`;
      const url = state.shots[it.shot.id];
      return `<li class="tl-shot"><time>📷 ${t}</time>${url ? `<img src="${url}" alt="Captura de tela" data-shot="${esc(it.shot.id)}">` : ""}</li>`;
    })
    .join("");
  $("timeline").innerHTML =
    html ||
    (q
      ? `<li class="list-empty">Nada encontrado para “${esc(state.query)}”.</li>`
      : `<li class="list-empty">${isLive(s) ? "Aguardando as primeiras falas…" : "Esta reunião não tem falas."}</li>`);
  if (state.follow && !q && isLive(s)) scrollToEnd();
  updateJump();
}

function scroller() {
  return $("view-meeting");
}
function scrollToEnd(smooth) {
  const el = scroller();
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}
function updateJump() {
  const el = scroller();
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
  $("jump").hidden = atBottom || state.tab !== "transcript" || !isLive(state.session);
}
$("view-meeting").addEventListener("scroll", () => {
  const el = scroller();
  state.follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
  updateJump();
});
$("jump").addEventListener("click", () => {
  state.follow = true;
  scrollToEnd(true);
});
$("t-search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderTranscript();
});

$("timeline").addEventListener("click", async (e) => {
  const s = state.session;
  if (!s) return;
  const img = e.target.closest("[data-shot]");
  if (img) {
    $("lightbox").querySelector("img").src = img.src;
    $("lightbox").hidden = false;
    return;
  }
  const del = e.target.closest("[data-del-note]");
  if (del) {
    state.session = normalize(await send({ type: "delete-note", id: s.id, noteId: del.dataset.delNote }));
    return renderMeeting();
  }
  const blk = e.target.closest(".blk");
  if (!blk) return;
  if (e.target.closest("[data-speaker]")) return; // tratado no pointerdown
  const ids = JSON.parse(blk.dataset.ids);
  const tagBtn = e.target.closest("[data-tag]");
  if (tagBtn) {
    const current = JSON.parse(blk.dataset.tags);
    const t = tagBtn.dataset.tag;
    const next = current.includes(t) ? current.filter((x) => x !== t) : [...current, t];
    state.session = normalize(await send({ type: "tag-block", id: s.id, ids, tags: next }));
    return renderMeeting();
  }
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "orig") {
    state.showOrig.has(blk.dataset.key) ? state.showOrig.delete(blk.dataset.key) : state.showOrig.add(blk.dataset.key);
    return renderTranscript();
  }
  if (act && act.dataset.act === "copy") {
    await navigator.clipboard.writeText(blk.querySelector("p:not(.orig)").innerText);
    toast("Trecho copiado");
  } else if (act && act.dataset.act === "note") {
    const text = await askInline(act, { label: "Nota neste ponto da reunião", placeholder: "O que anotar aqui?" });
    if (text && text.trim()) {
      state.session = normalize(await send({ type: "add-note", id: s.id, text, at: Number(blk.dataset.at) + 1 }));
      renderMeeting();
    }
  }
});
$("lightbox").addEventListener("click", () => ($("lightbox").hidden = true));

// ----- Destaques -----
function renderHighlights() {
  const s = state.session;
  const blocks = toBlocks(s).filter((b) => b.tags.length);
  if (!blocks.length) {
    $("pane-highlights").innerHTML = `<div class="list-empty"><b>Nenhum destaque ainda</b><br>
      Passe o mouse sobre uma fala e escolha uma tag (⭐ ✅ 📌 ❓ ⚠️), use o botão ⭐ do widget
      ou o atalho <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> durante a reunião.</div>`;
    return;
  }
  $("pane-highlights").innerHTML = tags()
    .map((t) => {
      const list = blocks.filter((b) => b.tags.includes(t.id));
      if (!list.length) return "";
      return `<div class="hl-group"><h4>${t.emoji} ${esc(t.label)} <span class="count">${list.length}</span></h4>${list
        .map((b) => `<div class="hl-item" style="--c:${t.color}" data-goto="${esc(b.key)}"><div class="who"><b>${esc(b.speaker)}</b> · ${clock(b.startAt - s.startedAt)}</div>${esc(b.text)}</div>`)
        .join("")}</div>`;
    })
    .join("");
}
$("pane-highlights").addEventListener("click", (e) => {
  const item = e.target.closest("[data-goto]");
  if (!item) return;
  state.tab = "transcript";
  state.follow = false;
  renderMeeting();
  const el = [...document.querySelectorAll(".blk")].find((x) => x.dataset.key === item.dataset.goto);
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
  }
});

// ----- Notas -----
function renderNotes() {
  const s = state.session;
  if (document.activeElement !== $("notes-text")) $("notes-text").value = s.notes.text;
  $("note-list").innerHTML = s.notes.items.length
    ? s.notes.items
        .slice()
        .sort((a, b) => a.at - b.at)
        .map((n) => `<li><time>${clock(n.at - s.startedAt)}</time><span>${esc(n.text)}</span><button class="x" data-del-note="${esc(n.id)}" title="Apagar">✕</button></li>`)
        .join("")
    : `<li style="border:0;background:none" class="muted tiny">As notas com horário também aparecem na linha do tempo da transcrição.</li>`;
}
let notesTimer = null;
$("notes-text").addEventListener("input", () => {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(async () => {
    if (!state.session) return;
    state.session = normalize(await send({ type: "update", id: state.session.id, notesText: $("notes-text").value }));
  }, 700);
});
async function addNote() {
  const text = $("note-input").value.trim();
  if (!text || !state.session) return;
  state.session = normalize(await send({ type: "add-note", id: state.session.id, text }));
  $("note-input").value = "";
  renderMeeting();
}
$("note-add").addEventListener("click", addNote);
$("note-input").addEventListener("keydown", (e) => e.key === "Enter" && addNote());
$("note-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-note]");
  if (!del) return;
  state.session = normalize(await send({ type: "delete-note", id: state.session.id, noteId: del.dataset.delNote }));
  renderMeeting();
});

// ----- IA -----
function previousWithSame(s) {
  const mine = new Set(participantNames(s).filter((n) => !n.startsWith("Participante ")));
  if (!mine.size) return [];
  return state.index
    .filter((m) => m.id !== s.id && m.startedAt < s.startedAt && (m.participants || []).some((n) => mine.has(n)))
    .slice(0, 5);
}

async function aiStatus() {
  if (!state.settings) state.settings = await getSettings();
  const { apiKey, account } = await chrome.storage.local.get(["apiKey", "account"]);
  const model = MODELS.find((m) => m.id === state.settings.aiModel);
  const pro = account?.token && account.plan === "pro" && !account.invalid;
  if (apiKey) return { ok: true, kind: "key", text: `Sua chave da API · ${model ? model.label : state.settings.aiModel}`, hint: "A transcrição só é enviada quando você pede." };
  if (pro) return { ok: true, kind: "pro", text: `Escribanote Pro · ${account.balance ?? 0} crédito${account.balance === 1 ? "" : "s"}`, hint: "Ata, revisão e pergunta custam 1 crédito cada." };
  return { ok: false, kind: "none", text: "IA não configurada", hint: "Cadastre sua chave da API do Claude em Ajustes ou conecte a sua conta Escribanote Pro." };
}

// ----- Aba Ata -----
state.viewing = null; // id de uma versão antiga sendo exibida no lugar da atual (só leitura)
async function renderAta() {
  if (!state.settings) state.settings = await getSettings();
  if (!state.templatesLoaded) { await loadTemplates(); state.templatesLoaded = true; }
  const s = state.session;
  const hist = s.summaryHistory || [];
  const cur = hist[hist.length - 1];
  const viewing = state.viewing && state.viewing !== cur?.id ? hist.find((v) => v.id === state.viewing) : null;
  if (!viewing) state.viewing = null;
  $("ata-gen").textContent = s.summary ? "Gerar de novo" : "Gerar ata";
  $("ata-gen").disabled = !s.entries.length || (state.busy && state.busy !== "ata");
  renderAtaTemplateSelect(s);
  // instruções extras desta reunião
  if (document.activeElement !== $("ata-prompt")) $("ata-prompt").value = s.ataPrompt || "";
  const hasPrompt = !!(s.ataPrompt || "").trim();
  $("ata-prompt-on").hidden = !hasPrompt;
  $("ata-prompt-box").classList.toggle("active", hasPrompt);

  const editing = !$("ata-editor").hidden;
  if (state.busy !== "ata" && !editing) {
    if (viewing) $("ata-body").innerHTML = mdToHtml(viewing.text);
    else if (s.summary) $("ata-body").innerHTML = mdToHtml(s.summary.text);
    if (viewing || s.summary) decorateAta();
    else $("ata-body").innerHTML = s.entries.length
      ? `<div class="ata-empty"><div class="ico">📝</div><b>Nenhuma ata ainda</b><p>Gere uma ata com resumo, decisões, itens de ação e pendências. Escolha um modelo acima se a sua equipe tem um formato próprio.</p></div>`
      : `<div class="ata-empty"><div class="ico">🎙️</div><b>A ata nasce da transcrição</b><p>Quando a reunião tiver falas registradas, gere a ata por aqui.</p></div>`;
  }
  $("ata-doc").classList.toggle("empty", !s.summary && !viewing);
  if (!s.summary && !viewing) $("ata-tools").hidden = true;
  // faixa com o estado da ata atual
  const meta = $("ata-meta");
  if (cur && s.summary && !viewing) {
    meta.hidden = false;
    const tpl = state.templates.find((t) => t.id === (s.summary.templateId ?? cur.templateId));
    meta.innerHTML = `<span class="vtag">v${cur.n}</span><span>${esc(cur.label.split(" · ")[0])}</span><span class="dot">·</span><span>${fmtWhen(cur.createdAt)}</span>${tpl ? `<span class="dot">·</span><span>modelo ${esc(tpl.name)}</span>` : ""}${hist.length > 1 ? `<span class="dot">·</span><span>${hist.length} versões</span>` : ""}`;
  } else meta.hidden = true;
  const vw = $("ata-viewing");
  vw.hidden = !viewing;
  if (viewing) vw.innerHTML = `<span><b>Você está vendo a v${viewing.n}</b> (${esc(viewing.label)}, ${fmtWhen(viewing.createdAt)}). A ata atual é a v${cur.n}.</span><span class="row"><button class="btn sm ghost" data-vact="restore" data-v="${esc(viewing.id)}">Restaurar esta</button><button class="btn sm" id="ata-back">Voltar à atual</button></span>`;

  $("ata-actions").hidden = !s.summary;
  $("ata-versions-label").textContent = hist.length > 1 ? `Versões (${hist.length})` : "Versões";
  $("ata-versions-btn").classList.toggle("has-history", hist.length > 1);
  if (!$("ata-versions").hidden) renderVersions();
}

// ----- Aba IA -----
async function renderAI() {
  const s = state.session;
  const st = await aiStatus();
  $("ai-hint").className = `ai-status ${st.kind}`;
  $("ai-hint").innerHTML = `<span class="ai-dot"></span><b>${esc(st.text)}</b><span class="muted">${esc(st.hint)}</span>${st.ok ? "" : ' <button type="button" class="linkish" data-goto-view="settings">Abrir Ajustes</button>'}`;

  // Revisão
  if (state.busy !== "review") {
    const eff = toBlocks(s);
    const fixedCount = eff.filter((b) => b.fixed).length;
    $("review-run").textContent = fixedCount ? "Revisar de novo" : "Revisar com IA";
    $("review-info").innerHTML = fixedCount
      ? `${fixedCount} trecho${fixedCount > 1 ? "s" : ""} corrigido${fixedCount > 1 ? "s" : ""}. As palavras alteradas aparecem marcadas na transcrição; clique em “✓ revisado” para ver o original.`
      : "Corrige palavras mal reconhecidas (fala rápida, nomes, siglas) usando o contexto e o seu glossário. O texto original fica guardado.";
  }
  $("review-run").disabled = !s.entries.length || (state.busy && state.busy !== "review");

  // Conversas
  const sel = $("chat-select");
  sel.innerHTML =
    `<option value="">Nova conversa</option>` +
    s.chats.map((c, i) => `<option value="${esc(c.id)}">${esc((c.messages[0]?.text || `Conversa ${i + 1}`).slice(0, 40))}</option>`).join("");
  if (state.chatId && !s.chats.some((c) => c.id === state.chatId)) state.chatId = null;
  sel.value = state.chatId || "";
  if (state.busy !== "chat") renderChatLog();

  // Sugestões
  if (!state.index.length) state.index = await send({ type: "list" });
  const prev = previousWithSame(s)[0];
  const quick = QUICK_PROMPTS.map((p) => `<button class="chip" data-q="${esc(p.text)}">${esc(p.label)}</button>`);
  if (prev) quick.push(`<button class="chip" data-prev="${esc(prev.id)}">↩ Reunião anterior com estes participantes</button>`);
  $("quick").innerHTML = quick.join("");
}

function renderChatLog(streamText) {
  const chat = state.session.chats.find((c) => c.id === state.chatId);
  const msgs = chat ? chat.messages.slice() : [];
  if (streamText !== undefined) {
    if (state.pendingQuestion && (!msgs.length || msgs.at(-1).role !== "user")) msgs.push({ role: "user", text: state.pendingQuestion });
    msgs.push({ role: "assistant", text: streamText || "Pensando…" });
  }
  $("chat-log").innerHTML = msgs.length
    ? msgs.map((m) => `<div class="msg ${m.role}">${m.role === "assistant" ? `<div class="md">${mdToHtml(m.text)}</div>` : esc(m.text)}</div>`).join("")
    : `<p class="muted tiny">Faça perguntas durante ou depois da reunião. As conversas ficam salvas junto com a transcrição.</p>`;
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

$("chat-select").addEventListener("change", (e) => {
  state.chatId = e.target.value || null;
  renderChatLog();
});

function runAI(payload, onDelta, onDone) {
  if (state.aiPort) state.aiPort.disconnect();
  const port = chrome.runtime.connect({ name: "ai" });
  state.aiPort = port;
  port.onMessage.addListener((m) => {
    if (m.type === "chat") state.chatId = m.chatId;
    if (m.type === "delta") onDelta(m.text);
    if (m.type === "done" || m.type === "error") {
      port.disconnect();
      state.aiPort = null;
      onDone(m);
    }
  });
  port.postMessage(payload);
}

$("ata-gen").addEventListener("click", async () => {
  if (state.busy === "ata") {
    state.aiPort?.disconnect();
    state.aiPort = null;
    state.busy = null;
    return renderAta();
  }
  if (!(await ensureApiPermission())) return toast("Permissão para a API negada");
  state.busy = "ata";
  state.viewing = null;
  $("ata-viewing").hidden = true;
  $("ata-editor").hidden = true;
  $("ata-body").hidden = false;
  $("ata-gen").textContent = "Cancelar";
  $("ata-body").innerHTML = '<p class="muted">Gerando a ata…</p>';
  runAI(
    { action: "ata", id: state.session.id },
    (t) => ($("ata-body").innerHTML = mdToHtml(t)),
    async (m) => {
      state.busy = null;
      if (m.type === "error") {
        $("ata-body").innerHTML = `<p style="color:var(--danger)">${esc(m.message)}</p>`;
        $("ata-gen").textContent = "Tentar de novo";
        return;
      }
      await reloadSession();
      toast("Ata gerada");
    },
  );
});
$("review-run").addEventListener("click", async () => {
  if (state.busy === "review") {
    state.aiPort?.disconnect();
    state.aiPort = null;
    state.busy = null;
    return renderAI();
  }
  if (!(await ensureApiPermission())) return toast("Permissão para a API negada");
  state.busy = "review";
  $("review-run").textContent = "Cancelar";
  $("review-info").textContent = "Revisando…";
  const port = chrome.runtime.connect({ name: "ai" });
  state.aiPort = port;
  port.onMessage.addListener(async (m) => {
    if (m.type === "progress") $("review-info").textContent = `Revisando… ${m.done} de ${m.total} falas · ${m.changed} correções`;
    if (m.type === "done" || m.type === "error") {
      port.disconnect();
      state.aiPort = null;
      state.busy = null;
      if (m.type === "error") {
        $("review-info").innerHTML = `<span style="color:var(--danger)">${esc(m.message)}</span>`;
        return;
      }
      await reloadSession();
      toast(m.total ? `${m.changed} ${m.changed === 1 ? "correção" : "correções"} em ${m.total} ${m.total === 1 ? "fala" : "falas"}` : "Nada novo para revisar");
    }
  });
  port.postMessage({ action: "review", id: state.session.id });
});

$("ata-copy").addEventListener("click", (e) => {
  e.stopPropagation();
  $("ata-dl-menu").hidden = true;
  const menu = $("ata-copy-menu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) menu.classList.toggle("flip", menu.getBoundingClientRect().right > innerWidth - 8);
});
document.addEventListener("click", () => ($("ata-copy-menu").hidden = true));
$("ata-copy-menu").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  const s = state.session;
  if (!b || !s?.summary?.text) return;
  $("ata-copy-menu").hidden = true;
  await copyAta(s.summary.text, b.dataset.copy);
});
// kind: rich (HTML simples + texto), editor (HTML do Atena/TinyMCE + texto simples), html (código-fonte), plain
async function copyAta(md, kind) {
  const blob = (t, type) => new Blob([t], { type });
  if (kind === "html") { await navigator.clipboard.writeText(ataEditorHtml(md)); return toast("Código HTML copiado. Cole no \"Código-fonte\" do editor."); }
  if (kind === "plain") { await navigator.clipboard.writeText(ataPlainText(md)); return toast("Texto simples copiado"); }
  const html = kind === "editor" ? ataEditorHtml(md) : mdToHtml(md);
  await navigator.clipboard.write([new ClipboardItem({ "text/html": blob(html, "text/html"), "text/plain": blob(kind === "editor" ? ataPlainText(md) : md, "text/plain") })]);
  toast(kind === "editor" ? "Ata copiada no formato do Atena. Cole no editor." : "Ata copiada");
}

// ----- Versões da ata (histórico + comparador) -----
const fmtWhen = (t) => new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
state.cmp = state.cmp || { a: null, b: null, mode: "inline" };
function renderVersions() {
  const s = state.session;
  const hist = s?.summaryHistory || [];
  const box = $("ata-versions");
  if (!hist.length) { box.hidden = true; return; }
  const cur = hist[hist.length - 1];
  const ids = hist.map((v) => v.id);
  if (!ids.includes(state.cmp.b)) state.cmp.b = cur.id;
  if (!ids.includes(state.cmp.a)) state.cmp.a = hist.length > 1 ? hist[hist.length - 2].id : cur.id;
  const opt = (sel) => hist.map((v) => `<option value="${esc(v.id)}" ${sel === v.id ? "selected" : ""}>v${v.n} · ${fmtWhen(v.createdAt)}</option>`).join("");
  $("cmp-a").innerHTML = opt(state.cmp.a);
  $("cmp-b").innerHTML = opt(state.cmp.b);
  const kindIcon = { ai: "✦", edit: "✎", restore: "↺", sync: "⇅" };
  $("versions-list").innerHTML = hist.slice().reverse().map((v) => {
    const prev = hist.find((x) => x.id === v.parentId);
    const st = prev ? diffStats(diffDocument(prev.text, v.text)) : null;
    const isCur = v.id === cur.id;
    const isViewing = state.viewing === v.id;
    const [what, detail] = v.label.split(" · ");
    return `<li class="ver ${isCur ? "current" : ""} ${isViewing ? "viewing" : ""}" data-v="${esc(v.id)}">
      <span class="vk ${esc(v.source || "ai")}" title="${esc(what)}">${kindIcon[v.source] || "✦"}</span>
      <span class="vmain"><span class="vtitle"><b>v${v.n}</b> ${esc(what)}${isCur ? '<i class="pill">atual</i>' : ""}${isViewing ? '<i class="pill view">vendo</i>' : ""}</span>
        <small>${fmtWhen(v.createdAt)}${detail ? ` · ${esc(detail)}` : ""}${v.model && v.model !== "manual" && !/modelo/.test(detail || "") ? ` · ${esc(v.model)}` : ""}</small></span>
      <span class="vs">${st ? `<b class="plus">+${st.added}</b><b class="minus">−${st.removed}</b>` : '<span class="muted">início</span>'}</span>
      <span class="vacts">${isCur ? "" : `<button class="btn sm ghost" data-vact="view" title="Ver esta versão no lugar da atual (só leitura)">Ver</button>`}
      ${hist.length > 1 ? `<button class="btn sm ghost" data-vact="cmp" title="${isCur ? "Comparar com a anterior" : "Comparar com a atual"}">Comparar</button>` : ""}
      ${isCur ? "" : '<button class="btn sm ghost" data-vact="restore" title="Volta a ser a ata atual (vira uma nova versão)">Restaurar</button>'}</span></li>`;
  }).join("");
  $("cmp").hidden = hist.length < 2;
  if (hist.length < 2) $("versions-hint").textContent = "Edite a ata ou gere de novo para criar a v2 e poder comparar.";
  else $("versions-hint").textContent = "Cada geração, edição ou restauração vira uma versão. Nada se perde.";
  renderDiff();
}
function renderDiff() {
  const hist = state.session?.summaryHistory || [];
  const A = hist.find((v) => v.id === state.cmp.a);
  const B = hist.find((v) => v.id === state.cmp.b);
  if (!A || !B) return;
  for (const b of document.querySelectorAll("[data-cmp-mode]")) b.setAttribute("aria-pressed", String(b.dataset.cmpMode === state.cmp.mode));
  const blocks = diffDocument(A.text, B.text);
  const st = diffStats(blocks);
  $("diff-stats").innerHTML = A.id === B.id ? "Escolha duas versões diferentes para comparar." : `v${A.n} → v${B.n}: <b class="plus">+${st.added}</b> palavras adicionadas, <b class="minus">−${st.removed}</b> removidas, ${st.changedLines} linha${st.changedLines === 1 ? "" : "s"} alterada${st.changedLines === 1 ? "" : "s"}.`;
  $("diff-view").innerHTML = versionDiffHtml(blocks, { mode: state.cmp.mode, onlyChanges: $("cmp-only").checked });
  $("diff-view").classList.toggle("side", state.cmp.mode === "side");
}
$("ata-versions-btn").addEventListener("click", () => {
  const box = $("ata-versions");
  box.hidden = !box.hidden;
  $("ata-versions-btn").setAttribute("aria-expanded", String(!box.hidden));
  if (!box.hidden) { renderVersions(); box.scrollIntoView({ behavior: "smooth", block: "start" }); }
});
for (const id of ["cmp-a", "cmp-b"]) $(id).addEventListener("change", (e) => { state.cmp[id === "cmp-a" ? "a" : "b"] = e.target.value; renderDiff(); });
$("cmp-only").addEventListener("change", renderDiff);
for (const b of document.querySelectorAll("[data-cmp-mode]")) b.addEventListener("click", () => { state.cmp.mode = b.dataset.cmpMode; renderDiff(); });
async function versionAction(act, vid, anchor) {
  const s = state.session;
  const hist = s.summaryHistory;
  const v = hist.find((x) => x.id === vid);
  if (!v) return;
  const cur = hist[hist.length - 1];
  if (act === "view") {
    state.viewing = v.id;
    $("ata-editor").hidden = true;
    renderAta();
    $("ata-doc").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "cmp") {
    state.cmp = { ...state.cmp, a: v.id === cur.id ? hist[hist.length - 2].id : v.id, b: cur.id };
    renderVersions();
    $("cmp").scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "restore") {
    const ok = await askChoice(anchor, { title: `Restaurar a v${v.n}?`, text: `Ela volta a ser a ata atual, como a v${cur.n + 1}. Nada é apagado do histórico.`, choices: [{ key: "ok", label: "Restaurar", primary: true }, { key: "cancel", label: "Cancelar" }] });
    if (ok !== "ok") return;
    state.session = normalize(await send({ type: "ata-restore", id: s.id, versionId: v.id }));
    state.viewing = null;
    renderMeeting();
    toast(`v${v.n} restaurada como v${state.session.summaryHistory.length}`);
  }
}
$("versions-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-vact]");
  if (b) return versionAction(b.dataset.vact, b.closest(".ver").dataset.v, b);
  const row = e.target.closest(".ver");
  if (row && !row.classList.contains("current")) versionAction("view", row.dataset.v, row);
});
$("ata-viewing").addEventListener("click", (e) => {
  if (e.target.closest("#ata-back")) { state.viewing = null; renderAta(); return; }
  const b = e.target.closest("[data-vact]");
  if (b) versionAction(b.dataset.vact, b.dataset.v, b);
});
$("ata-edit").addEventListener("click", () => {
  const s = state.session;
  state.viewing = null;
  $("ata-viewing").hidden = true;
  $("ata-editor-text").value = s.summary?.text || "";
  $("ata-editor-label").value = "";
  $("ata-editor").hidden = false;
  $("ata-body").hidden = true;
  $("ata-editor-text").focus();
});
$("ata-editor-cancel").addEventListener("click", () => { $("ata-editor").hidden = true; $("ata-body").hidden = false; });
$("ata-editor-save").addEventListener("click", async () => {
  const text = $("ata-editor-text").value.trim();
  if (!text) return toast("A ata está vazia.");
  if (text === (state.session.summary?.text || "").trim()) { $("ata-editor").hidden = true; $("ata-body").hidden = false; return toast("Nada mudou."); }
  state.session = normalize(await send({ type: "ata-save", id: state.session.id, text, label: $("ata-editor-label").value.trim() }));
  $("ata-editor").hidden = true;
  $("ata-body").hidden = false;
  renderMeeting();
  toast(`Salva como v${state.session.summaryHistory.length}`);
});

// ----- Leitura de atas longas: sumário, seções recolhíveis e tamanho do texto -----
const ATA_LONG = 2200; // caracteres a partir dos quais vale mostrar o sumário
function decorateAta() {
  const body = $("ata-body");
  const heads = [...body.querySelectorAll("h3")];
  // embrulha cada título com o que vem depois dele numa seção recolhível
  for (const [i, h] of heads.entries()) {
    const sec = document.createElement("section");
    sec.className = "ata-sec";
    sec.id = `ata-s${i + 1}`;
    h.before(sec);
    let n = h;
    let words = 0;
    while (n && !(n !== h && n.tagName === "H3")) { const next = n.nextSibling; sec.append(n); if (n !== h) words += (n.textContent || "").split(/\s+/).filter(Boolean).length; n = next; }
    h.dataset.n = `${words} palavras`;
    if (state.folded.has(h.textContent.trim())) sec.classList.add("closed");
  }
  const long = body.textContent.length >= ATA_LONG || heads.length >= 4;
  $("ata-tools").hidden = !long;
  if (!long) return;
  $("ata-outline").innerHTML = heads.map((h, i) => `<a href="#ata-s${i + 1}" data-sec="ata-s${i + 1}">${esc(h.textContent.replace(/:$/, "").trim().slice(0, 28))}</a>`).join("");
  const anyOpen = heads.some((h) => !h.parentElement.classList.contains("closed"));
  $("ata-fold").textContent = anyOpen ? "Recolher tudo" : "Expandir tudo";
  $("ata-doc").classList.toggle("big", localStorage.getItem("ataFont") === "big");
}
state.folded = new Set(); // títulos recolhidos (por texto, para sobreviver a re-renders)
$("ata-body").addEventListener("click", (e) => {
  const h = e.target.closest(".ata-sec > h3");
  if (!h || e.target.closest("a")) return;
  const sec = h.parentElement;
  sec.classList.toggle("closed");
  const key = h.textContent.trim();
  sec.classList.contains("closed") ? state.folded.add(key) : state.folded.delete(key);
  const anyOpen = [...$("ata-body").querySelectorAll(".ata-sec")].some((x) => !x.classList.contains("closed"));
  $("ata-fold").textContent = anyOpen ? "Recolher tudo" : "Expandir tudo";
});
$("ata-outline").addEventListener("click", (e) => {
  const a = e.target.closest("a[data-sec]");
  if (!a) return;
  e.preventDefault();
  const sec = $(a.dataset.sec);
  if (!sec) return;
  sec.classList.remove("closed");
  state.folded.delete(sec.querySelector("h3").textContent.trim());
  sec.querySelector("h3").scrollIntoView({ behavior: "smooth", block: "start" });
  for (const x of $("ata-outline").children) x.classList.toggle("on", x === a);
});
$("ata-fold").addEventListener("click", () => {
  const secs = [...$("ata-body").querySelectorAll(".ata-sec")];
  const close = secs.some((x) => !x.classList.contains("closed"));
  for (const x of secs) { x.classList.toggle("closed", close); const k = x.querySelector("h3").textContent.trim(); close ? state.folded.add(k) : state.folded.delete(k); }
  $("ata-fold").textContent = close ? "Expandir tudo" : "Recolher tudo";
});
$("ata-font").addEventListener("click", () => {
  const big = !$("ata-doc").classList.contains("big");
  $("ata-doc").classList.toggle("big", big);
  localStorage.setItem("ataFont", big ? "big" : "normal");
});

// ----- Instruções extras da ata (por reunião) -----
let promptTimer;
$("ata-prompt").addEventListener("input", () => {
  clearTimeout(promptTimer);
  promptTimer = setTimeout(saveAtaPrompt, 600);
});
$("ata-prompt").addEventListener("blur", () => { clearTimeout(promptTimer); saveAtaPrompt(); });
async function saveAtaPrompt() {
  const s = state.session;
  if (!s) return;
  const text = $("ata-prompt").value.trim();
  if (text === (s.ataPrompt || "").trim()) return;
  state.session = normalize(await send({ type: "update", id: s.id, ataPrompt: text }));
  $("ata-prompt-on").hidden = !text;
  $("ata-prompt-box").classList.toggle("active", !!text);
  if (s.summary) toast(text ? "Instruções salvas. Gere a ata de novo para aplicar." : "Instruções removidas.");
}

// ----- Modelo padrão direto na aba Ata -----
$("ata-default").addEventListener("click", async () => {
  const s = state.session;
  if (!s) return;
  const sel = $("ata-template").value;
  const chosen = sel === "none" ? "" : sel || state.settings?.ataTemplate || "";
  const already = (state.settings?.ataTemplate || "") === chosen;
  if (already) return toast(chosen ? "Este já é o modelo padrão." : "O formato do Escribanote já é o padrão.");
  state.settings = await setSettings({ ataTemplate: chosen });
  // a reunião passa a seguir o padrão (não precisa mais da escolha própria)
  if (s.ataTemplateId) state.session = normalize(await send({ type: "update", id: s.id, ataTemplateId: null }));
  renderAtaTemplateSelect(state.session);
  const name = state.templates.find((t) => t.id === chosen)?.name;
  toast(name ? `"${name}" agora é o modelo padrão para novas reuniões.` : "Formato do Escribanote é o padrão de novo.");
});

// ----- Modelos de ata -----
state.templates = state.templates || [];
async function loadTemplates() {
  state.templates = (await send({ type: "ata-templates" }).catch(() => [])) || [];
  return state.templates;
}
function renderAtaTemplateSelect(s) {
  const sel = $("ata-template");
  const def = state.settings?.ataTemplate ? state.templates.find((t) => t.id === state.settings.ataTemplate) : null;
  const opts = [
    `<option value="">${esc(def ? `Padrão: ${def.name}` : "Formato do Escribanote")}</option>`,
    ...(def ? ['<option value="none">Formato do Escribanote</option>'] : []),
    ...state.templates.filter((t) => t.id !== state.settings?.ataTemplate).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`),
  ];
  sel.innerHTML = opts.join("");
  sel.value = s.ataTemplateId || "";
  sel.hidden = !state.templates.length;
  $("ata-default").hidden = !state.templates.length;
  const effective = sel.value === "none" ? "" : sel.value || state.settings?.ataTemplate || "";
  const isDefault = effective === (state.settings?.ataTemplate || "");
  $("ata-default").setAttribute("aria-pressed", String(isDefault));
  $("ata-default").title = isDefault ? (effective ? "Este é o modelo padrão para novas reuniões" : "O formato do Escribanote é o padrão") : "Tornar este modelo o padrão para novas reuniões";
}
$("ata-template").addEventListener("change", async (e) => {
  if (!state.session) return;
  state.session = normalize(await send({ type: "update", id: state.session.id, ataTemplateId: e.target.value || null }));
  renderAtaTemplateSelect(state.session);
  toast(e.target.value && e.target.value !== "none" ? "Modelo escolhido. Gere a ata de novo para aplicar." : "Ata no formato padrão na próxima geração.");
});
$("ata-dl").addEventListener("click", (e) => {
  e.stopPropagation();
  $("ata-copy-menu").hidden = true;
  const menu = $("ata-dl-menu");
  menu.hidden = !menu.hidden;
  menu.classList.remove("flip");
  if (!menu.hidden && menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) menu.classList.add("flip");
});
document.addEventListener("click", () => ($("ata-dl-menu").hidden = true));
$("ata-dl-menu").addEventListener("click", (e) => {
  const b = e.target.closest("[data-ata]");
  const s = state.session;
  if (!b || !s?.summary?.text) return;
  $("ata-dl-menu").hidden = true;
  const kind = b.dataset.ata;
  if (kind === "pdf") return void chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/print.html?id=${s.id}&ata=1`) });
  const text = kind === "txt" ? ataPlainText(s.summary.text) : kind === "html" ? `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body>\n${ataEditorHtml(s.summary.text)}\n</body>\n</html>` : s.summary.text;
  const url = URL.createObjectURL(new Blob([text], { type: `${kind === "txt" ? "text/plain" : kind === "html" ? "text/html" : "text/markdown"};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: ataFileName(s, kind) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// Ajustes: lista, editor, importação
function renderTemplates() {
  const list = $("tpl-list");
  list.innerHTML = state.templates.length
    ? state.templates.map((t) => `<div class="tpl-item" data-id="${esc(t.id)}"><b>${esc(t.name)}</b><small>${t.text.length.toLocaleString("pt-BR")} caracteres</small>
        <button type="button" class="btn sm ghost" data-tpl="edit">Editar</button><button type="button" class="btn sm ghost" data-tpl="del">Apagar</button></div>`).join("")
    : '<p class="muted tiny">Nenhum modelo ainda. As atas saem no formato do Escribanote.</p>';
  const sel = $("tpl-default");
  const cur = state.settings?.ataTemplate || "";
  sel.innerHTML = '<option value="">Formato do Escribanote (resumo, decisões, ações)</option>' + state.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = state.templates.some((t) => t.id === cur) ? cur : "";
}
function openTemplateEditor(t) {
  $("tpl-editor").hidden = false;
  $("tpl-editor").dataset.id = t?.id || "";
  $("tpl-name").value = t?.name || "";
  $("tpl-text").value = t?.text || "";
  $("tpl-name").focus();
}
$("tpl-new").addEventListener("click", () => openTemplateEditor(null));
$("tpl-cancel").addEventListener("click", () => ($("tpl-editor").hidden = true));
$("tpl-save").addEventListener("click", async () => {
  const id = $("tpl-editor").dataset.id || undefined;
  const name = $("tpl-name").value.trim() || "Modelo";
  const text = $("tpl-text").value.trim();
  if (!text) return toast("Cole ou escreva o modelo antes de salvar.");
  try {
    state.templates = await send({ type: "ata-template-save", id, name, text });
    $("tpl-editor").hidden = true;
    renderTemplates();
    toast("Modelo salvo");
  } catch (err) {
    toast(err.message);
  }
});
$("tpl-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-tpl]");
  if (!b) return;
  const id = b.closest(".tpl-item").dataset.id;
  const t = state.templates.find((x) => x.id === id);
  if (b.dataset.tpl === "edit") return openTemplateEditor(t);
  const ok = await askChoice(b, { title: `Apagar "${t.name}"?`, text: "As atas já geradas continuam como estão.", choices: [{ key: "del", label: "Apagar", primary: true }, { key: "cancel", label: "Cancelar" }] });
  if (ok !== "del") return;
  state.templates = await send({ type: "ata-template-delete", id });
  state.settings = await getSettings();
  renderTemplates();
});
$("tpl-import").addEventListener("click", () => $("tpl-file").click());
$("tpl-file").addEventListener("change", async () => {
  const file = $("tpl-file").files[0];
  $("tpl-file").value = "";
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("Arquivo grande demais (máximo 8 MB).");
  if (!(await ensureApiPermission())) return toast("Permissão para a API negada");
  const status = $("tpl-status");
  status.textContent = "Lendo a ata e extraindo o modelo…";
  try {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const payload = isPdf
      ? { pdfBase64: await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => fail(new Error("Não deu para ler o arquivo.")); r.readAsDataURL(file); }) }
      : { text: await file.text() };
    const r = await send({ type: "ata-template-import", ...payload });
    status.textContent = "";
    openTemplateEditor({ name: file.name.replace(/\.(pdf|txt|md)$/i, ""), text: r.text });
    toast("Modelo extraído. Revise e salve.");
  } catch (err) {
    status.textContent = "";
    toast("Não foi possível extrair o modelo: " + err.message);
  }
});

async function ask(question, previousId) {
  question = (question || "").trim();
  if (!question || !state.session || state.busy) return;
  if (!(await ensureApiPermission())) return toast("Permissão para a API negada");
  state.busy = "chat";
  state.pendingQuestion = question;
  $("chat-input").value = "";
  renderChatLog("");
  runAI(
    { action: "chat", id: state.session.id, chatId: state.chatId, question, previousId },
    (t) => renderChatLog(t),
    async (m) => {
      state.busy = null;
      state.pendingQuestion = null;
      if (m.type === "error") {
        $("chat-log").insertAdjacentHTML("beforeend", `<div class="msg assistant" style="color:var(--danger)">${esc(m.message)}</div>`);
        return;
      }
      await reloadSession();
    },
  );
}
$("chat-send").addEventListener("click", () => ask($("chat-input").value));
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    ask($("chat-input").value);
  }
});
$("chat-input").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = e.target.scrollHeight + "px";
});
$("quick").addEventListener("click", (e) => {
  const b = e.target.closest(".chip");
  if (!b) return;
  if (b.dataset.prev) ask("Resuma a reunião anterior com estes participantes e diga o que ficou pendente dela que pode ser retomado agora.", b.dataset.prev);
  else ask(b.dataset.q);
});

// ----- Análise -----
function renderStats() {
  const s = state.session;
  const st = computeStats(s);
  if (!st.speakers.length) {
    $("pane-stats").innerHTML = `<div class="list-empty">As estatísticas aparecem quando houver falas transcritas.</div>`;
    return;
  }
  const me = findMe(st, state.settings.myName);
  const target = state.settings.talkTarget || 30;
  const kpis = [
    [fmtDuration(st.durationMs), "duração"],
    [st.speakers.length, "participantes que falaram"],
    [st.totalWords.toLocaleString("pt-BR"), "palavras"],
    [st.totalTurns, "trocas de turno"],
  ];
  if (me) kpis.unshift([`${Math.round(me.share * 100)}%`, `sua fala (meta ${target}%)`]);

  const rows = st.speakers
    .map((p) => {
      const pct = Math.round(p.share * 100);
      return `<div class="share-row"><div class="name">${avatar(p.speakerId, p.name)}${esc(p.name)}</div>
        <div class="share-bar"><i style="width:${pct}%;background:${colorFor(p.name)}"></i></div><div class="pct">${pct}%</div>
        <div class="share-detail">${fmtDuration(p.talkMs)} falando · ${p.words} palavras · ${p.wpm} palavras/min · ${p.turns} turnos${p.questions ? ` · ${p.questions} pergunta${p.questions > 1 ? "s" : ""}` : ""} · maior fala ${fmtDuration(p.longestMs)}</div></div>`;
    })
    .join("");

  // Linha do tempo de quem falou quando.
  const top = st.speakers.slice(0, 8);
  const W = 600;
  const rowH = 18;
  const total = Math.max(st.durationMs, ...st.segments.map((x) => x.end), 1);
  const rects = st.segments
    .map((seg) => {
      const r = top.findIndex((p) => p.speakerId === seg.speakerId);
      if (r < 0) return "";
      const x = (seg.start / total) * W;
      const w = Math.max(1.5, ((seg.end - seg.start) / total) * W);
      return `<rect x="${x.toFixed(1)}" y="${r * rowH + 3}" width="${w.toFixed(1)}" height="${rowH - 6}" rx="2" fill="${colorFor(top[r].name)}"/>`;
    })
    .join("");
  const H = top.length * rowH + 16;
  const axis = [0, 0.5, 1].map((f) => `<text x="${f * W}" y="${H - 2}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${clock(f * total)}</text>`).join("");

  const prev = previousWithSame(s);
  $("pane-stats").innerHTML = `
    <div class="kpis">${kpis.map(([v, l]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>
    <div class="card"><h3>Parcela de fala</h3>${rows}</div>
    <div class="card"><h3>Quem falou quando</h3><svg class="tl-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Linha do tempo de falas">${rects}${axis}</svg>
      <div class="row tiny" style="margin-top:6px">${top.map((p) => `<span class="row" style="gap:4px"><i style="width:10px;height:10px;border-radius:3px;background:${colorFor(p.name)};display:inline-block"></i>${esc(p.name)}</span>`).join("")}</div></div>
    ${prev.length ? `<div class="card"><h3>Reuniões anteriores com estes participantes</h3>${prev.map(cardHtml).join("")}</div>` : ""}`;
}
$("pane-stats").addEventListener("click", openFromCard);

// ---------------- Lista de reuniões ----------------
const FILTERS = [
  ["all", "Todas"],
  ["meet", "Meet"],
  ["teams", "Teams"],
  ["zoom", "Zoom"],
  ["slack", "Slack"],
  ["ata", "Com ata"],
  ["hl", "Com destaques"],
];
$("filters").innerHTML = FILTERS.map(([k, l]) => `<button data-f="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("");
$("filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.listFilter = b.dataset.f;
  for (const x of $("filters").children) x.setAttribute("aria-pressed", x === b);
  renderList();
});

function cardHtml(m, snippet) {
  const names = m.participants || [];
  const sel = state.session && state.session.id === m.id ? " sel" : "";
  const live = !m.endedAt && Date.now() - m.updatedAt < 5 * 60 * 1000;
  return `<button class="mcard${sel}" data-open="${esc(m.id)}">
    <b>${live ? '<span style="color:var(--danger)">● </span>' : ""}${esc(m.title)}</b>
    <div class="sub"><span>${new Date(m.startedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
      <span>${esc(PLATFORM[m.platform] || m.platform)}</span>
      ${m.endedAt ? `<span>${fmtDuration(m.endedAt - m.startedAt)}</span>` : ""}
      <span class="avatars">${names.slice(0, 4).map((n) => avatar(n, n)).join("")}</span>
      ${m.part > 1 ? `<span class="badge" title="Mesmo link de reunião, retomado no mesmo dia">parte ${m.part}</span>` : ""}
      ${m.hasSummary ? '<span class="badge ok">ata</span>' : ""}${m.highlights ? `<span class="badge">⭐ ${m.highlights}</span>` : ""}</div>
    ${snippet ? `<div class="snippet">${highlight(snippet, state.listQuery.trim())}</div>` : ""}
  </button>`;
}

function openFromCard(e) {
  const c = e.target.closest("[data-open]");
  if (!c) return;
  state.view = "meeting";
  state.tab = "transcript";
  openSession(c.dataset.open, true);
}
$("list").addEventListener("click", openFromCard);
for (const b of document.querySelectorAll("[data-recorder]")) b.addEventListener("click", () => send({ type: "open-recorder" }).catch((e) => toast(e.message)));
$("recent").addEventListener("click", openFromCard);

async function renderList() {
  state.index = await send({ type: "list" });
  let items = state.index;
  const f = state.listFilter;
  if (["meet", "teams", "zoom", "slack"].includes(f)) items = items.filter((m) => m.platform === f);
  if (f === "ata") items = items.filter((m) => m.hasSummary);
  if (f === "hl") items = items.filter((m) => m.highlights);
  const hits = state.searchHits;
  if (hits) items = items.filter((m) => hits.has(m.id));
  renderBackupBanner();
  renderAccount();
  if (!items.length) {
    $("list").innerHTML = `<div class="list-empty">${
      state.index.length
        ? "Nenhuma reunião encontrada."
        : 'Nenhuma reunião salva ainda.<br>Elas aparecem aqui automaticamente.<br><button type="button" class="btn sm" data-bk-restore>Restaurar de uma pasta de backup</button>'
    }</div>`;
    return;
  }
  let lastDay = "";
  $("list").innerHTML = items
    .map((m) => {
      const d = dayLabel(m.startedAt);
      const head = d !== lastDay ? `<div class="day">${esc(d)}</div>` : "";
      lastDay = d;
      return head + cardHtml(m, hits ? hits.get(m.id) : "");
    })
    .join("");
}

let searchTimer = null;
$("list-search").addEventListener("input", (e) => {
  state.listQuery = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = state.listQuery.trim();
    state.searchHits = q ? new Map((await send({ type: "search", q })).map((r) => [r.id, r.snippet])) : null;
    renderList();
  }, 250);
});

$("backup").addEventListener("click", async () => {
  const all = await send({ type: "export-all" });
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: "escribanote", version: 2, exportedAt: Date.now(), sessions: all }, null, 2)], { type: "application/json" }));
  const d = new Date();
  const a = Object.assign(document.createElement("a"), { href: url, download: `escribanote-backup-${d.toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`${all.length} reuniões exportadas`);
});
$("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = await send({ type: "import", sessions: data.sessions || data });
    toast(`${n} reuniões importadas`);
    renderList();
  } catch (err) {
    toast("Arquivo inválido: " + err.message);
  }
});

// ---------------- Ajustes ----------------
$("model-select").innerHTML = MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");

const HAS_GPU = !!navigator.gpu;
$("hq-select").innerHTML =
  `<option value="off">Desligado (usa só as legendas)</option>` +
  Object.entries(HQ_MODELS)
    .map(([k, m]) => {
      const cfg = (HAS_GPU && m.webgpu) || m.wasm;
      const disabled = !cfg ? " disabled" : "";
      return `<option value="${k}"${disabled}>${esc(m.label)}${cfg ? ` · ~${cfg.mb} MB` : " · indisponível sem WebGPU"}</option>`;
    })
    .join("");

$("mic-perm").addEventListener("click", async () => {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: true });
    st.getTracks().forEach((t) => t.stop());
    toast("Microfone liberado para o Escribanote");
  } catch {
    // O painel lateral não mostra o pedido de permissão: abre numa aba.
    chrome.tabs.create({ url: chrome.runtime.getURL("src/app/app.html?perm=mic") });
  }
});

$("hq-test").addEventListener("click", async () => {
  const key = state.settings.hq !== "off" ? state.settings.hq : "base";
  $("hq-test-out").textContent = "Baixando e carregando o modelo (só na primeira vez)…";
  $("hq-test").disabled = true;
  try {
    // Transcreve um trecho de fala embutido ("...da América do Sul e da região da América Latina...").
    const r = await send({ type: "hq-test", modelKey: key, lang: state.settings.captionLang });
    const where = r.device === "webgpu" ? "placa de vídeo (WebGPU)" : "processador (WASM)";
    $("hq-test-out").textContent = r.ok
      ? `Funcionando: ${where}, ${r.ms} ms para 3,6 s de fala. Ouviu: "${r.text}"`
      : `Não transcreveu direito (${where}). Ouviu: "${r.text || "nada"}"`;
    if (r.fallback) $("hq-test-out").textContent += ` · A placa de vídeo falhou e o Escribanote passou para o processador.`;
  } catch (err) {
    $("hq-test-out").textContent = "Falhou: " + err.message;
  } finally {
    $("hq-test").disabled = false;
  }
});

async function renderSettings() {
  state.settings = await getSettings();
  const s = state.settings;
  const form = $("settings");
  for (const el of form.elements) {
    if (!el.name || el.name === "apiKey") continue;
    if (el.type === "radio") el.checked = s[el.name] === el.value;
    else if (el.type === "checkbox") el.checked = !!s[el.name];
    else if (document.activeElement !== el) el.value = s[el.name] ?? "";
  }
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (document.activeElement !== form.elements.apiKey) form.elements.apiKey.value = apiKey || "";
  $("key-status").textContent = apiKey ? "Chave salva neste navegador." : "";
  renderTagEditor();
  await loadTemplates();
  renderTemplates();

  // Identificação de falantes pela voz: recurso do Pro (a opção fica visível, mas só liga com a conta Pro).
  const pro = await send({ type: "is-pro" }).catch(() => false);
  form.elements.diarize.disabled = !pro;
  $("diarize-row").title = pro ? "" : "Disponível no Escribanote Pro";
  $("diarize-row").classList.toggle("muted", !pro);
  $("after-call-web").disabled = !pro;
  if (!pro) $("after-call-web").textContent += " (Pro)";

  const shots = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  $("grant-shots").hidden = shots;
  $("shots-status").textContent = shots ? "Capturas pelo widget autorizadas." : "";
  const cmds = await chrome.commands.getAll();
  const NAMES = { "highlight-last": "Destacar o último bloco", screenshot: "Capturar a tela", "toggle-pause": "Pausar/retomar", _execute_action: "Abrir o Escribanote" };
  $("kbd-list").innerHTML = cmds
    .map((c) => `<li>${esc(NAMES[c.name] || c.description || c.name)}: ${c.shortcut ? c.shortcut.split("+").map((k) => `<kbd>${esc(k)}</kbd>`).join("+") : '<span class="muted">sem atalho</span>'}</li>`)
    .join("");
  renderBackup();
  renderAutoBackup();
  renderAccount();
  const bytes = await chrome.storage.local.getBytesInUse(null);
  const index = await send({ type: "list" });
  $("usage").textContent = `${index.length} reuniões · ${(bytes / 1024 / 1024).toFixed(2)} MB usados neste computador.`;
}

$("settings").addEventListener("change", async (e) => {
  const el = e.target;
  if (!el.name || el.name === "apiKey" || el.closest(".tag-editor")) return;
  const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  state.settings = await setSettings({ [el.name]: v });
  toast("Ajuste salvo");
});

$("save-key").addEventListener("click", async () => {
  const key = $("settings").elements.apiKey.value.trim();
  if (key) {
    // Pede a permissão de rede aqui, durante o clique (gesto do usuário).
    if (!(await chrome.permissions.request({ origins: [API_ORIGIN] }))) return ($("key-status").textContent = "Permissão negada.");
    await chrome.storage.local.set({ apiKey: key });
  } else {
    await chrome.storage.local.remove("apiKey");
  }
  $("key-status").textContent = key ? "Chave salva neste navegador." : "Chave removida.";
});

$("grant-shots").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: ["<all_urls>"] });
  toast(ok ? "Capturas autorizadas" : "Permissão negada");
  renderSettings();
});
$("edit-shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

function renderTagEditor() {
  $("tag-editor").innerHTML = tags()
    .map((t, i) => `<div class="tag-row" data-i="${i}"><input value="${esc(t.emoji)}" data-k="emoji" maxlength="4" aria-label="Emoji">
      <input value="${esc(t.label)}" data-k="label" maxlength="30" aria-label="Nome"><input type="color" value="${esc(t.color)}" data-k="color" aria-label="Cor">
      <button type="button" class="x" data-rm="${i}" title="Remover">✕</button></div>`)
    .join("");
}
async function saveTags(list) {
  state.settings = await setSettings({ tags: list });
  renderTagEditor();
}
$("tag-editor").addEventListener("change", (e) => {
  const row = e.target.closest(".tag-row");
  if (!row) return;
  const list = tags().map((t) => ({ ...t }));
  list[row.dataset.i][e.target.dataset.k] = e.target.value;
  saveTags(list);
});
$("tag-editor").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]");
  if (!rm) return;
  const list = tags().filter((_, i) => i !== Number(rm.dataset.rm));
  if (!list.length) return toast("Mantenha pelo menos uma tag");
  saveTags(list);
});
$("tag-add").addEventListener("click", () => saveTags([...tags(), { id: "t" + Date.now().toString(36), label: "Nova tag", emoji: "🏷", color: "#64748b" }]));
$("tag-reset").addEventListener("click", () => saveTags(DEFAULT_TAGS));

// ---------------- Conta Escribanote Pro ----------------
async function renderAccount() {
  const r = await send({ type: "account-state" }).catch(() => null);
  const a = r?.account;
  $("acct-off").hidden = !!a;
  $("acct-on").hidden = !a;
  if (a) {
    const st = $("acct-status");
    if (a.invalid) {
      st.className = "bk-status warn";
      st.textContent = `A conexão com ${a.email || "a conta"} expirou. Desconecte e conecte de novo.`;
    } else if (a.plan !== "pro") {
      st.className = "bk-status warn";
      st.textContent = `Conectado como ${a.email}, sem o Pro ativo: a sincronização e a IA inclusa estão pausadas.`;
    } else {
      st.className = "bk-status ok";
      st.textContent = `Conectado como ${a.email} · Pro · ${a.balance ?? 0} créditos de IA.`;
    }
    const s = r.sync;
    $("acct-sync").textContent = !s.consent
      ? "Aguardando você escolher quais reuniões enviar (aviso no topo da lista)."
      : s.error
        ? `A última sincronização falhou: ${s.error}`
        : s.lastSyncAt
          ? `Última sincronização: ${new Date(s.lastSyncAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.`
          : "Sincronização ligada.";
  }
  const banner = $("sync-banner");
  const show = a && a.plan === "pro" && !a.invalid && !r.sync.consent;
  banner.hidden = !show;
  if (show) $("sync-banner-text").textContent = r.pending
    ? `Conta conectada (${a.email}). Enviar as ${r.pending} reuniões deste computador para a conta?`
    : `Conta conectada (${a.email}). As próximas reuniões vão para a conta sozinhas.`;
}

async function openAccountWeb(path) {
  const r = await send({ type: "account-state" }).catch(() => null);
  const base = r?.account?.web || "https://escribanote.com/app/";
  chrome.tabs.create({ url: base + path });
}

$("acct-connect").addEventListener("click", () => openAccountWeb("#/conectar"));
$("acct-web").addEventListener("click", () => openAccountWeb(""));
$("acct-sync-now").addEventListener("click", async () => {
  await send({ type: "sync-now" });
  toast("Sincronizando");
  setTimeout(renderAccount, 1500);
});
$("acct-off-btn").addEventListener("click", async () => {
  await send({ type: "account-disconnect" });
  toast("Conta desconectada; as reuniões continuam neste computador");
  renderAccount();
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-sync-consent]");
  if (!b) return;
  await send({ type: "sync-consent", mode: b.dataset.syncConsent });
  toast(b.dataset.syncConsent === "all" ? "Enviando as reuniões para a conta" : "Só as próximas reuniões vão para a conta");
  renderAccount();
});

// ---------------- Backup na pasta do computador ----------------
async function backupInfo() {
  const dir = await getBackupDir();
  const { backup = {} } = await chrome.storage.local.get("backup");
  const perm = dir ? await backupPermission(dir).catch(() => "denied") : null;
  return { dir, backup, perm };
}

async function renderBackup() {
  const { dir, backup, perm } = await backupInfo();
  const st = $("bk-status");
  if (!dir) {
    st.className = "bk-status muted";
    st.textContent = "Desligado. Escolha uma pasta para guardar uma cópia de cada reunião.";
  } else if (perm !== "granted") {
    st.className = "bk-status warn";
    st.textContent = `Pausado: o Chrome pede para confirmar o acesso à pasta "${dir.name}".`;
  } else if (backup.error) {
    st.className = "bk-status warn";
    st.textContent = `Falhou ao gravar em "${dir.name}": ${backup.error}`;
  } else {
    st.className = "bk-status ok";
    st.textContent = `Ligado na pasta "${dir.name}"` + (backup.at ? ` · último backup ${new Date(backup.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "") + ".";
  }
  $("bk-pick").textContent = dir ? "Trocar de pasta…" : "Escolher pasta…";
  $("bk-pick").classList.toggle("primary", !dir);
  $("bk-resume").hidden = !dir || perm === "granted";
  for (const id of ["bk-now", "bk-restore", "bk-off"]) $(id).hidden = !dir || perm !== "granted";
}

async function renderBackupBanner() {
  const { dir, perm } = await backupInfo();
  $("bk-banner").hidden = !dir || perm === "granted";
}

// Backup automático (Downloads ou área interna)
const fmtAt = (t) => new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
async function renderAutoBackup() {
  const { autoBackup = {} } = await chrome.storage.local.get("autoBackup");
  const mode = state.settings?.backupAuto || "off";
  const st = $("bk-auto-status");
  const where = mode === "downloads" ? "Downloads\\Escribanote\\backup" : "área interna do Chrome";
  if (mode === "off") { st.className = "bk-status muted"; st.textContent = "Desligado."; }
  else if (autoBackup.error) { st.className = "bk-status warn"; st.textContent = `Falhou ao gravar em ${where}: ${autoBackup.error}`; }
  else if (autoBackup.at) { st.className = "bk-status ok"; st.textContent = `Ligado em ${where} · ${autoBackup.count ?? "—"} reuniões · último backup ${fmtAt(autoBackup.at)}.`; }
  else { st.className = "bk-status muted"; st.textContent = `Ligado em ${where}. O primeiro backup acontece na próxima mudança.`; }
  $("bk-auto-now").hidden = mode === "off";
  $("bk-auto-open").hidden = mode !== "downloads";
  $("bk-auto-restore").hidden = mode !== "opfs";
  $("bk-auto-hint").textContent = mode === "downloads"
    ? "Um arquivo .json por reunião, gravado poucos segundos depois de cada mudança. O Chrome mostra o balão de download ao gravar; o registro sai do histórico em seguida. Para restaurar noutro computador, use \"Restaurar de uma pasta de backup\" e aponte para Downloads\\Escribanote\\backup."
    : mode === "opfs" ? "Fica no disco, dentro do perfil do Chrome. Protege contra falhas do armazenamento da extensão, mas não contra remover a extensão ou apagar o perfil."
    : "";
}
$("bk-auto").addEventListener("change", () => setTimeout(async () => { await send({ type: "auto-backup-flush", all: true }); renderAutoBackup(); }, 400));
$("bk-auto-now").addEventListener("click", async () => {
  const r = await send({ type: "auto-backup-flush", all: true });
  toast(r && r.error ? "Falhou: " + r.error : "Backup feito");
  renderAutoBackup();
});
$("bk-auto-open").addEventListener("click", () => send({ type: "auto-backup-open" }));
$("bk-auto-restore").addEventListener("click", async () => {
  const { n, total } = await send({ type: "auto-backup-restore" });
  toast(n ? `${n} reuniões restauradas` : total ? "Todas as reuniões da área interna já estão aqui" : "Nenhuma reunião na área interna");
  renderList();
});

// ----- Primeira execução -----
let wStep = 1;
function showWelcomeStep(n) {
  wStep = n;
  for (const s of document.querySelectorAll(".w-step")) s.hidden = Number(s.dataset.step) !== n;
  [...$("w-steps").children].forEach((li, i) => { li.classList.toggle("on", i + 1 === n); li.classList.toggle("done", i + 1 < n); });
  $("w-back").hidden = n === 1;
  $("w-next").textContent = n === 3 ? "Concluir" : "Continuar";
}
async function openWelcome() {
  const f = $("welcome-form");
  f.elements["w-backup"].value = state.settings.backupAuto || "downloads";
  f.elements["w-mode"].value = state.settings.mode === "ask" ? "ask" : "always";
  f.elements["w-after"].value = state.settings.afterCall === "app" ? "app" : "off";
  const dir = await getBackupDir();
  $("w-pick-status").textContent = dir ? `Pasta "${dir.name}" escolhida.` : "";
  showWelcomeStep(1);
  $("welcome").showModal();
}
async function finishWelcome(skipped) {
  const f = $("welcome-form");
  if (!skipped) {
    const patch = { backupAuto: f.elements["w-backup"].value, mode: f.elements["w-mode"].value, afterCall: f.elements["w-after"].value };
    state.settings = await setSettings(patch);
    const ai = f.elements["w-ai"].value;
    const key = $("w-key").value.trim();
    if (ai === "key" && key) {
      if (await chrome.permissions.request({ origins: [API_ORIGIN] })) await chrome.storage.local.set({ apiKey: key });
      else toast("Permissão para a API negada. Dá para cadastrar a chave em Ajustes.");
    }
    if (ai === "pro") openAccountWeb("#/conectar");
    send({ type: "auto-backup-flush", all: true }).catch(() => {});
  }
  await chrome.storage.local.set({ welcomeDone: Date.now() });
  $("welcome").close();
  if (state.view === "settings") render();
  if (!skipped) toast("Pronto! Dá para rever tudo em Ajustes.");
}
$("w-next").addEventListener("click", () => (wStep < 3 ? showWelcomeStep(wStep + 1) : finishWelcome(false)));
$("w-back").addEventListener("click", () => showWelcomeStep(Math.max(1, wStep - 1)));
$("w-skip").addEventListener("click", () => finishWelcome(true));
$("welcome").addEventListener("cancel", (e) => { e.preventDefault(); finishWelcome(true); });
$("w-pick").addEventListener("click", async () => {
  await pickBackupFolder();
  const dir = await getBackupDir();
  $("w-pick-status").textContent = dir ? `Pasta "${dir.name}" escolhida.` : "";
});
$("welcome-again").addEventListener("click", openWelcome);

function refreshBackupUi() {
  renderBackupBanner();
  if (state.view === "settings") { renderBackup(); renderAutoBackup(); }
}

// Importa o que estiver na pasta (reuniões que já existem aqui são mantidas).
async function restoreFrom(dir) {
  const { sessions, settings } = await readBackupFolder(dir);
  const n = sessions.length ? await send({ type: "import", sessions }) : 0;
  // Ajustes da pasta só entram numa instalação nova (ajustes nunca alterados aqui).
  if (settings && !state.settings._at) state.settings = await setSettings({ ...settings });
  return { n, total: sessions.length };
}

async function pickBackupFolder() {
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: "escribanote-backup", mode: "readwrite", startIn: "documents" });
  } catch (err) {
    if (err.name === "AbortError") return;
    // O painel lateral pode não abrir o seletor de pastas: abre o Escribanote numa aba.
    if (!IS_TAB) return chrome.tabs.create({ url: chrome.runtime.getURL("src/app/app.html?view=settings") });
    return toast("Não foi possível abrir a pasta: " + err.message);
  }
  const dir = await resolveBackupFolder(picked);
  if ((await backupPermission(dir, true)) !== "granted") return toast("O Chrome não liberou a pasta.");
  await setBackupDir(dir);
  const { n } = await restoreFrom(dir);
  await send({ type: "backup-flush", all: true });
  toast(n ? `Backup ligado · ${n} reuniões restauradas da pasta` : `Backup ligado na pasta "${dir.name}"`);
  renderList();
  refreshBackupUi();
}

async function resumeBackup() {
  const dir = await getBackupDir();
  if (!dir) return pickBackupFolder();
  if ((await backupPermission(dir, true)) !== "granted") return toast("O Chrome não liberou a pasta.");
  await send({ type: "backup-flush" });
  toast("Backup retomado");
  refreshBackupUi();
}

$("bk-pick").addEventListener("click", pickBackupFolder);
$("bk-resume").addEventListener("click", resumeBackup);
$("bk-now").addEventListener("click", async () => {
  const r = await send({ type: "backup-flush", all: true });
  toast(r && r.error ? "Falhou: " + r.error : "Backup feito");
  renderBackup();
  renderAutoBackup();
});
$("bk-restore").addEventListener("click", async () => {
  const dir = await getBackupDir();
  if (!dir || (await backupPermission(dir, true)) !== "granted") return;
  const { n, total } = await restoreFrom(dir);
  toast(n ? `${n} reuniões restauradas` : total ? "Todas as reuniões da pasta já estão aqui" : "Nenhuma reunião encontrada na pasta");
  renderList();
});
$("bk-off").addEventListener("click", async () => {
  if (!confirm("Desligar o backup automático? Os arquivos que já estão na pasta continuam lá.")) return;
  await setBackupDir(null);
  await chrome.storage.local.remove("backup");
  refreshBackupUi();
});
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-bk-resume]")) resumeBackup();
  if (e.target.closest("[data-bk-restore]")) pickBackupFolder();
});

$("wipe").addEventListener("click", async () => {
  if (!confirm("Apagar TODAS as reuniões salvas? Com o backup ligado, os arquivos da pasta de backup também são apagados.")) return;
  for (const m of await send({ type: "list" })) await send({ type: "delete", id: m.id });
  state.session = null;
  toast("Todas as reuniões foram apagadas");
  render();
});

// ---------------- Atualizações ao vivo ----------------
let pending = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "backup-updated") return refreshBackupUi();
  if (msg.type === "account-updated") return renderAccount();
  if (msg.type === "index-updated") {
    if (!$("view-list").hidden) renderList();
    return;
  }
  if (msg.type === "hq-updated") {
    if (msg.tabId === state.tabId || (state.session && IS_TAB)) {
      state.hq = msg.status || { state: "idle" };
      if (!$("view-meeting").hidden && state.session) {
        renderHqButton();
        renderBanner();
      }
    }
    return;
  }
  if (msg.type !== "session-updated") return;
  const mine = state.session && msg.id === state.session.id;
  const newForTab = !state.pinned && !IS_TAB && msg.tabId === state.tabId && !mine;
  if (!$("view-list").hidden && !mine) {
    clearTimeout(renderList.t);
    renderList.t = setTimeout(renderList, 800);
  }
  if (!mine && !newForTab) return;
  clearTimeout(pending);
  pending = setTimeout(async () => {
    if (state.busy && mine) return; // não atrapalha a IA respondendo
    const keepTab = state.tab;
    await openSession(msg.id, state.pinned);
    state.tab = keepTab;
  }, 350);
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.settings) state.settings = { ...DEFAULTS, ...ch.settings.newValue };
});
if (!IS_TAB) {
  chrome.tabs.onActivated.addListener(() => !state.pinned && state.view === "meeting" && followCurrent());
  chrome.tabs.onUpdated.addListener((id, info) => id === state.tabId && info.status === "complete" && !state.pinned && followCurrent());
}
setInterval(() => isLive(state.session) && state.view === "meeting" && state.tab !== "ai" && state.tab !== "ata" && renderMeeting(), 20_000);

// ---------------- Início ----------------
if (params.get("perm") === "mic") {
  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((st) => {
      st.getTracks().forEach((t) => t.stop());
      document.body.innerHTML = '<div class="empty"><h2>Microfone liberado ✓</h2><p>Pode fechar esta aba. O Escribanote vai incluir a sua voz no modo de alta precisão.</p></div>';
    })
    .catch(() => {
      document.body.innerHTML = '<div class="empty"><h2>Permissão negada</h2><p>Libere o microfone para esta extensão nas configurações do site (ícone ao lado do endereço) e recarregue.</p></div>';
    });
}
(async () => {
  state.settings = await getSettings();
  applyLayout();
  const id = params.get("id");
  if (id) await openSession(id, true);
  else await followCurrent();
  if (params.get("view") === "settings") {
    state.view = "settings";
    render();
  }
  const { welcomeDone } = await chrome.storage.local.get("welcomeDone");
  if (params.get("bemvindo") || !welcomeDone) openWelcome();
})();
