import { toBlocks, speakerName, timeline, participantNames, normalize, effectiveEntries, countMatches } from "../lib/transcript.js";
import { FORMATS, fileName, clock, toText, toHtml, mdToHtml, PLATFORM, dateLabel, ataPlainText, ataFileName, ataEditorHtml, EXPORT_PARTS, EXPORT_DEFAULT, aiConversations } from "../lib/format.js";
import { computeStats, findMe, fmtDuration } from "../lib/stats.js";
import { API_ORIGIN, QUESTION_MAX, LONG_QUESTION, questionLength } from "../lib/ai.js";
import { getSettings, setSettings, DEFAULT_TAGS, DEFAULT_QUESTIONS, MODELS, DEFAULTS, HQ_MODELS } from "../lib/settings.js";
import { LANG_NAMES } from "../lib/lang.js";
import { diffDocument, diffStats, diffHtml as versionDiffHtml } from "../lib/diff.js";
import { getBackupDir, setBackupDir, backupPermission, resolveBackupFolder, readBackupFolder } from "../lib/backup.js";
import { readTrack, writeTrackFile } from "../lib/audiovault.js";
import "../lib/icons.js";

const { icon, tagIcon, TAG_ICONS } = globalThis.EsIcons;
// Ícones fixos do HTML: <i data-ic="nome"> vira o SVG do conjunto.
for (const el of document.querySelectorAll("i[data-ic]")) el.outerHTML = icon(el.dataset.ic);

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
// action opcional ({ label, run }): um botão no aviso (ex.: Desfazer), que fica mais tempo na tela.
function toast(text, action) {
  const t = $("toast");
  t.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      t.classList.remove("show");
      action.run();
    }, { once: true });
    t.append(" ", b);
  }
  t.classList.toggle("has-action", !!action);
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), action ? 6000 : 2400);
}
// ----- Contagem de caracteres -----
// data-count="always": contador fixo dentro do campo (o campo fica num .cw com um .count).
// data-count="focus": um selo "n/máx" flutua sob o canto do campo enquanto ele é editado (não mexe no layout).
const fmtN = (n) => n.toLocaleString("pt-BR");
function countState(n, max) {
  return n >= max ? "full" : n >= max * 0.9 ? "warn" : "";
}
function countHtml(value, max) {
  const n = (value || "").length;
  return `<span class="count ${countState(n, max)}" aria-hidden="true">${fmtN(n)}/${fmtN(max)}</span>`;
}
const countFloat = document.createElement("span");
countFloat.id = "count-float";
countFloat.className = "count";
countFloat.hidden = true;
countFloat.setAttribute("aria-hidden", "true");
document.body.append(countFloat);
function paintCount(el) {
  const max = el.maxLength;
  const n = el.value.length;
  // Sem maxlength: só a contagem ("1.234 caracteres").
  const text = max > 0 ? `${fmtN(n)}/${fmtN(max)}` : `${fmtN(n)} caractere${n === 1 ? "" : "s"}`;
  const cls = max > 0 ? countState(n, max) : "";
  if (el.dataset.count === "always") {
    const span = el.parentElement.querySelector(":scope > .count");
    if (span) {
      span.textContent = text;
      span.className = `count ${cls}`;
    }
    return;
  }
  countFloat.textContent = text;
  countFloat.className = `count ${cls}`;
  countFloat.hidden = false;
  const r = el.getBoundingClientRect();
  const w = countFloat.offsetWidth;
  const h = countFloat.offsetHeight;
  const below = r.bottom + 4 + h <= innerHeight;
  countFloat.style.left = `${Math.max(4, Math.min(r.right - w, innerWidth - w - 4))}px`;
  countFloat.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - h - 4)}px`;
}
const countTarget = (el) => (el instanceof HTMLElement && el.matches("input[data-count], textarea[data-count]") ? el : null);
document.addEventListener("input", (e) => {
  const el = countTarget(e.target);
  if (el) paintCount(el);
});
document.addEventListener("focusin", (e) => {
  const el = countTarget(e.target);
  if (el && el.dataset.count === "focus") paintCount(el);
});
document.addEventListener("focusout", (e) => {
  if (countTarget(e.target)?.dataset.count === "focus") countFloat.hidden = true;
});
const repaintFloat = () => {
  const el = countTarget(document.activeElement);
  if (!countFloat.hidden && el?.dataset.count === "focus") paintCount(el);
};
addEventListener("scroll", repaintFloat, true);
addEventListener("resize", repaintFloat);

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

// Leitura limpa (sem "ahn", "hum" e repetições coladas): vale para a tela e para as exportações.
function clean() {
  return state.settings.cleanSpeech === true;
}

function tags() {
  return state.settings.tags && state.settings.tags.length ? state.settings.tags : DEFAULT_TAGS;
}
function tagById(id) {
  return tags().find((t) => t.id === id) || { id, label: id, emoji: "🏷", icon: "tag", color: "#888" };
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
  syncClean();

  if (document.activeElement !== $("m-title")) $("m-title").value = s.title;
  const names = participantNames(s);
  const end = s.endedAt || s.updatedAt;
  $("m-meta").innerHTML = [
    `<span>${esc(PLATFORM[s.platform] || s.platform)}</span>`,
    `<span>${esc(dateLabel(s.startedAt))}</span>`,
    `<span>${fmtDuration(end - s.startedAt)}</span>`,
    `<span>${names.length} participante${names.length === 1 ? "" : "s"}</span>`,
    isLive(s) ? `<span class="live-dot" style="color:var(--danger);font-weight:600">${icon(s.paused ? "pausar" : "gravando")}${s.paused ? "pausado" : "gravando"}</span>` : "",
  ].join("");
  $("m-pause").hidden = !isLive(s);
  // Parar: fecha a reunião agora, mesmo continuando na chamada. Retomar: só logo depois de parar, com a aba aberta.
  const resumable = !!s.endedAt && !s.recorder && Date.now() - s.endedAt < 10 * 60 * 1000 && s.id === state.stoppedHere;
  $("m-stop").hidden = !(isLive(s) || resumable);
  $("m-stop").className = "btn sm danger" + (resumable ? " resume" : "");
  $("m-stop").innerHTML = resumable
    ? icon("tocar") + "Retomar transcrição"
    : icon("parar") + "Parar";
  $("m-stop").title = resumable ? "Voltar a transcrever esta reunião na aba da chamada" : "Parar a transcrição agora. A reunião fica salva e você pode continuar na chamada.";
  renderHqButton();
  renderPlayer(s);
  $("m-undo").hidden = !(s.undo && s.undo.length);
  renderBanner();
  $("m-pause").innerHTML = s.paused
    ? icon("tocar") + "Retomar"
    : icon("pausar") + "Pausar";

  const hlCount = toBlocks(s).filter((b) => b.tags.length).length;
  $("c-hl").textContent = hlCount || "";
  $("c-notes").textContent = s.notes.items.length || "";
  for (const b of document.querySelectorAll(".subtabs button")) b.setAttribute("aria-selected", b.dataset.tab === state.tab);
  const nv = (s.summaryHistory || []).length;
  $("c-ata").textContent = nv > 1 ? `v${nv}` : "";
  for (const p of ["transcript", "highlights", "notes", "ata", "ai", "stats", "diag"]) $(`pane-${p}`).hidden = p !== state.tab;

  ({ transcript: renderTranscript, highlights: renderHighlights, notes: renderNotes, ata: renderAta, ai: renderAI, stats: renderStats, diag: renderDiag })[state.tab]();
}

function renderHqButton() {
  const s = state.session;
  const b = $("m-hq");
  b.hidden = !isLive(s) || s.recorder; // o gravador do computador já transcreve com o Whisper
  const h = state.hq || { state: "idle" };
  const label = {
    idle: "Alta precisão",
    starting: "Iniciando…",
    loading: `Baixando modelo ${h.progress || 0}%`,
    running: `Alta precisão ativa${h.device === "webgpu" ? " · GPU" : ""}`,
    error: "Tentar de novo",
  }[h.state] || "Alta precisão";
  b.innerHTML = icon("hq") + esc(label);
  b.classList.toggle("on", h.state === "running");
  b.title = h.state === "running"
    ? `Whisper rodando neste computador${h.rtf ? ` · ${h.rtf < 1 ? "mais rápido que" : "mais lento que"} o tempo real (${h.rtf}x)` : ""}. Clique para desligar.`
    : "Transcreve de novo o áudio da reunião com o Whisper, neste computador";
}

function renderBanner() {
  const parts = [];
  const rt = state.retrans;
  if (rt && state.session && rt.id === state.session.id) {
    const st = rt.status || {};
    const label = st.state === "decoding" ? "Lendo o áudio…" : st.state === "loading" ? `Baixando o modelo… ${st.progress || 0}%` : st.state === "error" ? `Falhou: ${st.message || ""}` : `Transcrevendo… ${st.progress || 0}%${st.segments ? ` · ${st.segments} trechos` : ""}`;
    parts.push(`<div class="banner${st.state === "error" ? " warn" : ""}">${icon("hq")} <b>${esc(label)}</b> ${st.state === "error" ? "" : "A transcrição aparece aqui conforme avança; você pode continuar usando o Escribanote."}</div>`);
  }
  // Aberto sozinho ao sair da chamada (ajuste "Ao sair da reunião")
  if (params.get("fim") && state.session?.endedAt && params.get("id") === state.session.id) {
    parts.push(`<div class="banner"><b>A chamada terminou e a transcrição foi encerrada.</b> ${state.session.summary?.text ? "A ata já está na aba <b>Ata</b>." : state.settings.autoAta ? "A ata está sendo gerada e aparece na aba <b>Ata</b>." : "Gere a ata na aba <b>Ata</b>,"} revise os destaques ou exporte pelo botão <b>Exportar</b>.</div>`);
  }
  const li = state.langIssue;
  if (li) {
    parts.push(`<div class="banner warn"><b>As legendas parecem estar em ${esc(LANG_NAMES[li.seen] || li.seen)}</b>, mas a reunião é em ${esc(LANG_NAMES[li.expected] || li.expected)}.
      Isso derruba a qualidade da transcrição. No Meet: <i>Mais opções › Configurações › Legendas › Idioma da reunião</i>.${state.hq.state === "running" ? "" : " Ou ligue a <b>Alta precisão</b>, que não depende das legendas."}</div>`);
  }
  if (state.hq.state === "error" && state.hq.message) parts.push(`<div class="banner warn">${icon("hq")} ${esc(state.hq.message)}</div>`);
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
  if (renaming()) return;
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
  const value = e.target.value.trim();
  if (!value || value === state.session.title) { e.target.value = state.session.title; return; }
  state.session = normalize(await send({ type: "update", id: state.session.id, title: value }));
  renderMeeting();
  renderList();
  toast("Reunião renomeada");
});
$("m-title").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
  if (e.key === "Escape") { e.target.value = state.session ? state.session.title : ""; e.target.blur(); }
});
$("m-rename").addEventListener("click", () => { $("m-title").focus(); $("m-title").select(); });

$("m-stop").addEventListener("click", async () => {
  const s = state.session;
  if (!s) return;
  const stopping = !s.endedAt;
  const r = await send({ type: stopping ? "end-live" : "resume-live", id: s.id });
  if (r && r.error) return toast(r.error);
  if (r && r.id) state.session = normalize(r);
  state.stoppedHere = stopping ? s.id : null;
  toast(stopping ? "Transcrição encerrada. A reunião ficou salva." : "Transcrição retomada");
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
// Partes escolhidas (lembradas em Ajustes "exportInclude"); quantas há nesta reunião, para mostrar ao lado.
function exportInclude() {
  return { ...EXPORT_DEFAULT, ...(state.settings.exportInclude || {}) };
}
function exportCounts(s) {
  if (!s) return {};
  const blocks = toBlocks(s);
  return {
    chat: blocks.filter((b) => b.kind === "chat").length,
    notes: s.notes.items.length + (s.notes.text.trim() ? 1 : 0),
    highlights: blocks.filter((b) => b.tags.length).length,
    chapters: (s.chapters || []).length,
    ai: aiConversations(s).reduce((n, c) => n + c.pairs.length, 0),
  };
}
function buildExportMenu() {
  const items = [
    ["rich", "copiar", "Copiar formatado", "Docs, Notion, e-mail"],
    ["plain", "texto", "Copiar como texto", ""],
    ["pdf", "pdf", "Salvar como PDF", "com capturas"],
    null,
    ...Object.entries(FORMATS).map(([ext, f]) => [ext, "baixar", f.label, ""]),
  ];
  $("export-menu").innerHTML =
    // Uso institucional (MPGO), desligado por padrão: ligado, a ata no modelo da equipe vai junto.
    `<label class="menu-opt inst"><input type="checkbox" id="exp-ata"${state.settings.exportAta === true ? " checked" : ""}>Incluir a ata e os textos institucionais</label>` +
    `<label class="menu-opt"><input type="checkbox" id="exp-clean"${clean() ? " checked" : ""}>Leitura limpa (sem “ahn”, “hum” e repetições)</label><hr>` +
    `<div class="menu-head">Incluir na exportação</div>` +
    (() => {
      const inc = exportInclude();
      const n = exportCounts(state.session);
      return EXPORT_PARTS.map(([k, label]) => `<label class="menu-opt${n[k] === 0 ? " none" : ""}"><input type="checkbox" data-inc="${k}"${inc[k] ? " checked" : ""}>${esc(label)}<small>${n[k] ? n[k] : "nenhum"}</small></label>`).join("");
    })() +
    `<p class="menu-note">Valem para copiar, PDF, Markdown e texto. SRT e VTT levam só as falas; JSON leva tudo.</p><hr>` +
    items
      .map((it) => (it ? `<button data-exp="${it[0]}"><span>${icon(it[1])}</span>${esc(it[2])}${it[3] ? `<small>${esc(it[3])}</small>` : ""}</button>` : "<hr>"))
      .join("");
}
buildExportMenu();
$("m-export").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("export-menu");
  menu.hidden = !menu.hidden;
  if (menu.hidden) return;
  buildExportMenu(); // contagens desta reunião
  $("exp-ata").checked = state.settings.exportAta === true;
  $("exp-clean").checked = clean();
  // No painel lateral (estreito) o menu não cabe à direita do botão: ancora pela direita.
  menu.classList.remove("flip");
  const r = menu.getBoundingClientRect();
  if (r.right > document.documentElement.clientWidth - 8) menu.classList.add("flip");
});
document.addEventListener("click", () => ($("export-menu").hidden = true));
$("export-menu").addEventListener("change", async (e) => {
  if (e.target.id === "exp-clean") return setClean(e.target.checked);
  if (e.target.dataset.inc) {
    state.settings = await setSettings({ exportInclude: { ...exportInclude(), [e.target.dataset.inc]: e.target.checked } });
    return;
  }
  if (e.target.id !== "exp-ata") return;
  state.settings = await setSettings({ exportAta: e.target.checked });
  const field = document.querySelector('#settings [name="exportAta"]');
  if (field) field.checked = e.target.checked;
  toast(e.target.checked ? "Exportações com a ata e os textos institucionais" : "Exportações só com a reunião, sem a ata");
});
$("export-menu").addEventListener("click", async (e) => {
  if (e.target.closest(".menu-opt")) return void e.stopPropagation(); // marcar a opção não fecha o menu
  const b = e.target.closest("[data-exp]");
  if (!b || !state.session) return;
  const s = state.session;
  const kind = b.dataset.exp;
  const ata = state.settings.exportAta === true && institutional();
  const opts = { tags: tags(), ata, clean: clean(), include: exportInclude() };
  try {
    if (kind === "rich") {
      const html = toHtml(s, opts);
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([toText(s, opts)], { type: "text/plain" }) }),
      ]);
      toast("Copiado — cole no Google Docs, Notion ou e-mail");
    } else if (kind === "plain") {
      await navigator.clipboard.writeText(toText(s, opts));
      toast("Transcrição copiada");
    } else if (kind === "pdf") {
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/print.html?id=${s.id}`) });
    } else {
      const f = FORMATS[kind];
      const url = URL.createObjectURL(new Blob([f.render(s, opts)], { type: `${f.mime};charset=utf-8` }));
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
      <input maxlength="120" data-count="focus" list="pop-list" placeholder="${esc(placeholder)}">
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
// Caixa de texto flutuante (correção de uma fala). Ctrl+Enter salva, Esc cancela.
function askText(anchor, { label, value = "" }) {
  closeInline();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<label class="field-label">${esc(label)}</label><textarea maxlength="20000" data-count="focus"></textarea>
      <div class="ask-acts"><button class="btn sm" data-cancel>Cancelar</button><button class="btn sm primary" data-ok>Salvar</button></div>`;
    document.body.appendChild(pop);
    const ta = pop.querySelector("textarea");
    ta.value = value;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 180) + "px";
    const done = (v) => { pop.remove(); closeInline.current = null; resolve(v); };
    closeInline.current = () => done(null);
    pop.querySelector("[data-ok]").addEventListener("click", () => done(ta.value));
    pop.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    ta.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done(ta.value); });
    ta.focus();
  });
}
// Dividir uma fala: clique no texto onde a outra pessoa começa e escolha quem fala a segunda parte.
// Resolve com {before, after, speakerId} (ou null).
function askSplit(anchor, { text, options, current }) {
  closeInline();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    const other = options.find((o) => o.value !== current);
    pop.innerHTML = `<label class="field-label">Clique onde a outra parte começa</label><textarea readonly></textarea>
      <label class="field-label">A segunda parte é de</label><select>${options.map((o) => `<option value="${esc(o.value)}"${o.value === (other || options[0]).value ? " selected" : ""}>${esc(o.label)}${o.value === current ? " (mesmo falante)" : ""}</option>`).join("")}</select>
      <p class="muted tiny" data-preview></p>
      <div class="ask-acts"><button class="btn sm" data-cancel>Cancelar</button><button class="btn sm primary" data-ok disabled>Dividir</button></div>`;
    document.body.appendChild(pop);
    const ta = pop.querySelector("textarea");
    ta.value = text;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(420, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = Math.max(12, Math.min(r.bottom + 6, window.innerHeight - 300)) + "px";
    const cut = () => {
      const i = ta.selectionStart;
      return { before: text.slice(0, i).trim(), after: text.slice(i).trim() };
    };
    const update = () => {
      const { before, after } = cut();
      const ok = !!(before && after);
      pop.querySelector("[data-ok]").disabled = !ok;
      pop.querySelector("[data-preview]").textContent = ok ? `Segunda parte: “${after.length > 60 ? after.slice(0, 60) + "…" : after}”` : "Escolha um ponto no meio do texto.";
    };
    const done = (v) => { pop.remove(); closeInline.current = null; resolve(v); };
    closeInline.current = () => done(null);
    for (const ev of ["click", "keyup", "select"]) ta.addEventListener(ev, update);
    pop.querySelector("[data-ok]").addEventListener("click", () => done({ ...cut(), speakerId: pop.querySelector("select").value }));
    pop.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") done(null); });
    ta.focus();
    ta.setSelectionRange(0, 0);
    update();
  });
}
// Lista flutuante (escolher um falante). Resolve com o valor escolhido (ou null).
function askSelect(anchor, { label, options }) {
  closeInline();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<label class="field-label">${esc(label)}</label><select>${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("")}</select>
      <div class="ask-acts"><button class="btn sm" data-cancel>Cancelar</button><button class="btn sm primary" data-ok>Mover</button></div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = Math.min(280, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 120) + "px";
    const done = (v) => { pop.remove(); closeInline.current = null; resolve(v); };
    closeInline.current = () => done(null);
    pop.querySelector("[data-ok]").addEventListener("click", () => done(pop.querySelector("select").value));
    pop.querySelector("[data-cancel]").addEventListener("click", () => done(null));
    pop.querySelector("select").focus();
  });
}
async function undoLast() {
  const s = state.session;
  if (!s || !(s.undo && s.undo.length)) return;
  state.session = normalize(await send({ type: "undo-edit", id: s.id }));
  toast("Correção desfeita");
  renderMeeting();
}
$("m-undo").addEventListener("click", undoLast);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.target.closest("input, textarea, [contenteditable]") && state.view === "meeting" && state.tab === "transcript") { e.preventDefault(); undoLast(); }
});

// ----- Citações da IA: [00:12:31] na ata e no chat vira link para o trecho da transcrição -----
const CITE_RX = /\[(\d{1,2}:\d{2}:\d{2})((?:\s*[,;–-]\s*\d{1,2}:\d{2}:\d{2})*)\]/g;
function withCites(html) {
  return html.replace(CITE_RX, (_, first, rest) => {
    const all = [first, ...(rest.match(/\d{1,2}:\d{2}:\d{2}/g) || [])];
    return `<span class="cites">${all.map((t) => `<button type="button" class="cite" data-cite="${t}" title="Ir para este trecho da transcrição">${t}</button>`).join("")}</span>`;
  });
}
function citeMs(t) {
  const [h, m, sec] = t.split(":").map(Number);
  return ((h * 60 + m) * 60 + sec) * 1000;
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-cite]");
  if (!c || !state.session) return;
  e.preventDefault();
  const at = state.session.startedAt + citeMs(c.dataset.cite);
  if (state.query) { $("t-search").value = ""; state.query = ""; } // um filtro de busca esconderia o trecho
  state.tab = "transcript";
  state.follow = false;
  renderMeeting();
  // o bloco que estava falando nesse instante (o último que começou até ali, com 2 s de folga)
  const blks = [...document.querySelectorAll(".blk")];
  const el = blks.filter((x) => Number(x.dataset.start) <= at + 2000).pop() || blks[0];
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
});

// ----- Localizar e substituir (usa o texto da busca como "o que trocar") -----
function replaceOpts() {
  return { wholeWord: $("t-whole").checked, caseSensitive: $("t-case").checked };
}
function updateReplaceInfo() {
  if ($("t-replace").hidden || !state.session) return;
  const find = $("t-search").value.trim();
  const n = find ? countMatches(state.session, find, replaceOpts()) : 0;
  $("t-repl-go").disabled = !n || clean();
  $("t-repl-go").textContent = n ? `Substituir ${n === 1 ? "1 ocorrência" : `${n} ocorrências`}` : "Substituir tudo";
  $("t-repl-info").textContent = clean() ? "Desligue a leitura limpa para substituir." : !find ? "Digite na busca o que trocar." : n ? "Dá para desfazer com Ctrl+Z." : "Nada encontrado.";
}
$("t-replace-btn").addEventListener("click", () => {
  const open = $("t-replace").hidden;
  $("t-replace").hidden = !open;
  $("t-replace-btn").setAttribute("aria-expanded", String(open));
  if (open) { updateReplaceInfo(); ($("t-search").value ? $("t-repl") : $("t-search")).focus(); }
});
for (const id of ["t-search", "t-whole", "t-case"]) $(id).addEventListener("input", updateReplaceInfo);
$("t-repl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("t-repl-go").click(); } });
$("t-repl-go").addEventListener("click", async () => {
  const find = $("t-search").value.trim();
  if (!find || !state.session || clean()) return;
  const repl = $("t-repl").value;
  const r = await send({ type: "replace-all", id: state.session.id, find, repl, ...replaceOpts() });
  state.session = normalize(r);
  toast(r.replaced ? `${r.replaced} ocorrência${r.replaced === 1 ? "" : "s"} de “${find}” trocada${r.replaced === 1 ? "" : "s"} por “${repl}” · Ctrl+Z desfaz` : "Nada encontrado");
  if (r.replaced) { $("t-search").value = repl.trim(); $("t-search").dispatchEvent(new Event("input")); }
  renderMeeting();
  updateReplaceInfo();
});

// ----- Capítulos -----
function renderChapters(s) {
  const el = $("chapters");
  const list = s.chapters || [];
  const dur = (s.endedAt || s.updatedAt) - s.startedAt;
  const canMake = !isLive(s) && dur >= 3 * 60_000 && s.entries.length + s.asr.length >= 8;
  if (!list.length && !canMake) { el.hidden = true; return; }
  el.hidden = false;
  if (!list.length) {
    el.innerHTML = `<button type="button" class="chip" id="ch-make" title="Divide a reunião por assunto com a IA (chave própria ou 1 crédito do Pro)">${state.chaptersBusy ? icon("aguarde") + "Dividindo em capítulos…" : icon("capitulos") + "Dividir em capítulos"}</button>`;
  } else {
    el.innerHTML = list.map((c, i) => `<button type="button" class="chip" data-ch="${i + 1}" title="${esc(c.title)}"><time>${clock(c.startAt - s.startedAt)}</time><span>${esc(c.title)}</span></button>`).join("") +
      `<button type="button" class="chip" id="ch-make" title="Gerar os capítulos de novo" aria-label="Gerar os capítulos de novo">${icon(state.chaptersBusy ? "aguarde" : "refazer")}</button><button type="button" class="chip" id="ch-clear" title="Remover os capítulos" aria-label="Remover os capítulos">${icon("fechar")}</button>`;
  }
  $("ch-make").addEventListener("click", async () => {
    if (state.chaptersBusy) return;
    state.chaptersBusy = true;
    renderChapters(s);
    try {
      state.session = normalize(await send({ type: "chapters", id: s.id }));
      toast(`${state.session.chapters.length} capítulos`);
    } catch (err) { toast(err.message || String(err)); } finally { state.chaptersBusy = false; renderMeeting(); }
  });
  $("ch-clear")?.addEventListener("click", async () => { state.session = normalize(await send({ type: "chapters-clear", id: s.id })); renderMeeting(); });
  el.querySelectorAll("[data-ch]").forEach((b) => b.addEventListener("click", () => {
    const li = $(`ch-${b.dataset.ch}`);
    if (li) li.scrollIntoView({ block: "start", behavior: "smooth" });
  }));
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
  state.session = normalize(await send({ type: "update", id: s.id, speakers: { [id]: name.slice(0, 120) }, ...(other ? { apart: [id, other] } : {}) }));
  renderMeeting();
  toast(`${current} agora é ${name}`);
}

// ----- Transcrição -----
function renderSpeakers(s) {
  const ids = [...new Set(s.entries.map((e) => e.speakerId))];
  $("speakers").innerHTML = ids
    .map((id) => {
      const name = speakerName(s, id);
      return `<span class="spk${state.hidden.has(id) ? " off" : ""}" data-id="${esc(id)}" title="Clique para mostrar ou ocultar as falas">${avatar(id, name)}${esc(name)}<button class="spk-edit" data-rename title="Renomear">${icon("editar")}</button></span>`;
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

// Hora do relógio de um momento da reunião. Arquivo importado não tem: o início é o da importação.
function wallClock(s, at) {
  if (s.platform === "import") return "";
  return `<span class="wall" title="Hora do relógio">${new Date(at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>`;
}

function blockHtml(s, b, q) {
  const tagChips = b.tags
    .map((id) => {
      const t = tagById(id);
      return `<span class="tag" style="color:${t.color};border-color:${t.color}">${icon(tagIcon(t))}${esc(t.label)}</span>`;
    })
    .join("");
  // As marcações ficam num só botão com menu: a barra cabe numa linha no painel lateral, e as
  // marcações da fala continuam à vista nas etiquetas ao lado do nome.
  const marked = b.tags.length ? ` (${b.tags.map((id) => tagById(id).label).join(", ")})` : "";
  const acts = `<span class="menu-wrap tag-pick"><button data-act="tags" class="${b.tags.length ? "on" : ""}" title="Marcar${esc(marked)}" aria-label="Marcar" aria-haspopup="menu" aria-expanded="false">${icon("tag")}</button>
    <span class="menu tag-menu" role="menu" hidden>${tags()
      .map((t) => {
        const on = b.tags.includes(t.id);
        return `<button data-tag="${t.id}" role="menuitemcheckbox" aria-checked="${on}" style="--tc:${t.color}">${icon(tagIcon(t))}<span>${esc(t.label)}</span>${on ? `<i class="tm-ok">${icon("ok")}</i>` : ""}</button>`;
      })
      .join("")}</span></span>`;
  // Texto diferente do transcrito (revisão da IA ou correção à mão): as palavras mudadas ficam marcadas.
  const changed = (b.fixed || b.edited) && b.original !== b.text;
  const badges =
    (b.hq ? `<span class="badge-hq" title="Transcrito pela alta precisão (Whisper local)">${icon("hq")}</span>` : "") +
    (b.fixed ? `<span class="badge-fix" data-act="orig" title="Revisado pela IA — clique para ver o original">${icon("ok")}revisado</span>` : "") +
    (b.edited ? `<span class="badge-edit"${changed ? ' data-act="orig"' : ""} title="Corrigido à mão${changed ? " — clique para ver o original" : ""}">${icon("editar")}editado</span>` : "");
  // Um <p> por parágrafo; do segundo em diante, o horário em que ele começou.
  const paras = b.paras && b.paras.length ? b.paras : [{ at: b.startAt, text: b.text, original: b.original }];
  const body = paras
    .map((p, i) => {
      const t = i ? `<time class="pt${hasAudio(s) ? " seek" : ""}" data-at="${p.at}" title="${hasAudio(s) ? "Ouvir a partir daqui" : "Momento em que este trecho começou"}">${clock(p.at - s.startedAt)}</time>` : "";
      const html = q ? highlight(p.text, q) : changed && p.original !== p.text ? diffHtml(p.original, p.text) : esc(p.text);
      return `<p>${t}${html}</p>`;
    })
    .join("");
  const orig = changed && state.showOrig.has(b.key) ? `<p class="orig">${esc(b.original)}</p>` : "";
  return `<li class="blk${b.kind === "chat" ? " chat" : ""}" data-key="${esc(b.key)}" data-ids="${esc(JSON.stringify(b.ids))}" data-tags="${esc(JSON.stringify(b.tags))}" data-start="${b.startAt}" data-at="${b.endAt}">
    ${avatar(b.speakerId, b.speaker, 32)}
    <div><div class="who"><b style="color:${colorFor(b.speaker)}" data-speaker="${esc(b.speakerId)}" title="Clique para renomear">${highlight(b.speaker, q)}</b><time class="${hasAudio(s) ? "seek" : ""}" data-at="${b.startAt}" title="${hasAudio(s) ? "Ouvir a partir daqui" : ""}">${clock(b.startAt - s.startedAt)}</time>${wallClock(s, b.startAt)}${b.kind === "chat" ? '<span class="muted tiny">chat</span>' : ""}${badges}${tagChips}</div>
    ${body}${orig}</div>
    <div class="acts">${acts}<button data-act="copy" title="Copiar">${icon("copiar")}</button><button data-act="note" title="Nota neste ponto">${icon("nota")}</button><button data-act="edit" title="Corrigir o texto">${icon("editar")}</button><button data-act="split" title="Dividir esta fala em duas">${icon("dividir")}</button><button data-act="move" title="Mover para outro falante">${icon("falante")}</button><button data-act="del" title="Apagar esta fala">${icon("apagar")}</button></div>
  </li>`;
}

function renderTranscript() {
  const s = state.session;
  if (!s) return;
  renderSpeakers(s);
  const q = state.query.trim().toLowerCase();
  renderChapters(s);
  const items = timeline(s, { clean: clean() }).filter((it) => {
    if (it.type !== "block") return !q;
    const b = it.block;
    return !state.hidden.has(b.speakerId) && (!q || b.text.toLowerCase().includes(q) || b.speaker.toLowerCase().includes(q));
  });
  const html = items
    .map((it) => {
      if (it.type === "block") return blockHtml(s, it.block, q);
      if (it.type === "chapter") return q ? "" : `<li class="tl-chapter" id="ch-${it.chapter.n}"><span class="n">${it.chapter.n}</span>${esc(it.chapter.title)}</li>`;
      const t = clock(it.at - s.startedAt);
      if (it.type === "note") return `<li class="tl-note">${icon("nota")}<time>${t}</time><span>${esc(it.note.text)}</span><button class="x" data-del-note="${esc(it.note.id)}" title="Apagar nota" aria-label="Apagar nota">${icon("fechar")}</button></li>`;
      const url = state.shots[it.shot.id];
      return `<li class="tl-shot${it.shot.auto ? " auto" : ""}"><time>${icon("captura")}${t}${it.shot.auto ? " · automática" : ""}</time>${url ? `<img src="${url}" alt="Captura de tela" data-shot="${esc(it.shot.id)}">` : ""}</li>`;
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
async function setClean(on) {
  state.settings = await setSettings({ cleanSpeech: on });
  syncClean();
  renderMeeting();
  toast(on ? "Leitura limpa: sem “ahn”, “hum” e repetições, na tela e nas exportações" : "Leitura literal: o texto como foi transcrito");
}
function syncClean() {
  $("t-clean").setAttribute("aria-pressed", String(clean()));
  const m = document.getElementById("exp-clean");
  if (m) m.checked = clean();
}
$("t-clean").addEventListener("click", () => setClean(!clean()));
$("t-search").addEventListener("input", (e) => {
  state.query = e.target.value;
  renderTranscript();
});

// Menu de marcações de uma fala: abre para baixo, ou para cima quando falta espaço no fim da lista.
function closeTagMenus(except) {
  for (const m of $("timeline").querySelectorAll(".tag-menu:not([hidden])")) {
    if (m === except) continue;
    m.hidden = true;
    m.closest(".blk").classList.remove("menu-open");
    m.previousElementSibling.setAttribute("aria-expanded", "false");
  }
}
function toggleTagMenu(btn) {
  const menu = btn.nextElementSibling;
  closeTagMenus(menu);
  menu.hidden = !menu.hidden;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
  btn.closest(".blk").classList.toggle("menu-open", !menu.hidden);
  if (menu.hidden) return;
  menu.classList.remove("up");
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 8) menu.classList.add("up");
}
document.addEventListener("click", (e) => { if (!e.target.closest(".tag-pick")) closeTagMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTagMenus(); });

$("timeline").addEventListener("click", async (e) => {
  const s = state.session;
  if (!s) return;
  const tm = e.target.closest("time[data-at]");
  if (tm && hasAudio(s)) return playAt(Number(tm.dataset.at));
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
  const pick = e.target.closest('[data-act="tags"]');
  if (pick) return toggleTagMenu(pick);
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
    await navigator.clipboard.writeText([...blk.querySelectorAll("p:not(.orig)")].map((p) => p.innerText).join("\n\n"));
    toast("Trecho copiado");
  } else if (act && (act.dataset.act === "edit" || act.dataset.act === "split") && clean()) {
    // Corrigir e dividir trabalham sobre o texto literal: na leitura limpa o que se vê não é o que está guardado.
    toast("Desligue a leitura limpa para corrigir ou dividir esta fala");
  } else if (act && act.dataset.act === "edit") {
    const ids = JSON.parse(blk.dataset.ids);
    const b = toBlocks(s).find((x) => x.key === blk.dataset.key);
    const text = await askText(act, { label: "Corrigir o texto desta fala", value: b ? b.text : "" });
    if (text != null && text.trim() && text.trim() !== (b && b.text)) {
      state.session = normalize(await send({ type: "edit-block", id: s.id, ids, text: text.trim(), label: "texto" }));
      toast("Fala corrigida");
      renderMeeting();
    }
  } else if (act && act.dataset.act === "split") {
    const b = toBlocks(s).find((x) => x.key === blk.dataset.key);
    if (!b) return;
    const known = [...new Set(effectiveEntries(s).filter((e) => e.kind === "caption").map((e) => e.speakerId))].filter((id) => id !== "desconhecido");
    if (!known.includes(b.speakerId)) known.unshift(b.speakerId);
    const options = known.map((id) => ({ value: id, label: speakerName(s, id) }));
    const r = await askSplit(act, { text: b.text, options, current: b.speakerId });
    if (r) {
      state.session = normalize(await send({ type: "split-block", id: s.id, ids: JSON.parse(blk.dataset.ids), ...r, label: "dividir" }));
      toast(r.speakerId === b.speakerId ? "Fala dividida" : "Fala dividida: a segunda parte é de " + speakerName(state.session, r.speakerId));
      renderMeeting();
    }
  } else if (act && act.dataset.act === "move") {
    const ids = JSON.parse(blk.dataset.ids);
    const cur = blk.querySelector("[data-speaker]").dataset.speaker;
    const known = [...new Set(effectiveEntries(s).filter((e) => e.kind === "caption").map((e) => e.speakerId))].filter((id) => id !== cur && id !== "desconhecido");
    const options = known.map((id) => ({ value: id, label: speakerName(s, id) }));
    if (!options.length) return toast("Não há outro falante nesta reunião.");
    const to = await askSelect(act, { label: "Mover esta fala para", options });
    if (to) {
      state.session = normalize(await send({ type: "edit-block", id: s.id, ids, speakerId: to, label: "falante" }));
      toast("Fala movida para " + speakerName(state.session, to));
      renderMeeting();
    }
  } else if (act && act.dataset.act === "del") {
    const ids = JSON.parse(blk.dataset.ids);
    const ok = await askChoice(act, { title: "Apagar esta fala?", text: "Ela some da transcrição, da ata e das exportações. Dá para desfazer.", choices: [{ key: "ok", label: "Apagar", primary: true }, { key: "cancel", label: "Cancelar" }] });
    if (ok === "ok") {
      state.session = normalize(await send({ type: "edit-block", id: s.id, ids, deleted: true, label: "apagar" }));
      toast("Fala apagada");
      renderMeeting();
    }
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
  const blocks = toBlocks(s, { clean: clean() }).filter((b) => b.tags.length);
  if (!blocks.length) {
    $("pane-highlights").innerHTML = `<div class="list-empty"><b>Nenhum destaque ainda</b><br>
      Passe o mouse sobre uma fala e escolha uma tag (${tags().map((t) => `<span style="color:${t.color}">${icon(tagIcon(t))}</span>`).join(" ")}), use o botão ${icon("importante")} do widget
      ou o atalho <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> durante a reunião.</div>`;
    return;
  }
  $("pane-highlights").innerHTML = tags()
    .map((t) => {
      const list = blocks.filter((b) => b.tags.includes(t.id));
      if (!list.length) return "";
      return `<div class="hl-group"><h4 style="--tc:${t.color}">${icon(tagIcon(t))}${esc(t.label)} <span class="count">${list.length}</span></h4>${list
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
        .map((n) => `<li><time>${clock(n.at - s.startedAt)}</time><span>${esc(n.text)}</span><button class="x" data-del-note="${esc(n.id)}" title="Apagar" aria-label="Apagar">${icon("fechar")}</button></li>`)
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
  if (pro) return { ok: true, kind: "pro", text: `Escribanote Pro · ${account.balance ?? 0} crédito${account.balance === 1 ? "" : "s"}`, hint: `Ata, revisão e pergunta custam 1 crédito cada; pergunta com mais de ${LONG_QUESTION.toLocaleString("pt-BR")} caracteres, material de apoio, capturas ou pesquisa na web, 2.` };
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
    if (viewing) $("ata-body").innerHTML = withCites(mdToHtml(viewing.text));
    else if (s.summary) $("ata-body").innerHTML = withCites(mdToHtml(s.summary.text));
    if (viewing || s.summary) decorateAta();
    else $("ata-body").innerHTML = s.entries.length
      ? `<div class="ata-empty"><div class="ico">${icon("nota")}</div><b>Nenhuma ata ainda</b><p>Gere uma ata com resumo, decisões, itens de ação e pendências. Escolha um modelo acima se a sua equipe tem um formato próprio.</p></div>`
      : `<div class="ata-empty"><div class="ico">${icon("mic")}</div><b>A ata nasce da transcrição</b><p>Quando a reunião tiver falas registradas, gere a ata por aqui.</p></div>`;
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
      ? `${fixedCount} trecho${fixedCount > 1 ? "s" : ""} corrigido${fixedCount > 1 ? "s" : ""}. As palavras alteradas aparecem marcadas na transcrição; clique em “revisado” para ver o original.`
      : "Corrige palavras mal reconhecidas (fala rápida, nomes, siglas) usando o contexto e o seu glossário. O texto original fica guardado.";
  }
  $("review-run").disabled = !s.entries.length || (state.busy && state.busy !== "review");

  // Conversas
  const sel = $("chat-select");
  sel.innerHTML =
    `<option value="">Nova conversa</option>` +
    s.chats.map((c, i) => `<option value="${esc(c.id)}">${c.auto ? "[auto] " : ""}${esc((questions().find((q) => q.id === c.tplId)?.label || c.messages[0]?.text || `Conversa ${i + 1}`).slice(0, 40))}</option>`).join("");
  if (state.chatId && !s.chats.some((c) => c.id === state.chatId)) state.chatId = null;
  sel.value = state.chatId || "";
  if (state.busy !== "chat") renderChatLog();

  // Sugestões
  if (!state.index.length) state.index = await send({ type: "list" });
  const prev = previousWithSame(s)[0];
  const quick = questions().filter((p) => p.pinned !== false).map((p) => `<button class="chip" data-q="${esc(p.text)}" title="${esc(p.text.length > 280 ? p.text.slice(0, 280) + "…" : p.text)}${questionLength(p.text) > LONG_QUESTION ? " (pergunta longa: 2 créditos no Pro)" : ""}">${esc(p.label)}${p.auto ? '<span class="pill-auto" title="Feita sozinha quando a reunião termina">auto</span>' : ""}</button>`);
  if (!quick.length && questions().length) quick.push(`<button class="chip ghost" data-open-models>Nenhum modelo fixado · escolher atalhos</button>`);
  if (prev) quick.push(`<button class="chip" data-prev="${esc(prev.id)}">${icon("anterior")}Reunião anterior com estes participantes</button>`);
  $("quick").innerHTML = quick.join("");
  renderScope();
  renderSupport();
  renderQuestionList();
}

// ----- Material de apoio (fontes externas à reunião, vão junto em toda pergunta) -----
const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const SUPPORT_ICON = { text: "texto", pdf: "pdf", image: "captura" };
function renderSupport() {
  const s = state.session;
  const list = s?.support || [];
  const shots = s?.shots?.length || 0;
  $("opt-shots").checked = !!s?.aiOptions?.shots;
  $("opt-shots").disabled = !shots && !s?.aiOptions?.shots;
  $("opt-shots-n").textContent = shots ? `(${shots}${shots > 20 ? ", 20 espaçadas" : ""})` : "(nenhuma nesta reunião)";
  $("opt-web").checked = !!s?.aiOptions?.web;
  // Transcrição longa ainda não revisada: revisar antes ajuda roteiros que dependem de preços, nomes e termos.
  const reviewed = s ? toBlocks(s).some((b) => b.fixed) : true;
  const tip = s && !reviewed && s.entries.length >= 40;
  $("review-tip").hidden = !tip;
  if (tip) $("review-tip").innerHTML = `A transcrição ainda não foi revisada pela IA. Para análises longas, revisar antes corrige termos, nomes e preços mal reconhecidos. <button type="button" class="linkish" id="review-now">Revisar agora</button>`;
  $("support-count").textContent = list.length ? `${list.length} · vai junto em toda pergunta desta reunião` : "";
  $("support-list").innerHTML = list
    .map((x) => `<span class="support-item" title="${esc(x.name)}">${icon(SUPPORT_ICON[x.kind] || "texto")}<span class="support-name">${esc(x.name)}</span><small>${x.kind === "text" ? `${fmtN(x.size)} caract.` : fmtSize(x.size)}</small><button type="button" class="x" data-support-rm="${esc(x.id)}" aria-label="Remover ${esc(x.name)}" title="Remover">${icon("fechar")}</button></span>`)
    .join("");
}
const TEXT_EXT = /\.(txt|md|csv|tsv|json)$/i;
function readAs(file, how) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fail(r.error);
    how === "text" ? r.readAsText(file) : r.readAsDataURL(file);
  });
}
async function addSupportItem(item) {
  const next = await send({ type: "support-add", id: state.session.id, item });
  if (next?.error) throw new Error(next.error);
  if (next) state.session = next;
  renderSupport();
}
async function addSupportFiles(files) {
  let ok = 0;
  for (const f of files) {
    try {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) await addSupportItem({ kind: "pdf", name: f.name, data: (await readAs(f, "url")).split(",")[1] });
      else if (/^image\//.test(f.type)) await addSupportItem({ kind: "image", name: f.name, mime: f.type, data: (await readAs(f, "url")).split(",")[1] });
      else if (/^text\//.test(f.type) || f.type === "application/json" || TEXT_EXT.test(f.name)) await addSupportItem({ kind: "text", name: f.name, data: await readAs(f, "text") });
      else throw new Error(`${f.name}: use texto, CSV, JSON, PDF ou imagem`);
      ok++;
    } catch (err) {
      toast(err.message);
      return;
    }
  }
  if (ok) toast(ok === 1 ? "Material de apoio anexado" : `${ok} materiais anexados`);
}
for (const [id, key] of [["opt-shots", "shots"], ["opt-web", "web"]])
  $(id).addEventListener("change", async (e) => {
    const next = await send({ type: "ai-options", id: state.session.id, [key]: e.target.checked }).catch((err) => (toast(err.message), null));
    if (next) state.session = next;
    renderSupport();
    toast(key === "shots" ? (e.target.checked ? "As perguntas desta reunião levam as capturas de tela" : "Capturas de tela fora das perguntas") : e.target.checked ? "A IA pode pesquisar na web nesta reunião" : "Pesquisa na web desligada");
  });
$("review-tip").addEventListener("click", (e) => {
  if (e.target.id === "review-now") $("review-run").click();
});
$("support-file").addEventListener("click", () => $("support-input").click());
$("support-input").addEventListener("change", async (e) => {
  await addSupportFiles([...e.target.files]);
  e.target.value = "";
});
$("support-paste").addEventListener("click", async () => {
  const text = await askText($("support-paste"), { label: "Cole o material (cotações, notícias, calendário…). Ctrl+Enter salva" });
  if (!text || !text.trim()) return;
  const first = text.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 50);
  try {
    await addSupportItem({ kind: "text", name: first || "Texto colado", data: text.trim() });
    toast("Texto anexado como material de apoio");
  } catch (err) {
    toast(err.message);
  }
});
$("support-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-support-rm]");
  if (!b) return;
  const next = await send({ type: "support-remove", id: state.session.id, supportId: b.dataset.supportRm });
  if (next) state.session = next;
  renderSupport();
  toast("Material removido");
});
for (const ev of ["dragover", "dragenter"]) $("support").addEventListener(ev, (e) => (e.preventDefault(), $("support").classList.add("drop")));
for (const ev of ["dragleave", "drop"]) $("support").addEventListener(ev, () => $("support").classList.remove("drop"));
$("support").addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) addSupportFiles([...e.dataTransfer.files]);
});

// ----- Modelos de perguntas (Ajustes "questions", valem para todas as reuniões) -----
// Rascunho de um modelo novo: só entra na lista (e nos atalhos) quando tem nome e pergunta.
let qDraft = null;
const isPlaceholder = (q) => q.label === "Nova pergunta" && q.text === "Escreva aqui a pergunta"; // versões antigas salvavam isto ao clicar em "+ Novo modelo"
function questions() {
  const list = Array.isArray(state.settings.questions) ? state.settings.questions : DEFAULT_QUESTIONS;
  return list.filter((q) => q && q.text && !isPlaceholder(q));
}
async function saveQuestions(list) {
  state.settings = await setSettings({ questions: list });
  renderAI();
}
// As mudanças na lista entram em fila: cada uma parte da lista já salva pela anterior
// (editar o nome e logo clicar no alfinete não desfaz a edição).
let qChain = Promise.resolve();
function mutateQuestions(fn) {
  qChain = qChain.catch(() => {}).then(() => saveQuestions(fn(questions())));
  return qChain;
}
function updateQuestion(id, patch) {
  return mutateQuestions((list) => list.map((q) => (q.id === id ? { ...q, ...patch } : q)));
}
function renderQuestionList() {
  const list = questions();
  const autos = list.filter((q) => q.auto).length;
  const pinned = list.filter((q) => q.pinned !== false).length;
  $("q-count").textContent = `${list.length} modelo${list.length === 1 ? "" : "s"} · ${pinned} fixado${pinned === 1 ? "" : "s"}${autos ? ` · ${autos} automático${autos === 1 ? "" : "s"}` : ""}`;
  // Não apaga o que está sendo digitado; botões e interruptores podem ser redesenhados (o foco volta para o mesmo lugar).
  const act = document.activeElement;
  if ($("q-list").contains(act) && act.matches("input:not([type=checkbox]), textarea")) return;
  const refocus = $("q-list").contains(act) && act.dataset.act ? `[data-act="${act.dataset.act}"][data-id="${act.dataset.id}"]` : null;
  const draft = qDraft
    ? `<div class="q-row draft" data-draft="1">
      <div class="q-fields"><div class="cw"><input data-k="label" data-count="always" value="${esc(qDraft.label)}" maxlength="60" aria-label="Nome do novo modelo" placeholder="Nome curto (vira o atalho). Ex.: Riscos levantados">${countHtml(qDraft.label, 60)}</div>
        <div class="cw"><textarea data-k="text" data-count="always" rows="2" maxlength="${QUESTION_MAX}" aria-label="Pergunta do novo modelo" placeholder="A pergunta que a IA deve responder. Ex.: Quais riscos foram levantados e quem ficou de tratá-los?">${esc(qDraft.text)}</textarea>${countHtml(qDraft.text, QUESTION_MAX)}</div></div>
      <div class="q-side"><button type="button" class="btn sm primary" data-draft-save>Salvar</button><button type="button" class="btn sm ghost" data-draft-cancel>Cancelar</button></div>
    </div>`
    : "";
  const rows = list
    .map((q, i) => {
      const on = q.pinned !== false;
      const id = esc(q.id);
      return `<div class="q-row${on ? "" : " unpinned"}" data-id="${id}">
      <div class="q-fields"><div class="cw"><input data-k="label" data-count="always" value="${esc(q.label)}" maxlength="60" aria-label="Nome do modelo" placeholder="Nome curto">${countHtml(q.label, 60)}</div>
        <div class="cw"><textarea data-k="text" data-count="always" rows="2" maxlength="${QUESTION_MAX}" aria-label="Pergunta" placeholder="A pergunta que a IA deve responder">${esc(q.text)}</textarea>${countHtml(q.text, QUESTION_MAX)}</div></div>
      <div class="q-side"><label class="switch sm" title="Fazer esta pergunta sozinha quando a reunião terminar"><input type="checkbox" data-k="auto"${q.auto ? " checked" : ""}><span></span>Automática</label>
        <span class="q-acts">
        <button type="button" class="q-ic pin${on ? " on" : ""}" data-act="pin" data-id="${id}" aria-pressed="${on}" data-tip="${on ? "Fixado nos atalhos · clique para desafixar" : "Fora dos atalhos · clique para fixar"}" aria-label="${on ? "Desafixar dos atalhos" : "Fixar nos atalhos"}">${icon("fixar")}</button>
        <button type="button" class="q-ic" data-act="up" data-id="${id}" data-tip="Subir" aria-label="Subir"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" class="q-ic" data-act="down" data-id="${id}" data-tip="Descer" aria-label="Descer"${i === list.length - 1 ? " disabled" : ""}>↓</button>
        <button type="button" class="q-ic" data-act="run" data-id="${id}" data-tip="Perguntar agora" aria-label="Perguntar agora nesta reunião">${icon("enviar")}</button>
        <button type="button" class="q-ic danger" data-act="rm" data-id="${id}" data-tip="Apagar modelo" aria-label="Apagar o modelo">${icon("apagar")}</button></span></div>
    </div>`;
    })
    .join("");
  $("q-list").innerHTML = draft + (rows || (qDraft ? "" : '<p class="muted tiny">Nenhum modelo. Clique em “+ Novo modelo” ou escreva uma pergunta acima e clique em “Salvar modelo”.</p>'));
  $("q-add").disabled = !!qDraft;
  if (refocus) $("q-list").querySelector(refocus)?.focus();
}
$("q-list").addEventListener("input", (e) => {
  if (qDraft && e.target.closest("[data-draft]") && e.target.dataset.k) qDraft[e.target.dataset.k] = e.target.value;
});
$("q-list").addEventListener("change", (e) => {
  const row = e.target.closest(".q-row");
  const k = e.target.dataset.k;
  if (!row || !k || row.dataset.draft) return;
  const q = questions().find((x) => x.id === row.dataset.id);
  if (!q) return;
  if (k === "auto") return updateQuestion(q.id, { auto: e.target.checked }).then(() => toast(e.target.checked ? "Pergunta automática ligada" : "Pergunta automática desligada"));
  const v = e.target.value.trim();
  if (!v) {
    e.target.value = q[k];
    return toast(k === "label" ? "O modelo precisa de um nome" : "O modelo precisa de uma pergunta");
  }
  if (v === q[k]) return;
  updateQuestion(q.id, { [k]: v }).then(() => toast("Modelo salvo"));
});
$("q-list").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.closest("[data-draft]")) cancelDraft();
  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target.tagName === "INPUT") && e.target.closest("[data-draft]")) {
    e.preventDefault();
    saveDraft();
  }
});
function cancelDraft() {
  qDraft = null;
  renderQuestionList();
}
async function saveDraft() {
  const label = (qDraft?.label || "").trim();
  const text = (qDraft?.text || "").trim();
  const row = $("q-list").querySelector("[data-draft]");
  if (!label || !text) {
    toast(!label ? "Dê um nome curto ao modelo" : "Escreva a pergunta");
    row?.querySelector(`[data-k="${!label ? "label" : "text"}"]`)?.focus();
    return;
  }
  if (questions().some((q) => q.text === text)) return toast("Essa pergunta já é um modelo");
  qDraft = null;
  document.activeElement?.blur();
  await saveQuestions([{ id: Date.now().toString(36), label: label.slice(0, 60), text: text.slice(0, QUESTION_MAX), auto: false, pinned: true }, ...questions()]);
  toast(`“${label}” salvo e fixado nos atalhos`);
}
$("q-list").addEventListener("click", (e) => {
  if (e.target.closest("[data-draft-save]")) return saveDraft();
  if (e.target.closest("[data-draft-cancel]")) return cancelDraft();
  const btn = e.target.closest("[data-act]");
  if (!btn || btn.disabled) return;
  const list = questions();
  const i = list.findIndex((q) => q.id === btn.dataset.id);
  const q = list[i];
  if (!q) return;
  switch (btn.dataset.act) {
    case "pin": {
      const on = q.pinned === false;
      // Resposta imediata no botão; a lista e os atalhos são redesenhados ao salvar.
      btn.classList.toggle("on", on);
      btn.closest(".q-row").classList.toggle("unpinned", !on);
      return updateQuestion(q.id, { pinned: on }).then(() => toast(on ? `“${q.label}” fixado nos atalhos` : `“${q.label}” saiu dos atalhos (continua aqui na lista)`));
    }
    case "up":
    case "down": {
      const up = btn.dataset.act === "up";
      return mutateQuestions((cur) => {
        const a = cur.findIndex((x) => x.id === q.id);
        const b = up ? a - 1 : a + 1;
        if (a < 0 || b < 0 || b >= cur.length) return cur;
        const next = cur.slice();
        [next[a], next[b]] = [next[b], next[a]];
        return next;
      });
    }
    case "run":
      return ask(q.text);
    case "rm": {
      const before = list.slice();
      return mutateQuestions((cur) => cur.filter((x) => x.id !== q.id)).then(() =>
        toast(`Modelo “${q.label}” apagado`, { label: "Desfazer", run: () => saveQuestions(before).then(() => toast("Modelo restaurado")) }),
      );
    }
  }
});
$("q-add").addEventListener("click", () => {
  if (!qDraft) qDraft = { label: "", text: "" };
  $("q-manage").open = true;
  renderQuestionList();
  const first = $("q-list").querySelector('[data-draft] [data-k="label"]');
  first?.scrollIntoView({ block: "center", behavior: "smooth" });
  first?.focus();
});
$("q-reset").addEventListener("click", () => {
  if (!confirm("Voltar aos modelos de perguntas padrão? Os seus modelos serão substituídos.")) return;
  qDraft = null;
  const before = questions();
  saveQuestions(DEFAULT_QUESTIONS.map((q) => ({ ...q }))).then(() =>
    toast("Modelos padrão restaurados", { label: "Desfazer", run: () => saveQuestions(before).then(() => toast("Seus modelos voltaram")) }),
  );
});
$("q-save").addEventListener("click", async () => {
  const text = $("chat-input").value.trim();
  if (!text) return toast("Escreva a pergunta primeiro");
  if (questions().some((q) => q.text === text)) return toast("Essa pergunta já é um modelo");
  const label = await askInline($("q-save"), { label: "Nome do modelo (vira o atalho)", value: text.slice(0, 40), placeholder: "Ex.: Riscos levantados" });
  if (!label) return;
  await saveQuestions([...questions(), { id: Date.now().toString(36), label: label.slice(0, 60), text: text.slice(0, QUESTION_MAX), auto: false, pinned: true }]);
  toast("Modelo salvo e fixado: aparece em todas as reuniões");
});

// Pergunta longa (roteiro detalhado): mostra o começo e "ver a pergunta inteira".
function userMsgHtml(text) {
  const q = text.replace(/<reuniao_anterior[^>]*>[\s\S]*?<\/reuniao_anterior>/g, "").trim();
  if (q.length <= 600) return esc(q);
  const head = q.slice(0, 280).replace(/\s+\S*$/, "");
  return `<details class="long-q"><summary>${esc(head)}… <span class="muted tiny">ver a pergunta inteira (${fmtN(q.length)} caracteres)</span></summary><div class="long-q-body">${esc(q)}</div></details>`;
}
function renderChatLog(streamText) {
  const chat = state.session.chats.find((c) => c.id === state.chatId);
  const msgs = chat ? chat.messages.slice() : [];
  if (streamText !== undefined) {
    if (state.pendingQuestion && (!msgs.length || msgs.at(-1).role !== "user")) msgs.push({ role: "user", text: state.pendingQuestion });
    msgs.push({ role: "assistant", text: streamText || "Pensando…" });
  }
  const streaming = streamText !== undefined;
  const answers = msgs.filter((m) => m.role === "assistant").length;
  $("chat-log").innerHTML = msgs.length
    ? msgs
        .map((m, i) => {
          if (m.role !== "assistant") return `<div class="msg user">${userMsgHtml(m.text)}</div>`;
          const done = !streaming || i < msgs.length - 1;
          const acts = done
            ? `<div class="msg-acts"><button type="button" class="linkish" data-copy="a" data-i="${i}">${icon("copiar")}Copiar resposta</button>${msgs[i - 1]?.role === "user" ? `<button type="button" class="linkish" data-copy="qa" data-i="${i}">${icon("copiar")}Copiar com a pergunta</button>` : ""}</div>`
            : "";
          return `<div class="msg assistant"><div class="md">${withCites(mdToHtml(m.text))}</div>${acts}</div>`;
        })
        .join("") + (!streaming && answers > 1 ? `<div class="msg-acts all"><button type="button" class="linkish" data-copy="all">${icon("copiar")}Copiar a conversa inteira</button></div>` : "")
    : `<p class="muted tiny">Faça perguntas durante ou depois da reunião. As conversas ficam salvas junto com a transcrição.</p>`;
  $("chat-log").scrollTop = $("chat-log").scrollHeight;
}

// Copiar da conversa: formatado (Docs, Notion, e-mail) e texto puro juntos.
const stripPrev = (s) => String(s || "").replace(/<reuniao_anterior[^>]*>[\s\S]*?<\/reuniao_anterior>/g, "").trim();
async function copyRich(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}
const qaHtml = (q, a) => `<p><b>Pergunta:</b><br>${esc(q).replace(/\n/g, "<br>")}</p><p><b>Resposta:</b></p>${mdToHtml(a)}`;
const qaText = (q, a) => `Pergunta: ${q}\n\nResposta:\n${a}`;
$("chat-log").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const chat = state.session.chats.find((c) => c.id === state.chatId);
  if (!chat) return;
  const msgs = chat.messages;
  try {
    if (b.dataset.copy === "all") {
      const pairs = [];
      for (const m of msgs) {
        if (m.role === "user") pairs.push({ q: stripPrev(m.text), a: "" });
        else if (pairs.length) pairs.at(-1).a = m.text;
      }
      const ok = pairs.filter((p) => p.a);
      await copyRich(ok.map((p) => qaHtml(p.q, p.a)).join("<hr>"), ok.map((p) => qaText(p.q, p.a)).join("\n\n---\n\n"));
      return toast(`Conversa copiada (${ok.length} pergunta${ok.length === 1 ? "" : "s"})`);
    }
    const i = +b.dataset.i;
    const a = msgs[i]?.text || "";
    if (b.dataset.copy === "a") {
      await copyRich(mdToHtml(a), a);
      return toast("Resposta copiada");
    }
    const q = stripPrev(msgs[i - 1]?.text);
    await copyRich(qaHtml(q, a), qaText(q, a));
    toast("Pergunta e resposta copiadas");
  } catch (err) {
    toast("Não foi possível copiar: " + err.message);
  }
});

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
    (t) => ($("ata-body").innerHTML = withCites(mdToHtml(t))),
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
  toast(kind === "editor" ? "Ata copiada no formato do Editor. Cole no editor." : "Ata copiada");
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
  const kindIcon = { ai: "ia", edit: "editar", restore: "desfazer", sync: "sync" };
  $("versions-list").innerHTML = hist.slice().reverse().map((v) => {
    const prev = hist.find((x) => x.id === v.parentId);
    const st = prev ? diffStats(diffDocument(prev.text, v.text)) : null;
    const isCur = v.id === cur.id;
    const isViewing = state.viewing === v.id;
    const [what, detail] = v.label.split(" · ");
    return `<li class="ver ${isCur ? "current" : ""} ${isViewing ? "viewing" : ""}" data-v="${esc(v.id)}">
      <span class="vk ${esc(v.source || "ai")}" title="${esc(what)}">${icon(kindIcon[v.source] || "ia")}</span>
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

// Outras reuniões que a IA consulta junto com esta (seletor "Perguntar sobre").
function scopeIds() {
  const s = state.session;
  const scope = $("chat-scope").value;
  if (!s || scope === "this") return [];
  if (scope === "same") return previousWithSame(s).map((m) => m.id);
  return state.index.filter((m) => m.id !== s.id && (m.endedAt || m.updatedAt) <= (s.endedAt || Date.now())).slice(0, 5).map((m) => m.id);
}
function renderScope() {
  const s = state.session;
  const same = s ? previousWithSame(s).length : 0;
  const opt = $("chat-scope").querySelector('[value="same"]');
  opt.disabled = !same;
  opt.textContent = same ? `esta + ${same} anterior${same === 1 ? "" : "es"} com estes participantes` : "esta + anteriores com estes participantes (nenhuma)";
  if (opt.disabled && $("chat-scope").value === "same") $("chat-scope").value = "this";
}

async function ask(question, previousId) {
  question = (question || "").trim();
  if (!question || !state.session || state.busy) return;
  if (!(await ensureApiPermission())) return toast("Permissão para a API negada");
  state.busy = "chat";
  state.pendingQuestion = question;
  $("chat-input").value = "";
  if (document.activeElement === $("chat-input")) paintCount($("chat-input"));
  renderChatLog("");
  runAI(
    { action: "chat", id: state.session.id, chatId: state.chatId, question, previousId, previousIds: scopeIds() },
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
  if (b.hasAttribute("data-open-models")) {
    $("q-manage").open = true;
    return $("q-manage").scrollIntoView({ block: "start", behavior: "smooth" });
  }
  if (b.dataset.prev) ask("Resuma a reunião anterior com estes participantes e diga o que ficou pendente dela que pode ser retomado agora.", b.dataset.prev);
  else ask(b.dataset.q);
});

// ----- Análise -----
// ---------------- Player do áudio guardado ----------------
// As faixas (aba/computador e microfone) tocam juntas; a primeira é o relógio. O horário do áudio é
// s.audio.startedAt (instante em que a gravação começou), então um horário absoluto da reunião vira
// posição no áudio subtraindo isso.
function hasAudio(s) {
  return !!(s && s.audio && s.audio.tracks && s.audio.tracks.length && (s.endedAt || s.audio.done));
}
function fmtBytes(b) {
  return b >= 1024 * 1024 * 1024 ? (b / 1024 / 1024 / 1024).toFixed(2) + " GB" : b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
}
const TRACK_NAMES = { tab: "os outros", system: "o computador", mic: "seu microfone", import: "gravação importada" };
function setPlayIcon(playing) {
  const b = $("p-play");
  b.innerHTML = icon(playing ? "pausar" : "tocar");
  b.dataset.playing = playing ? "1" : "";
  b.title = playing ? "Pausar (espaço)" : "Ouvir (espaço)";
  b.setAttribute("aria-label", playing ? "Pausar" : "Ouvir");
}
async function unloadPlayer() {
  const p = state.player;
  if (!p) return;
  for (const a of p.audios) { try { a.pause(); } catch {} URL.revokeObjectURL(a.src); }
  state.player = null;
  setPlayIcon(false);
  for (const el of document.querySelectorAll(".playing")) el.classList.remove("playing");
}
async function loadPlayer(s) {
  if (state.player && state.player.id === s.id) return state.player;
  await unloadPlayer();
  const audios = [];
  for (const source of s.audio.tracks) {
    const f = await readTrack(s.id, source);
    if (!f || !f.size) continue;
    const a = new Audio(URL.createObjectURL(f));
    a.preload = "auto";
    audios.push(a);
  }
  if (!audios.length) throw new Error("O áudio desta reunião não está mais neste computador.");
  const p = { id: s.id, audios, master: audios[0], startedAt: s.audio.startedAt, duration: 0 };
  // WebM gravado em pedaços nem sempre traz a duração: usa a registrada ao parar.
  p.duration = (s.audio.durationMs || 0) / 1000;
  p.master.addEventListener("loadedmetadata", () => { if (isFinite(p.master.duration)) p.duration = p.master.duration; renderPlayhead(); });
  p.master.addEventListener("timeupdate", renderPlayhead);
  p.master.addEventListener("ended", () => setPlayIcon(false));
  p.master.addEventListener("play", () => { setPlayIcon(true); for (const a of audios) if (a !== p.master) a.play().catch(() => {}); renderPlayhead(); });
  p.master.addEventListener("seeked", renderPlayhead);
  p.master.addEventListener("pause", () => { setPlayIcon(false); for (const a of audios) if (a !== p.master) a.pause(); });
  state.player = p;
  return p;
}
function renderPlayer(s) {
  const show = hasAudio(s);
  $("player").hidden = !show;
  if (!show) { if (state.player) unloadPlayer(); return; }
  const dur = s.audio.durationMs ? fmtDuration(s.audio.durationMs) : "";
  $("p-dur").textContent = state.player && state.player.duration ? clock(state.player.duration * 1000) : s.audio.durationMs ? clock(s.audio.durationMs) : "--:--";
  $("p-info").textContent = `${s.audio.tracks.map((t) => TRACK_NAMES[t] || t).join(" + ")}${s.audio.bytes ? " · " + fmtBytes(s.audio.bytes) : ""}${dur ? "" : ""}`;
  $("p-keep").innerHTML = icon("manter");
  $("p-keep").classList.toggle("on", !!s.audio.keep);
  $("p-keep").title = s.audio.keep ? "Este áudio está marcado para manter: a limpeza automática não o apaga. Clique para desmarcar." : "Manter este áudio fora da limpeza automática";
  if (state.player && state.player.id !== s.id) unloadPlayer();
}
function renderPlayhead() {
  const p = state.player;
  const s = state.session;
  if (!p || !s || p.id !== s.id) return;
  const t = p.master.currentTime;
  $("p-time").textContent = clock(t * 1000);
  if (p.duration) { $("p-dur").textContent = clock(p.duration * 1000); if (document.activeElement !== $("p-seek")) $("p-seek").value = Math.round((t / p.duration) * 1000); }
  if (p.master.paused) return;
  const now = p.startedAt + t * 1000;
  let cur = null;
  for (const li of $("timeline").querySelectorAll("li.blk[data-start]")) {
    if (Number(li.dataset.start) <= now + 400) cur = li; else break;
  }
  for (const el of $("timeline").querySelectorAll(".playing")) if (el !== cur) el.classList.remove("playing");
  if (!cur) return;
  if (!cur.classList.contains("playing")) { cur.classList.add("playing"); cur.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  let para = null;
  for (const pEl of cur.querySelectorAll("p:not(.orig)")) {
    const tm = pEl.querySelector("time.pt");
    if (!tm || Number(tm.dataset.at) <= now + 400) para = pEl;
  }
  for (const pEl of cur.querySelectorAll("p.playing")) if (pEl !== para) pEl.classList.remove("playing");
  if (para) para.classList.add("playing");
}
async function playAt(absMs) {
  const s = state.session;
  if (!s || !hasAudio(s)) return;
  try {
    const p = await loadPlayer(s);
    const rel = Math.max(0, (absMs - p.startedAt) / 1000);
    for (const a of p.audios) a.currentTime = rel;
    await p.master.play();
  } catch (err) {
    toast(err.message || String(err));
  }
}
$("p-play").addEventListener("click", async () => {
  const s = state.session;
  if (!s || !hasAudio(s)) return;
  try {
    const p = await loadPlayer(s);
    if (p.master.paused) await p.master.play(); else p.master.pause();
  } catch (err) { toast(err.message || String(err)); }
});
$("p-seek").addEventListener("input", async () => {
  const s = state.session;
  if (!s || !hasAudio(s)) return;
  const p = await loadPlayer(s).catch(() => null);
  if (!p || !p.duration) return;
  const t = (Number($("p-seek").value) / 1000) * p.duration;
  for (const a of p.audios) a.currentTime = t;
  $("p-time").textContent = clock(t * 1000);
});
$("p-del").addEventListener("click", async () => {
  const s = state.session;
  if (!s || !s.audio) return;
  if (!confirm("Apagar o áudio desta reunião? A transcrição continua; só o som é removido deste computador.")) return;
  await unloadPlayer();
  state.session = normalize(await send({ type: "audio-delete", id: s.id }));
  toast("Áudio apagado");
  renderMeeting();
});
// Escolha do modelo para transcrever de novo / arquivo importado; depois, o service worker faz o resto.
async function startRetranscribe(anchor, s) {
  if (!s || !s.audio || !s.audio.tracks?.length) return;
  const cur = state.settings.hq !== "off" ? state.settings.hq : "base";
  const choices = Object.entries(HQ_MODELS).map(([key, m]) => ({ key, label: `${m.label || key}${key === cur ? " (atual)" : ""}`, primary: key === cur }));
  choices.push({ key: "cancel", label: "Cancelar" });
  const key = await askChoice(anchor, { title: "Transcrever com qual modelo?", text: "Roda neste computador. O modelo é baixado na primeira vez. A transcrição atual pelo áudio é substituída; legendas, notas e destaques ficam.", choices });
  if (!key || key === "cancel") return;
  state.retrans = { id: s.id, status: { state: "starting", progress: 0 } };
  renderBanner();
  try {
    const done = await send({ type: "retranscribe", id: s.id, modelKey: key, lang: state.settings.captionLang });
    if (state.session && state.session.id === s.id && done) state.session = normalize(done);
    toast("Transcrição concluída");
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    if (state.retrans && state.retrans.id === s.id) state.retrans = null;
    renderMeeting();
  }
}
$("p-retrans").addEventListener("click", (e) => startRetranscribe(e.currentTarget, state.session));

$("import-audio").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 1024 * 1024 * 1024) return toast("Arquivo grande demais (máximo 1 GB).");
  try {
    const title = file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Arquivo importado";
    const rec = normalize(await send({ type: "import-create", title, name: file.name, bytes: file.size, startedAt: file.lastModified || Date.now() }));
    const bytes = await writeTrackFile(rec.id, "import", file);
    await send({ type: "audio-meta", sessionId: rec.id, meta: { startedAt: rec.startedAt, tracks: ["import"], mime: file.type || "", bytes, done: true, keep: false, imported: file.name } });
    state.view = "meeting";
    state.tab = "transcript";
    await openSession(rec.id, true);
    renderList();
    await startRetranscribe($("p-retrans"), state.session);
  } catch (err) {
    toast("Não deu para importar: " + (err.message || err));
  }
});

$("p-keep").addEventListener("click", async () => {
  const s = state.session;
  if (!s || !s.audio) return;
  state.session = normalize(await send({ type: "audio-keep-toggle", id: s.id }));
  toast(state.session.audio?.keep ? "Áudio marcado para manter" : "Áudio volta a entrar na limpeza automática");
  renderPlayer(state.session);
});
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.target.closest("input, textarea, [contenteditable]") || !state.session || !hasAudio(state.session) || $("player").hidden || state.view !== "meeting") return;
  if (!state.player) return; // só controla um áudio já aberto (clicou num horário ou em ▶)
  e.preventDefault();
  $("p-play").click();
});

// ---------------- Diagnóstico (relatório de sessão) ----------------
const EVENT_LABELS = {
  start: "Reunião detectada",
  "first-caption": "Primeira legenda",
  "captions-stuck": "Legendas não ligaram",
  "hq-start": "Alta precisão ligada",
  "hq-stop": "Alta precisão desligada",
  "capture-started": "Captura de áudio iniciada",
  "capture-stopped": "Captura de áudio encerrada",
  "source-added": "Fonte de áudio ligada",
  "source-replaced": "Fonte de áudio trocada",
  "mic-denied": "Microfone negado",
  "mic-ended": "Microfone desconectado",
  "mic-reacquired": "Microfone reconectado",
  "mic-lost": "Microfone perdido",
  "engine-loaded": "Modelo carregado",
  "engine-fallback": "Placa de vídeo falhou; passou ao processador",
  "speakers-loaded": "Modelos de voz carregados",
  "speakers-error": "Modelos de voz falharam",
  "transcribe-error": "Erro ao transcrever",
  pause: "Pausado",
  resume: "Retomado",
  "resume-after-end": "Transcrição retomada",
  end: "Encerrada",
};
const END_REASONS = {
  "leave-button": "botão Sair da chamada",
  "connections-closed": "conexões da chamada fechadas",
  "rejoin-screen": "tela de pós-chamada",
  "call-ui-gone": "interface da chamada sumiu",
  "tab-closed": "aba fechada ou recarregada",
  "tab-removed": "aba fechada",
  "stop-widget": "botão Parar do widget",
  "stop-panel": "botão Parar do painel",
  "recorder-stop": "gravador parado",
  "meeting-left": "saída da reunião",
};
function detailText(kind, d) {
  if (!d) return "";
  if (kind === "end") return [END_REASONS[d.reason] || d.reason, d.entries != null ? `${d.entries} legendas` : "", d.asr != null && d.asr ? `${d.asr} trechos do Whisper` : ""].filter(Boolean).join(" · ");
  if (kind === "engine-loaded") return `${d.model} · ${d.device === "webgpu" ? "placa de vídeo" : "processador"} · ${((d.loadMs || 0) / 1000).toFixed(1)} s`;
  if (kind === "capture-stopped") return `${d.segments || 0} trechos · ${Math.round((d.audioMs || 0) / 1000)} s de fala · ${d.rtf != null ? d.rtf + "x o tempo real" : ""}${d.coalesced ? ` · ${d.coalesced} juntados por atraso` : ""}`;
  if (kind === "capture-started") return `${(d.sources || []).map((x) => ({ tab: "aba", mic: "microfone", system: "computador" })[x] || x).join(" + ")} · ${d.model || ""}${d.diarize ? " · falantes pela voz" : ""}`;
  if (kind === "hq-start") return `${d.model}${d.mic ? " · com microfone" : ""}${d.diarize ? " · falantes pela voz" : ""}`;
  if (kind === "first-caption") return `${((d.afterMs || 0) / 1000).toFixed(0)} s depois do início · ${d.source === "dom" ? "pela tela" : "pelo canal de dados"}`;
  if (kind === "start") return `${PLATFORM[d.platform] || d.platform} · Escribanote ${d.version || ""}`;
  if (kind === "captions-stuck") return d.captionsOn === "unavailable" ? "o Meet avisou que a legenda está indisponível" : "o botão de legendas não respondeu";
  return Object.entries(d).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}
function renderDiag() {
  const s = state.session;
  const events = (s.report && s.report.events) || [];
  const rows = events
    .map((e) => `<tr><td class="t">${clock(Math.max(0, e.at - s.startedAt))}</td><td>${esc(EVENT_LABELS[e.kind] || e.kind)}</td><td class="muted">${esc(detailText(e.kind, e.detail))}</td></tr>`)
    .join("");
  $("pane-diag").innerHTML = `
    <p class="muted tiny">Registro do que aconteceu nesta reunião: dispositivos, modelo, pausas e encerramento. Não guarda o que foi dito. Útil para entender por que algo não foi captado.</p>
    ${events.length ? `<table class="diag"><tbody>${rows}</tbody></table>` : `<div class="list-empty">Nenhum evento registrado nesta reunião.</div>`}
    <div class="row" style="margin-top:10px"><button type="button" class="btn sm" id="diag-copy">Copiar diagnóstico</button></div>`;
  $("diag-copy").addEventListener("click", async () => {
    const payload = { app: "escribanote", version: chrome.runtime.getManifest().version, id: s.id, title: s.title, platform: s.platform, startedAt: s.startedAt, endedAt: s.endedAt, entries: s.entries.length, asr: s.asr.length, report: s.report };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast("Diagnóstico copiado");
  });
}

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
    ${foldCard("share", "Quem falou e quanto", rows)}
    ${foldCard("timeline", "Linha do tempo: quem falou quando", `<svg class="tl-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Linha do tempo de falas">${rects}${axis}</svg>
      <div class="row tiny" style="margin-top:6px">${top.map((p) => `<span class="row" style="gap:4px"><i style="width:10px;height:10px;border-radius:3px;background:${colorFor(p.name)};display:inline-block"></i>${esc(p.name)}</span>`).join("")}</div>`)}
    ${prev.length ? foldCard("previous", "Reuniões anteriores com estes participantes", prev.map(cardHtml).join("")) : ""}`;
}
// Painéis recolhíveis da Análise: o que fica aberto ou fechado é lembrado neste navegador.
function foldState() {
  try { return JSON.parse(localStorage.getItem("escribanote:folds") || "{}"); } catch { return {}; }
}
function foldCard(key, title, body) {
  const closed = foldState()[key] === false;
  return `<details class="card fold" data-fold="${key}"${closed ? "" : " open"}><summary><h3>${esc(title)}</h3></summary><div class="fold-body">${body}</div></details>`;
}
$("pane-stats").addEventListener("toggle", (e) => {
  const d = e.target.closest?.("[data-fold]");
  if (!d) return;
  const st = foldState();
  st[d.dataset.fold] = d.open;
  try { localStorage.setItem("escribanote:folds", JSON.stringify(st)); } catch {}
}, true);
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
  return `<div class="mcard${sel}" role="button" tabindex="0" data-open="${esc(m.id)}">
    <div class="mcard-top"><b>${live ? `<span class="live-dot" title="Gravando">${icon("gravando")}</span>` : ""}<span class="mcard-name">${esc(m.title)}</span></b>
      <button type="button" class="mcard-rename" data-rename="${esc(m.id)}" title="Renomear" aria-label="Renomear ${esc(m.title)}">${icon("editar")}</button></div>
    <div class="sub"><span>${new Date(m.startedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
      <span>${esc(PLATFORM[m.platform] || m.platform)}</span>
      ${m.endedAt ? `<span>${fmtDuration(m.endedAt - m.startedAt)}</span>` : ""}
      <span class="avatars">${names.slice(0, 4).map((n) => avatar(n, n)).join("")}</span>
      ${m.part > 1 ? `<span class="badge" title="Mesmo link de reunião, retomado no mesmo dia">parte ${m.part}</span>` : ""}
      ${m.hasSummary ? '<span class="badge ok">ata</span>' : ""}${m.highlights ? `<span class="badge" title="Destaques">${icon("importante")}${m.highlights}</span>` : ""}</div>
    ${snippet ? `<div class="snippet">${highlight(snippet, state.listQuery.trim())}</div>` : ""}
  </div>`;
}

function openFromCard(e) {
  if (e.target.closest("[data-rename]")) return startRename(e.target.closest("[data-rename]").dataset.rename);
  if (e.target.closest(".mcard-edit")) return; // digitando o novo nome
  const c = e.target.closest("[data-open]");
  if (!c) return;
  state.view = "meeting";
  state.tab = "transcript";
  openSession(c.dataset.open, true);
}
// Os cartões são <div role=button> (um botão não pode conter o botão de renomear): Enter/espaço abrem; F2 renomeia.
function cardKeys(e) {
  const c = e.target.closest("[data-open]");
  if (!c || e.target !== c) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); }
  if (e.key === "F2") { e.preventDefault(); startRename(c.dataset.open); }
}

// Renomeia a reunião no próprio cartão (lista e "recentes"): Enter salva, Esc cancela, sair do campo salva.
function renaming() {
  return document.activeElement && document.activeElement.classList.contains("mcard-edit");
}
function startRename(id) {
  const card = document.querySelector(`[data-open="${CSS.escape(id)}"]`);
  const name = card && card.querySelector(".mcard-name");
  if (!name || card.querySelector(".mcard-edit")) return;
  const old = name.textContent;
  const input = document.createElement("input");
  input.className = "mcard-edit";
  input.maxLength = 200;
  input.value = old;
  input.setAttribute("aria-label", "Novo nome da reunião");
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.replaceWith(name); // devolve o nome ao cartão (as listas só redesenham sem campo em edição)
    if (save && value && value !== old) {
      try {
        const s = await send({ type: "update", id, title: value });
        if (state.session && state.session.id === id && s) { state.session = normalize(s); renderMeeting(); }
        toast("Reunião renomeada");
      } catch (err) { toast(err.message); }
    }
    renderList();
    renderRecent();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}
$("list").addEventListener("click", openFromCard);
$("list").addEventListener("keydown", cardKeys);
$("recent").addEventListener("keydown", cardKeys);
for (const b of document.querySelectorAll("[data-recorder]")) b.addEventListener("click", () => send({ type: "open-recorder" }).catch((e) => toast(e.message)));
$("recent").addEventListener("click", openFromCard);

async function renderList() {
  state.index = await send({ type: "list" });
  if (renaming()) return;
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
  `<option value="auto">Automático: escolhe pelo computador e economiza na bateria fraca</option>` +
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
  form.elements.voiceProfiles.disabled = !pro;
  $("vp-row").classList.toggle("muted", !pro);
  renderVoiceProfiles();
  if (document.activeElement !== $("wh-url")) $("wh-url").value = s.webhookUrl || "";
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
  renderAudioUsage();
}
// Webhook: salvar pede a permissão de acesso só àquele site (gesto do usuário).
$("wh-save").addEventListener("click", async () => {
  const raw = $("wh-url").value.trim();
  if (!raw) {
    state.settings = await setSettings({ webhookUrl: "", webhookOn: false });
    $("wh-status").textContent = "Webhook removido.";
    return renderSettings();
  }
  let u;
  try { u = new URL(raw); } catch { return ($("wh-status").textContent = "Endereço inválido."); }
  if (u.protocol !== "https:" && u.hostname !== "localhost") return ($("wh-status").textContent = "Use um endereço https://.");
  if (!(await chrome.permissions.request({ origins: [u.origin + "/*"] }))) return ($("wh-status").textContent = "Permissão negada.");
  state.settings = await setSettings({ webhookUrl: u.href });
  $("wh-status").textContent = `Salvo. As reuniões vão para ${u.host}${state.settings.webhookOn ? " ao terminar" : " quando você ligar o envio automático ou pedir um teste"}.`;
});
$("wh-test").addEventListener("click", async () => {
  $("wh-status").textContent = "Enviando…";
  try {
    const r = await send({ type: "webhook-test", id: state.session?.id });
    $("wh-status").textContent = r?.ok ? `Teste enviado (resposta ${r.status}).` : r?.error || "Configure e salve o endereço primeiro.";
  } catch (err) {
    $("wh-status").textContent = "Falhou: " + (err.message || err);
  }
});

// Perfis de voz salvos neste computador: lista com apagar por pessoa e apagar todos.
async function renderVoiceProfiles() {
  const { voiceProfiles: list = [] } = await chrome.storage.local.get("voiceProfiles");
  $("vp-list").innerHTML = list.length
    ? `<div class="vp-head"><b class="tiny">${list.length} voz${list.length === 1 ? "" : "es"} guardada${list.length === 1 ? "" : "s"}</b><button type="button" class="linkish tiny" data-vp-all>Apagar todas</button></div>` +
      list.map((p, i) => `<span class="vp">${esc(p.name)}<small>${p.meetings || 1} reuniã${(p.meetings || 1) === 1 ? "o" : "es"}</small><button type="button" class="x" data-vp-rm="${i}" title="Apagar a voz de ${esc(p.name)}" aria-label="Apagar a voz de ${esc(p.name)}">${icon("fechar")}</button></span>`).join("")
    : "";
}
$("vp-list").addEventListener("click", async (e) => {
  const { voiceProfiles: list = [] } = await chrome.storage.local.get("voiceProfiles");
  if (e.target.closest("[data-vp-all]")) {
    if (!confirm("Apagar todas as vozes guardadas neste computador?")) return;
    await chrome.storage.local.remove("voiceProfiles");
    toast("Vozes apagadas");
  } else {
    const rm = e.target.closest("[data-vp-rm]");
    if (!rm) return;
    const p = list[+rm.dataset.vpRm];
    await chrome.storage.local.set({ voiceProfiles: list.filter((_, i) => i !== +rm.dataset.vpRm) });
    toast(`Voz de ${p?.name || "participante"} apagada`);
  }
  renderVoiceProfiles();
});

async function renderAudioUsage() {
  const u = await send({ type: "audio-usage" }).catch(() => null);
  if (!u) return;
  $("audio-usage").textContent = u.count
    ? `${u.count} reunião${u.count === 1 ? "" : "ões"} com áudio · ${fmtBytes(u.bytes)} de ${fmtBytes(u.limitBytes)}${u.retentionDays ? ` · apagadas após ${u.retentionDays} dias` : ""}.`
    : "Nenhum áudio guardado neste computador.";
  $("audio-wipe").hidden = !u.count;
}
$("audio-wipe").addEventListener("click", async () => {
  if (!confirm("Apagar todo o áudio guardado? As transcrições continuam; só o som é removido deste computador.")) return;
  await unloadPlayer();
  await send({ type: "audio-wipe" });
  if (state.session?.audio) state.session = normalize(await send({ type: "get", id: state.session.id }));
  toast("Áudio apagado");
  renderAudioUsage();
});

$("settings").addEventListener("change", async (e) => {
  const el = e.target;
  if (!el.name || el.name === "apiKey" || el.closest(".tag-editor")) return;
  if (el.name === "audioKeep" && el.checked && !confirm("O som das próximas reuniões com captura de áudio (alta precisão ou gravador) será guardado neste computador, em duas faixas: a dos outros participantes e a do seu microfone. Nada sai do computador e você pode apagar por reunião. Avise os participantes quando for o caso. Ligar?")) {
    el.checked = false;
    return;
  }
  if (el.name === "voiceProfiles" && el.checked && !confirm("Guardar a impressão de voz das pessoas com nome nas próximas reuniões, só neste computador? É um dado biométrico: avise os participantes. Dá para apagar cada voz aqui em Ajustes.")) {
    el.checked = false;
    return;
  }
  const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  state.settings = await setSettings({ [el.name]: v });
  if (el.name === "usage") applyUsage();
  toast("Ajuste salvo");
});
// Avançadas recolhidas por padrão; o navegador lembra se ficaram abertas.
try { $("adv-settings").open = localStorage.getItem("escribanote:adv") === "1"; } catch {}
$("adv-settings").addEventListener("toggle", () => {
  try { localStorage.setItem("escribanote:adv", $("adv-settings").open ? "1" : "0"); } catch {}
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
// Glossário pronto para salas de mercado: acrescenta só os termos que faltam.
const MARKET_TERMS = ["WIN", "WDO", "IBOV", "Ibovespa", "BOVA11", "EWZ", "S&P 500", "Nasdaq", "VIX", "DI", "Treasuries", "VWAP", "Max Pain", "Fibonacci", "pullback", "breakout", "stop loss", "stop gain", "gatilho", "saldo de agressão", "book de ofertas", "times and trades", "ajuste", "gap", "Payroll", "CPI", "PCE", "IPCA", "Copom", "FOMC", "Fed", "PETR4", "VALE3", "ITUB4", "BBDC4", "call", "put", "strike", "vencimento", "travas", "gamma", "open interest", "hedge", "rolagem", "day trade", "swing trade", "scalping"];
$("gloss-market").addEventListener("click", async () => {
  const field = document.querySelector('#settings [name="glossary"]');
  const have = new Set(field.value.split("\n").map((l) => l.split("=")[0].trim().toLowerCase()).filter(Boolean));
  const add = MARKET_TERMS.filter((t) => !have.has(t.toLowerCase()));
  if (!add.length) return toast("Os termos do mercado já estão no vocabulário");
  field.value = (field.value.trimEnd() ? field.value.trimEnd() + "\n" : "") + add.join("\n");
  state.settings = await setSettings({ glossary: field.value });
  toast(`${add.length} termos do mercado financeiro adicionados`);
});
$("edit-shortcuts").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

function renderTagEditor() {
  $("tag-editor").innerHTML = tags()
    .map((t, i) => `<div class="tag-row" data-i="${i}"><div class="menu-wrap"><button type="button" class="tag-ic" data-pick="${i}" style="color:${esc(t.color)}" title="Escolher o ícone" aria-label="Ícone da tag ${esc(t.label)}" aria-expanded="false">${icon(tagIcon(t))}</button>
      <div class="menu ic-grid" hidden>${TAG_ICONS.map(([n]) => `<button type="button" data-ic-pick="${n}" aria-pressed="${tagIcon(t) === n}" title="${n}" style="color:${esc(t.color)}">${icon(n)}</button>`).join("")}</div></div>
      <input value="${esc(t.label)}" data-k="label" data-count="focus" maxlength="30" aria-label="Nome"><input type="color" value="${esc(t.color)}" data-k="color" aria-label="Cor">
      <button type="button" class="x" data-rm="${i}" title="Remover" aria-label="Remover">${icon("fechar")}</button></div>`)
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
  // Paleta de ícones: o emoji equivalente vai junto, para as exportações em texto.
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    const grid = pick.nextElementSibling;
    for (const g of $("tag-editor").querySelectorAll(".ic-grid")) if (g !== grid) g.hidden = true;
    grid.hidden = !grid.hidden;
    pick.setAttribute("aria-expanded", String(!grid.hidden));
    return;
  }
  const chosen = e.target.closest("[data-ic-pick]");
  if (chosen) {
    const i = Number(chosen.closest(".tag-row").dataset.i);
    const list = tags().map((t) => ({ ...t }));
    const [name, emoji] = TAG_ICONS.find(([n]) => n === chosen.dataset.icPick);
    Object.assign(list[i], { icon: name, emoji });
    return saveTags(list);
  }
  const rm = e.target.closest("[data-rm]");
  if (!rm) return;
  const list = tags().filter((_, i) => i !== Number(rm.dataset.rm));
  if (!list.length) return toast("Mantenha pelo menos uma tag");
  saveTags(list);
});
document.addEventListener("click", (e) => {
  if (e.target.closest(".tag-row .menu-wrap")) return;
  for (const g of document.querySelectorAll("#tag-editor .ic-grid")) g.hidden = true;
});
$("tag-add").addEventListener("click", () => saveTags([...tags(), { id: "t" + Date.now().toString(36), label: "Nova tag", emoji: "🏷", icon: "tag", color: "#64748b" }]));
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

// ----- Uso pessoal x institucional -----
// Pessoal: some o que é de órgão público (ata institucional nas exportações, cópia/HTML para o Editor).
function institutional() {
  return state.settings.usage === "institutional";
}
function applyUsage() {
  document.body.classList.toggle("usage-personal", !institutional());
}

// ----- Primeira execução -----
let wStep = 1;
function showWelcomeStep(n) {
  wStep = n;
  for (const s of document.querySelectorAll(".w-step")) s.hidden = Number(s.dataset.step) !== n;
  [...$("w-steps").children].forEach((li, i) => { li.classList.toggle("on", i + 1 === n); li.classList.toggle("done", i + 1 < n); });
  $("w-back").hidden = n === 1;
  $("w-next").textContent = n === W_STEPS ? "Concluir" : "Continuar";
}
const W_STEPS = 4;
async function openWelcome() {
  const f = $("welcome-form");
  f.elements["w-usage"].value = state.settings.usage === "institutional" ? "institutional" : "personal";
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
    const patch = { usage: f.elements["w-usage"].value, backupAuto: f.elements["w-backup"].value, mode: f.elements["w-mode"].value, afterCall: f.elements["w-after"].value };
    state.settings = await setSettings(patch);
    applyUsage();
    const ai = f.elements["w-ai"].value;
    const key = $("w-key").value.trim();
    if (ai === "key" && key) {
      if (await chrome.permissions.request({ origins: [API_ORIGIN] })) await chrome.storage.local.set({ apiKey: key });
      else toast("Permissão para a API negada. Dá para cadastrar a chave em Ajustes.");
    }
    if (ai === "pro") openAccountWeb("#/conectar");
    send({ type: "auto-backup-flush", all: true }).catch(() => {});
  }
  if (!state.settings.usage) { state.settings = await setSettings({ usage: "personal" }); applyUsage(); }
  await chrome.storage.local.set({ welcomeDone: Date.now() });
  $("welcome").close();
  if (state.view === "settings") render();
  if (!skipped) toast("Pronto! Dá para rever tudo em Ajustes.");
}
$("w-next").addEventListener("click", () => (wStep < W_STEPS ? showWelcomeStep(wStep + 1) : finishWelcome(false)));
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
  if (msg.type === "retranscribe-progress") {
    if (state.retrans && state.retrans.id === msg.sessionId) { state.retrans.status = msg.status || {}; if (state.session && state.session.id === msg.sessionId) renderBanner(); }
    return;
  }
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
  // Quem já usava antes da pergunta de uso: quem já tinha a ata nas exportações ou modelos de ata segue
  // vendo as funções institucionais; os demais ficam com o painel pessoal (dá para trocar em Ajustes).
  const { welcomeDone: had, ataTemplates } = await chrome.storage.local.get(["welcomeDone", "ataTemplates"]);
  if (had && !state.settings.usage) {
    const inst = state.settings.exportAta === true || (Array.isArray(ataTemplates) && ataTemplates.length > 0);
    state.settings = await setSettings({ usage: inst ? "institutional" : "personal" });
  }
  applyUsage();
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
