// Escribanote — área logada. Rotas pelo fragmento (#/…); dados pela API; transcrição, ata, exportações
// e análise com as mesmas bibliotecas da extensão (copiadas para ./lib na publicação).
import { api, ApiError, stream } from "./api.js";
import { QUICK_PROMPTS } from "./lib/ai.js";
import { clock, FORMATS, fileName, mdToHtml, PLATFORM, toHtml } from "./lib/format.js";
import { DEFAULT_TAGS } from "./lib/settings.js";
import { computeStats, fmtDuration } from "./lib/stats.js";
import { normalize, toBlocks } from "./lib/transcript.js";

const EXTENSION_ID = "ohbnmfogdcbgegnpcaphidkjinplednd";
const PALETTE = ["#c2410c", "#0f766e", "#7c3aed", "#b45309", "#be185d", "#1d4ed8", "#4d7c0f", "#9f1239"];
const $ = (id) => document.getElementById(id);
const view = $("view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fold = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const state = {
  me: null,
  list: [],
  listLoaded: false,
  filter: "all",
  query: "",
  results: null, // resultados da busca global
  meeting: null, // { id, doc, version }
  tab: "ata",
  inMeetingQuery: "",
  drawer: null, // share | export | delete
  shares: [],
  qa: new Map(), // meetingId -> [{q, a}]
  askAll: [],
  busy: false,
};

// ---------------- utilidades ----------------
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("on"), 3200);
}
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = (n) => {
  const p = String(n).split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
};
const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === y.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
};
const timeLabel = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");
const isPro = () => state.me?.plan === "pro";
// Marca os termos da busca sem depender de acento ("orcamento" marca "orçamento").
function markWords(text, words) {
  const chars = [...text];
  const folded = chars.map((c) => fold(c) || c).join("");
  const marks = new Array(chars.length).fill(false);
  for (const w of words) {
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + 1)) for (let k = i; k < i + w.length; k++) marks[k] = true;
  }
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    if (marks[i] && !marks[i - 1]) out += "<mark>";
    out += esc(chars[i]);
    if (marks[i] && !marks[i + 1]) out += "</mark>";
  }
  return out;
}
function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    state.me = null;
    sessionStorage.setItem("after", location.hash || "#/");
    location.hash = "#/entrar";
    return;
  }
  if (err instanceof ApiError && err.body?.balance != null) setCredits(err.body.balance);
  toast(err.message || "Algo deu errado.");
}
function setCredits(balance) {
  if (!state.me) return;
  state.me.credits.balance = balance;
  renderCredits();
}
function renderCredits() {
  const el = $("credits");
  const c = state.me?.credits;
  el.hidden = !isPro();
  if (!c) return;
  el.textContent = `${c.balance} ${c.balance === 1 ? "crédito" : "créditos"}`;
  el.classList.toggle("low", c.balance <= 2);
  el.title = c.renewsAt ? `Créditos de IA · +${c.perCycle} em ${dateShort(c.renewsAt)} (máximo ${c.max})` : "Créditos de IA";
}
function setNav(key) {
  for (const a of document.querySelectorAll(".nav a")) a.setAttribute("aria-current", a.dataset.nav === key ? "page" : "false");
}

// ---------------- rotas ----------------
function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { parts, params: new URLSearchParams(query || "") };
}

// Plano escolhido na página /pro/ (#/conta?plano=anual&moeda=brl). Fica no localStorage porque o link
// de login abre em outra aba, onde o sessionStorage não existe.
const PLAN_KEY = "escribanote:plano";
function rememberPlan(params) {
  const plano = params.get("plano"), moeda = params.get("moeda");
  if (!plano && !moeda) return;
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify({ interval: plano === "mensal" ? "month" : "year", currency: moeda === "usd" ? "usd" : "brl" }));
  } catch {}
}
function pendingPlan() {
  try {
    return JSON.parse(localStorage.getItem(PLAN_KEY) || "null");
  } catch {
    return null;
  }
}

async function route() {
  const { parts, params } = parseRoute();
  const [head, arg] = parts;
  if (head === "conta") rememberPlan(params);
  if (head === "entrar") return renderLogin(arg);
  if (!state.me) {
    try {
      state.me = await api.get("/me");
      renderCredits();
    } catch (err) {
      if (err.status === 401) {
        sessionStorage.setItem("after", location.hash || "#/");
        return renderLogin();
      }
      return renderFatal(err);
    }
  }
  if (head === "conta") return renderAccount(params);
  if (head === "conectar") return renderConnect();
  if (head === "perguntar") return renderAskAll();
  return renderLibrary(head === "r" ? decodeURIComponent(arg || "") : null, params);
}
window.addEventListener("hashchange", route);

function renderFatal(err) {
  setNav("");
  view.innerHTML = `<section class="page"><h1>Não foi possível abrir o Escribanote</h1><p class="lead">${esc(err.message)}</p>
    <p><button class="btn dark" data-act="reload">Tentar de novo</button></p></section>`;
}

// ---------------- entrar ----------------
async function renderLogin(token) {
  setNav("");
  $("credits").hidden = true;
  if (token) {
    view.innerHTML = `<section class="page"><h1>Entrando…</h1></section>`;
    try {
      state.me = await api.post("/auth/verify", { token });
      renderCredits();
      const after = sessionStorage.getItem("after");
      sessionStorage.removeItem("after");
      const fallback = pendingPlan() && state.me.plan !== "pro" ? "#/conta" : "#/";
      history.replaceState(null, "", after && !after.startsWith("#/entrar") && after !== "#/" ? after : fallback);
      return route();
    } catch (err) {
      view.innerHTML = `<section class="page"><h1>Este link não vale mais</h1>
        <p class="lead">${esc(err.message)}</p><p><a class="btn dark" href="#/entrar">Pedir um novo link</a></p></section>`;
      return;
    }
  }
  view.innerHTML = `<section class="page">
    <h1>Entre no <em>Escribanote</em></h1>
    <p class="lead">Suas reuniões, atas e a IA inclusa do Escribanote Pro, em qualquer computador. Digite seu e-mail: enviamos um link de acesso, sem senha.</p>
    <form class="login-box" id="login-form" novalidate>
      <label class="field">E-mail<input type="email" id="login-email" autocomplete="email" required placeholder="voce@empresa.com"></label>
      <div class="row"><button class="btn primary" type="submit">Enviar link de acesso</button></div>
      <p class="err" id="login-err" role="alert"></p>
    </form>
    <div class="sent" id="login-sent" hidden></div>
    <p class="small muted">A extensão do Escribanote continua grátis e funcionando sem conta. A conta é para o Escribanote Pro.</p>
  </section>`;
  $("login-email").focus();
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim();
    $("login-err").textContent = "";
    const btn = e.submitter;
    btn.disabled = true;
    try {
      await api.post("/auth/email", { email });
      $("login-form").hidden = true;
      $("login-sent").hidden = false;
      $("login-sent").innerHTML = `<div class="notice ok">Enviamos um link para <b>${esc(email)}</b>. Abra o e-mail neste navegador; o link vale por 15 minutos.</div>
        <p class="small muted">Não chegou? Confira a caixa de spam ou <a href="#/entrar" data-act="relogin">tente de novo</a>.</p>`;
    } catch (err) {
      $("login-err").textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------------- biblioteca ----------------
async function loadList(force = false) {
  if (state.listLoaded && !force) return;
  const r = await api.get("/meetings?limit=200");
  state.list = r.items;
  state.listLoaded = true;
}

function filtered() {
  let items = state.list;
  const f = state.filter;
  if (["meet", "teams", "zoom", "slack"].includes(f)) items = items.filter((m) => m.platform === f);
  if (f === "ata") items = items.filter((m) => m.hasSummary);
  if (f === "hl") items = items.filter((m) => m.highlights);
  const q = fold(state.query.trim());
  if (q && !state.results) items = items.filter((m) => fold(`${m.title} ${(m.participants || []).join(" ")}`).includes(q));
  return items;
}

function cardHtml(m, current, snippet) {
  const meta = [timeLabel(m.startedAt), PLATFORM[m.platform] || m.platform, m.durationMs ? fmtDuration(m.durationMs) : ""].filter(Boolean);
  const who = (m.participants || []).slice(0, 4).join(", ");
  return `<a class="card" href="#/r/${encodeURIComponent(m.id)}" aria-current="${m.id === current}" data-id="${esc(m.id)}">
    <b>${esc(m.title)}</b>
    <span class="meta">${meta.map(esc).join(" · ")}${m.hasSummary ? ' <span class="badge has-ata">ata</span>' : ""}${m.highlights ? ` <span class="badge">★ ${m.highlights}</span>` : ""}</span>
    ${snippet ? `<span class="snip">${snippet}</span>` : m.preview ? `<span class="prev">${esc(m.preview)}</span>` : who ? `<span class="prev">${esc(who)}</span>` : ""}
  </a>`;
}

function listHtml(current) {
  if (state.results) {
    if (!state.results.length) return `<p class="empty-pane small">Nada encontrado para "${esc(state.query)}".</p>`;
    return `<div class="day">Resultados da busca</div>` + state.results
      .map((r) => {
        const snip = markWords(r.snippet || "", fold(state.query).split(/\s+/).filter((w) => w.length > 1));
        const target = { ...r, preview: "" };
        return cardHtml(target, current, r.speaker ? `<b>${esc(r.speaker)}:</b> ${snip}` : snip).replace(
          `href="#/r/${encodeURIComponent(r.id)}"`,
          `href="#/r/${encodeURIComponent(r.id)}${r.entryId ? `?e=${encodeURIComponent(r.entryId)}` : ""}"`,
        );
      })
      .join("");
  }
  const items = filtered();
  if (!state.list.length) {
    return `<div class="empty-pane small"><p>Nenhuma reunião na sua conta ainda.</p>
      <p>${isPro() ? "Conecte a extensão: as reuniões gravadas nela aparecem aqui sozinhas." : "Com o Escribanote Pro, as reuniões da extensão aparecem aqui, em qualquer computador."}</p>
      <a class="btn sm ${isPro() ? "dark" : "primary"}" href="${isPro() ? "#/conectar" : "#/conta"}">${isPro() ? "Conectar a extensão" : "Conhecer o Pro"}</a></div>`;
  }
  if (!items.length) return `<p class="empty-pane small">Nenhuma reunião neste filtro.</p>`;
  let last = "";
  return items
    .map((m) => {
      const d = dayLabel(m.startedAt);
      const head = d !== last ? `<div class="day">${esc(d)}</div>` : "";
      last = d;
      return head + cardHtml(m, current);
    })
    .join("");
}

const FILTERS = [["all", "Todas"], ["meet", "Meet"], ["teams", "Teams"], ["zoom", "Zoom"], ["slack", "Slack"], ["ata", "Com ata"], ["hl", "Com destaques"]];

async function renderLibrary(id, params) {
  setNav("lib");
  try {
    await loadList();
  } catch (err) {
    return handleError(err);
  }
  if (!view.querySelector(".lib")) {
    view.innerHTML = `<div class="lib">
      <aside class="side" aria-label="Reuniões">
        <div class="side-head">
          <form class="search" id="search-form" role="search"><input class="input" id="search" type="search" placeholder="Buscar em todas as reuniões   /" aria-label="Buscar em todas as reuniões" value="${esc(state.query)}"></form>
          <div class="chips" id="filters">${FILTERS.map(([k, l]) => `<button type="button" class="chip" data-filter="${k}" aria-pressed="${state.filter === k}">${l}</button>`).join("")}</div>
        </div>
        <div id="local-notice"></div>
        <nav class="list" id="list" aria-label="Lista de reuniões"></nav>
        <div class="side-foot" id="side-foot"></div>
      </aside>
      <section class="meeting" id="meeting" aria-live="polite"></section>
    </div>`;
    $("search-form").addEventListener("submit", (e) => (e.preventDefault(), runSearch()));
    $("search").addEventListener("input", () => {
      state.query = $("search").value;
      if (!state.query.trim()) state.results = null;
      renderList(state.meeting?.id);
    });
  }
  view.querySelector(".lib").classList.toggle("has-meeting", !!id);
  renderList(id);
  $("side-foot").textContent = `${state.list.length} ${state.list.length === 1 ? "reunião" : "reuniões"} na conta · Enter busca dentro das falas`;
  renderLocalNotice();
  if (!id) {
    state.meeting = null;
    $("meeting").innerHTML = `<div class="empty-pane" style="margin:auto;padding:80px 24px">
      <p style="font:400 26px/1.2 var(--serif)">Escolha uma reunião</p>
      <p class="muted">Use <kbd>j</kbd> e <kbd>k</kbd> para passar pela lista, <kbd>/</kbd> para buscar e <kbd>Ctrl</kbd> <kbd>K</kbd> para ir direto.</p></div>`;
    return;
  }
  if (state.meeting?.id !== id) {
    $("meeting").innerHTML = `<div class="empty-pane" style="padding:80px 24px"><p class="muted">Abrindo…</p></div>`;
    try {
      const r = await api.get(`/meetings/${encodeURIComponent(id)}`);
      state.meeting = { id, doc: normalize(r.doc), version: r.version };
      state.drawer = null;
      state.inMeetingQuery = "";
      if (!state.qa.has(id)) state.qa.set(id, (r.doc.chats || []).flatMap(chatPairs));
    } catch (err) {
      if (err.status === 404) {
        $("meeting").innerHTML = `<div class="empty-pane" style="padding:80px 24px"><p>Esta reunião não existe mais na sua conta.</p><a class="btn sm" href="#/">Voltar</a></div>`;
        return;
      }
      return handleError(err);
    }
  }
  renderMeeting();
  const e = params?.get("e");
  if (e) jumpTo(e);
}

function renderList(current) {
  $("list").innerHTML = listHtml(current);
}

async function runSearch() {
  const q = $("search").value.trim();
  state.query = q;
  if (!q) {
    state.results = null;
    return renderList(state.meeting?.id);
  }
  try {
    state.results = (await api.get(`/search?q=${encodeURIComponent(q)}`)).items;
    renderList(state.meeting?.id);
  } catch (err) {
    handleError(err);
  }
}

// ---------------- reunião ----------------
const chatPairs = (c) => {
  const out = [];
  for (let i = 0; i < (c.messages || []).length; i++) {
    const m = c.messages[i];
    if (m.role === "user") out.push({ q: m.text, a: c.messages[i + 1]?.role === "assistant" ? c.messages[i + 1].text : "" });
  }
  return out;
};

function speakersOf(doc) {
  const seen = new Map();
  for (const b of toBlocks(doc, { includeChat: false })) if (!seen.has(b.speakerId)) seen.set(b.speakerId, b.speaker);
  return [...seen];
}

function renderMeeting() {
  const { doc } = state.meeting;
  const dur = doc.endedAt ? fmtDuration(doc.endedAt - doc.startedAt) : "";
  const speakers = speakersOf(doc);
  const meta = [PLATFORM[doc.platform] || doc.platform, new Date(doc.startedAt).toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" }), dur, `${speakers.length} ${speakers.length === 1 ? "participante" : "participantes"}`];
  $("meeting").innerHTML = `
    <header class="m-head">
      <a class="btn sm ghost back" href="#/">← Reuniões</a>
      <input class="m-title" id="m-title" value="${esc(doc.title)}" maxlength="200" aria-label="Título da reunião" ${isPro() ? "" : "readonly"}>
      <div class="m-meta">${meta.filter(Boolean).map(esc).join(" · ")}</div>
      <div class="actions">
        <button class="btn sm" data-act="drawer" data-d="share" ${isPro() ? "" : "disabled"}>Compartilhar</button>
        <button class="btn sm" data-act="drawer" data-d="export">Exportar</button>
        <button class="btn sm" data-act="drawer" data-d="slack" ${isPro() ? "" : "disabled"}>Slack</button>
        <button class="btn sm ghost danger" data-act="drawer" data-d="delete">Apagar</button>
      </div>
      <div id="drawer"></div>
    </header>
    <div class="m-body" id="m-body">
      <article class="tx" id="tx" aria-label="Transcrição"></article>
      <aside class="aside" aria-label="Ata e IA">
        <div class="tabs" role="tablist">
          ${[["tx", "Transcrição", "tab-tx"], ["ata", "Ata"], ["ia", "Pergunte à IA"], ["hl", "Destaques"], ["an", "Análise"]]
            .map(([k, l, cls]) => `<button role="tab" class="${cls || ""}" data-act="tab" data-tab="${k}" aria-selected="${state.tab === k}">${l}</button>`)
            .join("")}
        </div>
        <div class="pane" id="pane"></div>
      </aside>
    </div>`;
  $("m-title").addEventListener("change", () => saveTitle($("m-title").value));
  renderDrawer();
  renderTranscript();
  renderPane();
}

function renderTranscript() {
  const { doc } = state.meeting;
  const blocks = toBlocks(doc);
  const q = fold(state.inMeetingQuery.trim());
  const tagLabel = (id) => {
    const t = DEFAULT_TAGS.find((x) => x.id === id);
    return t ? `${t.emoji} ${t.label}` : id;
  };
  const speakers = speakersOf(doc);
  const html = blocks
    .filter((b) => !q || fold(`${b.speaker} ${b.text}`).includes(q))
    .map((b) => {
      if (b.kind === "chat") return `<p class="chatline" data-ids="${esc(b.ids.join(" "))}">💬 ${esc(b.speaker)}: ${esc(b.text)}</p>`;
      return `<div class="blk ${b.tags.length ? "hl" : ""}" data-ids="${esc(b.ids.join(" "))}">
        <span class="av" style="background:${colorFor(b.speakerId)}">${esc(initials(b.speaker))}</span>
        <div><div class="who"><b data-act="rename" data-spk="${esc(b.speakerId)}" title="${isPro() ? "Clique para renomear" : "Renomear participantes é do Pro"}">${esc(b.speaker)}</b> <time>${clock(b.startAt - doc.startedAt)}</time>${b.tags.map((t) => `<span class="tag">${esc(tagLabel(t))}</span>`).join("")}${b.fixed ? '<span class="fixed" title="Corrigido pela revisão da IA">revisado</span>' : ""}</div>
        <p class="txt">${esc(b.text)}</p></div></div>`;
    })
    .join("");
  $("tx").innerHTML = `
    <div class="row" style="margin-bottom:10px"><input class="input" id="tx-search" type="search" placeholder="Buscar nesta reunião" value="${esc(state.inMeetingQuery)}" aria-label="Buscar nesta reunião" style="max-width:320px"></div>
    <div class="speakers">${speakers.map(([id, name]) => `<button class="spk" data-act="rename" data-spk="${esc(id)}" title="${isPro() ? "Renomear" : esc(name)}"><span class="av" style="background:${colorFor(id)}">${esc(initials(name))}</span>${esc(name)}</button>`).join("")}</div>
    ${html || `<p class="muted">${q ? "Nada encontrado nesta reunião." : "Esta reunião ainda não tem falas."}</p>`}`;
  const input = $("tx-search");
  input.addEventListener("input", () => {
    state.inMeetingQuery = input.value;
    renderTranscript();
    const again = $("tx-search");
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });
}

function jumpTo(entryId) {
  const show = () => {
    const el = [...$("tx").querySelectorAll("[data-ids]")].find((n) => n.dataset.ids.split(" ").includes(entryId));
    if (!el) return;
    if (matchMedia("(max-width: 1240px)").matches) {
      state.tab = "tx";
      $("m-body").classList.add("show-tx");
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };
  requestAnimationFrame(show);
}

function renderPane() {
  const body = $("m-body");
  body.classList.toggle("show-tx", state.tab === "tx");
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === state.tab);
  const pane = $("pane");
  const tab = state.tab === "tx" ? "ata" : state.tab;
  if (tab === "ata") pane.innerHTML = ataPane();
  else if (tab === "ia") pane.innerHTML = iaPane();
  else if (tab === "hl") pane.innerHTML = hlPane();
  else pane.innerHTML = analysisPane();
  if (tab === "ia") $("ask-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) askMeeting($("ask-input").value);
  });
}

const upsell = (what) => `<div class="empty-pane"><p>${what} faz parte do Escribanote Pro.</p><a class="btn sm primary" href="#/conta">Conhecer o Pro</a></div>`;

function ataPane() {
  const s = state.meeting.doc.summary;
  if (!isPro() && !s?.text) return upsell("A ata com IA");
  const cost = toBlocks(state.meeting.doc).reduce((a, b) => a + b.text.length, 0) > 180_000 ? 2 : 1;
  if (!s?.text) {
    return `<div class="empty-pane"><p style="font:400 20px/1.3 var(--serif)">Ata desta reunião</p>
      <p class="small muted">Resumo, pontos principais, decisões, itens de ação e pendências.</p>
      <button class="btn primary" data-act="ata">Gerar ata <span class="cost">${cost} crédito${cost > 1 ? "s" : ""}</span></button></div>
      <div class="ata" id="ata-live" hidden></div>`;
  }
  return `<div class="ata" id="ata-live">${mdToHtml(s.text)}</div>
    <div class="row"><button class="btn sm" data-act="copy-ata">Copiar</button>${isPro() ? `<button class="btn sm ghost" data-act="ata">Gerar de novo <span class="cost">${cost} crédito${cost > 1 ? "s" : ""}</span></button>` : ""}</div>`;
}

function iaPane() {
  if (!isPro()) return upsell("A IA inclusa");
  const qa = state.qa.get(state.meeting.id) || [];
  const quick = QUICK_PROMPTS.filter((p) => ["email", "acoes", "decisoes", "pontos"].includes(p.id));
  return `<div class="qa" id="qa">${qa.map((x) => `<div class="q">${esc(x.q)}</div><div class="a">${x.a ? mdToHtml(x.a) : '<span class="typing"></span>'}</div>`).join("")}</div>
    <div class="quick">${quick.map((p) => `<button class="chip" data-act="quick" data-q="${esc(p.text)}">${esc(p.label)}</button>`).join("")}</div>
    <div class="ask-box"><textarea class="input" id="ask-input" placeholder="Pergunte qualquer coisa sobre esta reunião…" aria-label="Pergunta"></textarea>
      <div class="row"><button class="btn dark" data-act="ask">Perguntar <span class="cost">1 crédito</span></button><span class="small muted">Ctrl+Enter envia</span></div></div>`;
}

function hlPane() {
  const blocks = toBlocks(state.meeting.doc).filter((b) => b.tags.length);
  if (!blocks.length) return `<div class="empty-pane small"><p>Nenhum destaque nesta reunião.</p><p class="muted">Marque falas com ⭐ na extensão durante a reunião.</p></div>`;
  const groups = new Map();
  for (const b of blocks) for (const t of b.tags) (groups.get(t) || groups.set(t, []).get(t)).push(b);
  return [...groups]
    .map(([t, list]) => {
      const tag = DEFAULT_TAGS.find((x) => x.id === t);
      return `<div><p class="small" style="font-weight:700;margin-bottom:6px">${esc(tag ? `${tag.emoji} ${tag.label}` : t)}</p>
        ${list.map((b) => `<button class="card" style="width:100%;text-align:left;background:var(--card);border-color:var(--rule)" data-act="jump" data-e="${esc(b.ids[0])}"><span class="meta">${esc(b.speaker)} · ${clock(b.startAt - state.meeting.doc.startedAt)}</span><span>${esc(b.text)}</span></button>`).join("")}</div>`;
    })
    .join("");
}

function analysisPane() {
  const st = computeStats(state.meeting.doc);
  if (!st.speakers.length) return `<div class="empty-pane small"><p>Sem falas suficientes para analisar.</p></div>`;
  return `<div class="kpis">
      <div class="kpi"><b>${fmtDuration(st.durationMs)}</b><span>duração</span></div>
      <div class="kpi"><b>${st.totalWords.toLocaleString("pt-BR")}</b><span>palavras</span></div>
      <div class="kpi"><b>${st.totalTurns}</b><span>turnos de fala</span></div>
      <div class="kpi"><b>${st.speakers.reduce((a, s) => a + s.questions, 0)}</b><span>perguntas</span></div>
    </div>
    <p class="small" style="font-weight:700">Parcela de fala</p>
    <div class="bars">${st.speakers
      .map((s) => `<div class="bar"><span title="${esc(s.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</span><i><b style="width:${Math.round(s.share * 100)}%;background:${colorFor(s.speakerId)}"></b></i><span>${Math.round(s.share * 100)}%</span></div>`)
      .join("")}</div>
    <p class="small muted">${st.speakers.map((s) => `${esc(s.name)}: ${s.wpm} palavras/min, maior fala ${fmtDuration(s.longestMs)}`).join(" · ")}</p>`;
}

// ---------------- ações da reunião ----------------
async function saveDoc(mutate) {
  const m = state.meeting;
  const next = structuredClone(m.doc);
  mutate(next);
  next.updatedAt = Date.now();
  try {
    const r = await api.put(`/meetings/${encodeURIComponent(m.id)}`, { doc: next, baseVersion: m.version });
    m.doc = normalize(next);
    m.version = r.version;
    const item = state.list.find((x) => x.id === m.id);
    if (item) item.title = next.title;
    renderList(m.id);
    return true;
  } catch (err) {
    if (err.status === 409) {
      toast("A reunião mudou em outro lugar. Recarregando a versão mais nova.");
      state.meeting = null;
      route();
      return false;
    }
    handleError(err);
    return false;
  }
}

async function saveTitle(title) {
  title = title.trim();
  if (!title || title === state.meeting.doc.title) return;
  if (await saveDoc((d) => (d.title = title))) toast("Título salvo");
}

// Editor flutuante ancorado no nome clicado (chip ou bloco da transcrição). Enter salva, Esc cancela.
function askInline(anchor, { label, value = "", placeholder = "", suggestions = [] } = {}) {
  if (askInline.close) askInline.close();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<label class="small muted">${esc(label)}</label>
      <input class="input" maxlength="120" list="ask-list" placeholder="${esc(placeholder)}">
      <datalist id="ask-list">${suggestions.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <div class="ask-acts"><button class="btn sm" data-cancel>Cancelar</button><button class="btn sm primary" data-ok>Salvar</button></div>`;
    document.body.appendChild(pop);
    const input = pop.querySelector("input");
    input.value = value;
    const r = anchor.getBoundingClientRect();
    const w = Math.min(300, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + 8 + 140 > innerHeight ? Math.max(12, r.top - 140) : r.bottom + 8) + "px";
    const done = (v) => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      askInline.close = null;
      resolve(v);
    };
    const outside = (ev) => !pop.contains(ev.target) && done(null);
    pop.querySelector("[data-ok]").onclick = () => done(input.value.trim() || null);
    pop.querySelector("[data-cancel]").onclick = () => done(null);
    input.onkeydown = (ev) => {
      if (ev.key === "Enter") done(input.value.trim() || null);
      if (ev.key === "Escape") done(null);
    };
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    askInline.close = () => done(null);
    input.focus();
    input.select();
  });
}

async function renameSpeaker(id, anchor) {
  if (!isPro()) return toast("Renomear participantes faz parte do Escribanote Pro.");
  const doc = state.meeting.doc;
  const current = speakersOf(doc).find(([s]) => s === id)?.[1] || "";
  const others = [...new Set(speakersOf(doc).map(([, n]) => n))].filter((n) => n && n !== current);
  const name = await askInline(anchor || document.body, { label: "Nome do participante", value: current, placeholder: "Como aparece na ata", suggestions: others });
  if (!name || name === current) return;
  if (await saveDoc((d) => (d.speakers[id] = name.slice(0, 120)))) toast(`${current} agora é ${name}`);
  renderTranscript();
}

async function generateAta() {
  if (state.busy) return;
  state.busy = true;
  state.tab = "ata";
  renderPane();
  const pane = $("pane");
  pane.innerHTML = `<div class="ata typing" id="ata-live"></div><p class="small muted">Escrevendo a ata…</p>`;
  try {
    const done = await stream("/ai/summary", { meetingId: state.meeting.id }, {
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => ($("ata-live").innerHTML = mdToHtml(text)),
    });
    setCredits(done.balance);
    const r = await api.get(`/meetings/${encodeURIComponent(state.meeting.id)}`);
    state.meeting.doc = normalize(r.doc);
    state.meeting.version = r.version;
    const item = state.list.find((x) => x.id === state.meeting.id);
    if (item) item.hasSummary = true;
    renderList(state.meeting.id);
    toast("Ata pronta");
  } catch (err) {
    handleError(err);
  }
  state.busy = false;
  renderPane();
}

async function askMeeting(question) {
  question = String(question || "").trim();
  if (!question || state.busy) return;
  state.busy = true;
  const id = state.meeting.id;
  const qa = state.qa.get(id) || [];
  state.qa.set(id, qa);
  const history = qa.flatMap((x) => [{ role: "user", text: x.q }, ...(x.a ? [{ role: "assistant", text: x.a }] : [])]).slice(-10);
  const item = { q: question, a: "" };
  qa.push(item);
  state.tab = "ia";
  renderPane();
  const answerEl = () => [...$("qa").querySelectorAll(".a")].at(-1);
  try {
    const done = await stream("/ai/ask", { meetingId: id, history: [...history, { role: "user", text: question }] }, {
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => {
        item.a = text;
        answerEl().innerHTML = mdToHtml(text);
      },
    });
    item.a = done.text;
    setCredits(done.balance);
    // A conversa fica salva na reunião, como na extensão.
    await saveDoc((d) => {
      d.chats = d.chats || [];
      d.chats.push({ id: `web-${Date.now().toString(36)}`, createdAt: Date.now(), messages: [{ role: "user", text: question, at: Date.now() }, { role: "assistant", text: done.text, at: Date.now() }] });
    });
  } catch (err) {
    qa.pop();
    handleError(err);
  }
  state.busy = false;
  renderPane();
}

function renderDrawer() {
  const el = $("drawer");
  if (!el) return;
  const d = state.drawer;
  if (!d) return (el.innerHTML = "");
  if (d === "export") {
    el.innerHTML = `<div class="drawer"><p class="small" style="font-weight:700">Exportar esta reunião</p>
      <div class="row">${Object.entries(FORMATS).map(([k, f]) => `<button class="btn sm" data-act="export" data-f="${k}">${esc(f.label)}</button>`).join("")}
      <button class="btn sm dark" data-act="copy-rich">Copiar para Docs/Notion</button></div></div>`;
  } else if (d === "delete") {
    el.innerHTML = `<div class="drawer"><p>Apagar esta reunião da conta? Ela fica 30 dias na lixeira (Conta › Lixeira). A cópia no computador, na extensão, não é apagada.</p>
      <div class="row"><button class="btn sm primary" data-act="delete">Apagar da conta</button><button class="btn sm ghost" data-act="drawer" data-d="">Cancelar</button></div></div>`;
  } else if (d === "slack") {
    if (!state.meeting.doc.summary?.text) {
      el.innerHTML = `<div class="drawer"><p>Gere a ata primeiro (aba <b>Ata</b>): é ela que vai para o canal.</p></div>`;
    } else {
      el.innerHTML = `<div class="drawer" id="slack-drawer"><p class="small" style="font-weight:700">Publicar a ata num canal do Slack</p><p class="small muted">Carregando…</p></div>`;
      api.get("/slack").then((st) => {
        if (!st.configured) return ($("slack-drawer").innerHTML = `<p>A integração com o Slack não está disponível neste servidor.</p>`);
        if (!st.connected) return ($("slack-drawer").innerHTML = `<p>Conecte o Slack em <a href="#/conta">Conta</a> para publicar atas.</p>`);
        $("slack-drawer").innerHTML = `<p class="small" style="font-weight:700">Publicar a ata num canal do Slack</p>
          <div class="row"><select class="input" id="slack-post-channel" style="width:auto;min-width:220px"><option value="">Carregando canais…</option></select>
          <button class="btn sm dark" data-act="slack-post">Publicar</button></div>
          <p class="small muted">Quem responder no thread da ata recebe respostas da IA sobre esta reunião (1 crédito cada).</p>`;
        loadSlackChannels($("slack-post-channel"), st.channel?.id);
      }).catch(handleError);
    }
  } else if (d === "share") {
    el.innerHTML = `<div class="drawer"><p class="small" style="font-weight:700">Link de leitura, sem precisar de conta</p>
      <div class="row"><label class="field" style="grid-auto-flow:column;align-items:center">Vale por <select class="input" id="sh-days" style="width:auto"><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option></select></label>
      <label class="row small"><input type="checkbox" id="sh-tx" checked> Incluir a transcrição</label>
      <button class="btn sm dark" data-act="share">Criar link</button></div>
      <div id="sh-new"></div>
      <div class="links" id="sh-list"></div></div>`;
    loadShares();
  }
}

async function loadShares() {
  try {
    const r = await api.get(`/shares?meetingId=${encodeURIComponent(state.meeting.id)}`);
    const live = r.items.filter((s) => !s.revoked && new Date(s.expiresAt) > new Date());
    $("sh-list").innerHTML = live.length
      ? `<ul>${live.map((s) => `<li><span>Criado em ${dateShort(s.createdAt)} · vale até ${dateShort(s.expiresAt)} · ${s.views} ${s.views === 1 ? "acesso" : "acessos"}${s.includeTranscript ? "" : " · sem transcrição"}</span><button class="btn sm ghost danger" data-act="revoke" data-id="${esc(s.id)}">Revogar</button></li>`).join("")}</ul>`
      : "";
  } catch (err) {
    handleError(err);
  }
}

async function createShare() {
  try {
    const s = await api.post("/shares", { meetingId: state.meeting.id, days: Number($("sh-days").value), includeTranscript: $("sh-tx").checked });
    $("sh-new").innerHTML = `<div class="share-url"><input class="input" readonly value="${esc(s.url)}" id="sh-url" aria-label="Link"><button class="btn sm dark" data-act="copy-url">Copiar</button></div>
      <p class="small muted">Guarde o link agora: por segurança, ele não fica visível de novo. Você pode revogá-lo quando quiser.</p>`;
    $("sh-url").select();
    loadShares();
  } catch (err) {
    handleError(err);
  }
}

async function copy(text, html) {
  try {
    if (html && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else await navigator.clipboard.writeText(text);
    toast("Copiado");
  } catch {
    toast("Não foi possível copiar. Selecione o texto e use Ctrl+C.");
  }
}

// ---------------- perguntar a todas ----------------
function renderAskAll() {
  setNav("ask");
  view.innerHTML = `<section class="page">
    <h1>Pergunte às suas <em>reuniões</em></h1>
    <p class="lead">Uma pergunta, todas as reuniões do período: o Escribanote lê as atas e transcrições e responde citando de onde veio cada informação.</p>
    ${isPro() ? "" : `<div class="notice">Este recurso faz parte do Escribanote Pro. <a href="#/conta">Conhecer o Pro</a></div>`}
    <div class="qa" id="qa">${state.askAll.map((x) => `<div class="q">${esc(x.q)}</div><div class="a">${x.a ? mdToHtml(x.a) : '<span class="typing"></span>'}</div>`).join("")}</div>
    <div class="panel ask-box">
      <textarea class="input" id="askall-input" placeholder="Ex.: O que decidimos sobre o orçamento de mídia este mês?" ${isPro() ? "" : "disabled"}></textarea>
      <div class="row"><label class="row small">Período <select class="input" id="askall-days" style="width:auto"><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option><option value="365">1 ano</option></select></label>
      <button class="btn dark" data-act="askall" ${isPro() ? "" : "disabled"}>Perguntar <span class="cost">2 créditos</span></button></div>
    </div></section>`;
}

async function askAll() {
  const question = $("askall-input").value.trim();
  if (!question || state.busy) return;
  state.busy = true;
  const item = { q: question, a: "" };
  state.askAll.push(item);
  const history = state.askAll.slice(-6).flatMap((x) => [{ role: "user", text: x.q }, ...(x.a ? [{ role: "assistant", text: x.a }] : [])]);
  renderAskAll();
  try {
    const done = await stream("/ai/ask_all", { history, days: Number($("askall-days").value) }, {
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => {
        item.a = text;
        [...$("qa").querySelectorAll(".a")].at(-1).innerHTML = mdToHtml(text);
      },
    });
    item.a = done.text;
    setCredits(done.balance);
  } catch (err) {
    state.askAll.pop();
    handleError(err);
  }
  state.busy = false;
  renderAskAll();
}

// ---------------- conta ----------------
async function renderAccount(params) {
  setNav("account");
  let devices = [];
  let trash = [];
  try {
    state.me = await api.get("/me");
    renderCredits();
    [devices, trash] = await Promise.all([api.get("/devices"), api.get("/meetings/trash").then((r) => r.items)]);
  } catch (err) {
    return handleError(err);
  }
  const me = state.me;
  const sub = me.subscription;
  const justPaid = params.get("assinatura") === "ok";
  const statusText = {
    active: sub?.cancelAtPeriodEnd ? `Cancelada; o Pro continua até ${dateShort(sub.periodEnd)}` : `Ativa · renova em ${dateShort(sub?.periodEnd)}`,
    past_due: "Pagamento pendente: atualize a forma de pagamento para não perder o Pro",
    trialing: "Em período de teste",
    canceled: "Cancelada",
    incomplete: "Aguardando a confirmação do pagamento",
  }[sub?.status] || "Sem assinatura";
  const c = me.credits;
  if (isPro()) {
    try {
      localStorage.removeItem(PLAN_KEY);
    } catch {}
  }
  const PLAN_NAMES = { brl: { month: "R$ 15/mês", year: "R$ 150/ano" }, usd: { month: "US$ 3/mês", year: "US$ 30/ano" } };
  const plan = isPro()
    ? `<section class="panel pro"><h2>Escribanote Pro</h2>
        <dl class="kv"><dt>Assinatura</dt><dd>${esc(statusText)}</dd><dt>Plano</dt><dd>${sub?.interval === "year" ? "Anual" : "Mensal"} · ${PLAN_NAMES[sub?.currency === "usd" ? "usd" : "brl"][sub?.interval === "year" ? "year" : "month"]}</dd></dl>
        <div><div class="row" style="justify-content:space-between"><b>Créditos de IA</b><span class="small muted">${c.balance} de ${c.max} · +${c.perCycle} ${c.renewsAt ? `em ${dateShort(c.renewsAt)}` : "a cada mês"}</span></div>
        <div class="meter" style="margin-top:6px"><b style="width:${Math.min(100, (c.balance / c.max) * 100)}%"></b></div>
        <p class="small muted" style="margin-top:6px">Ata, revisão, pergunta, e-mail de follow-up e tarefas: 1 crédito. Pergunta sobre todas as reuniões: 2. Os que sobram acumulam até ${c.max}${sub?.interval === "year" ? ". No plano anual, os créditos chegam todo mês" : ""}.</p></div>
        <div class="row"><button class="btn" data-act="portal">Forma de pagamento, recibos e cancelamento</button></div></section>`
    : `<section class="panel subscribe" id="subscribe">${subscribeHtml(pendingPlan() || {})}</section>`;
  view.innerHTML = `<section class="page">
    <h1>Sua <em>conta</em></h1>
    ${justPaid && !isPro() ? `<div class="notice" id="paid-wait">Recebemos o seu pagamento. Estamos confirmando com a Stripe; com Pix pode levar alguns instantes.</div>` : ""}
    ${justPaid && isPro() ? `<div class="notice ok">Assinatura confirmada. Bem-vindo ao Escribanote Pro! Agora <a href="#/conectar">conecte a extensão</a>.</div>` : ""}
    <section class="panel"><dl class="kv"><dt>E-mail</dt><dd>${esc(me.email)}</dd><dt>Conta criada em</dt><dd>${dateShort(me.createdAt)}</dd></dl></section>
    ${plan}
    <section class="panel"><h2>Extensão</h2>
      <p class="small muted">Conecte a extensão do Escribanote para as reuniões irem para a conta sozinhas e a IA funcionar sem chave.</p>
      ${devices.length ? `<ul class="devices">${devices.map((d) => `<li><span><b>${esc(d.name)}</b><br><span class="small muted">Conectada em ${dateShort(d.createdAt)} · último uso ${dateShort(d.lastUsedAt)}</span></span><button class="btn sm ghost danger" data-act="device-off" data-id="${esc(d.id)}">Desconectar</button></li>`).join("")}</ul>` : ""}
      <div class="row"><a class="btn dark" href="#/conectar">Conectar a extensão</a></div></section>
    <section class="panel" id="slack-panel" hidden></section>
    <section class="panel"><h2>Seus dados</h2>
      <div class="row"><button class="btn" data-act="export-all">Exportar todas as reuniões (JSON)</button></div>
      ${trash.length ? `<p class="small" style="font-weight:700">Lixeira (apagadas há menos de 30 dias)</p><ul class="devices">${trash.map((t) => `<li><span>${esc(t.title)} <span class="small muted">· ${dateShort(t.startedAt)}</span></span><button class="btn sm" data-act="restore" data-id="${esc(t.id)}">Restaurar</button></li>`).join("")}</ul>` : ""}
    </section>
    <section class="panel"><div class="row"><button class="btn" data-act="logout">Sair</button><button class="btn ghost danger" data-act="delete-account-open">Apagar a conta…</button></div>
      <div id="del-acc" hidden class="drawer"><p class="small">Isto apaga a sua conta, todas as reuniões da nuvem e cancela a assinatura na hora. As reuniões salvas na extensão, no seu computador, continuam lá.</p>
      <label class="field">Digite <b>${esc(me.email)}</b> para confirmar<input id="del-confirm" autocomplete="off"></label>
      <div class="row"><button class="btn primary" data-act="delete-account">Apagar para sempre</button></div></div></section>
  </section>`;
  if (justPaid && !isPro()) pollPro();
  renderSlackPanel(params);
}

// ---------------- Slack ----------------
// O Slack como destino: a ata vai para um canal e as perguntas no thread são respondidas pela IA.
let slackState = null;
async function renderSlackPanel(params) {
  const el = $("slack-panel");
  if (!el || !isPro()) return;
  try {
    slackState = await api.get("/slack");
  } catch {
    return;
  }
  if (!slackState.configured) return;
  el.hidden = false;
  const flag = params?.get("slack");
  const note = { ok: `<div class="notice ok">Slack conectado${slackState.team?.name ? ` ao workspace <b>${esc(slackState.team.name)}</b>` : ""}. Escolha o canal das atas abaixo.</div>`, erro: `<div class="notice">O Slack não concluiu a conexão. Tente de novo.</div>`, expirado: `<div class="notice">A autorização expirou. Tente de novo.</div>`, cancelado: "" }[flag] || "";
  if (!slackState.connected) {
    el.innerHTML = `<h2>Slack</h2>${note}
      <p class="small muted">Publique a ata no canal do huddle ou da reunião e pergunte à IA respondendo no thread, sem sair do Slack.</p>
      <div class="row"><a class="btn dark" href="/api/v1/slack/install">Conectar o Slack</a></div>`;
    return;
  }
  el.innerHTML = `<h2>Slack</h2>${note}
    <dl class="kv"><dt>Workspace</dt><dd>${esc(slackState.team?.name || slackState.team?.id || "")}</dd></dl>
    <label class="field">Canal padrão das atas<select class="input" id="slack-channel"><option value="">Carregando canais…</option></select></label>
    <label class="row small"><input type="checkbox" id="slack-auto" ${slackState.auto ? "checked" : ""}> Publicar a ata sozinho quando a reunião termina (se a ata automática estiver ligada na extensão)</label>
    <p class="small muted">Em canais privados, adicione o app Escribanote ao canal antes. Cada resposta da IA no thread usa 1 crédito.</p>
    <div class="row"><button class="btn dark" data-act="slack-save">Salvar</button><button class="btn ghost danger" data-act="slack-disconnect">Desconectar</button></div>`;
  loadSlackChannels($("slack-channel"), slackState.channel?.id);
}

async function loadSlackChannels(sel, current) {
  try {
    const { items } = await api.get("/slack/channels");
    sel.innerHTML = `<option value="">Escolher…</option>` + items.map((c) => `<option value="${esc(c.id)}" data-name="${esc(c.name)}" ${c.id === current ? "selected" : ""}>${c.private ? "🔒 " : "#"}${esc(c.name)}</option>`).join("");
  } catch (err) {
    sel.innerHTML = `<option value="">Não deu para listar os canais (${esc(err.message)})</option>`;
  }
}

async function saveSlackSettings() {
  const sel = $("slack-channel");
  const opt = sel.selectedOptions[0];
  slackState = await api.put("/slack/settings", { channelId: sel.value || null, channelName: opt?.dataset.name || null, auto: $("slack-auto").checked });
  toast("Slack salvo");
}

async function disconnectSlack() {
  await api.del("/slack");
  slackState = null;
  toast("Slack desconectado");
  renderSlackPanel(new URLSearchParams());
}

async function postToSlack(btn) {
  const sel = $("slack-post-channel");
  if (sel && !sel.value) return toast("Escolha um canal");
  btn.disabled = true;
  try {
    const r = await api.post(`/meetings/${encodeURIComponent(state.meeting.id)}/slack`, { channelId: sel?.value || undefined });
    $("drawer").innerHTML = `<div class="drawer"><p>Ata publicada no Slack.${r.permalink ? ` <a href="${esc(r.permalink)}" target="_blank" rel="noopener">Abrir a mensagem</a>` : ""} Perguntas no thread dessa mensagem são respondidas pela IA.</p></div>`;
    toast("Publicada no Slack");
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- assinar ----------------
const OFFERS = {
  brl: {
    year: { price: "R$ 150", per: "/ano", was: "R$ 180", note: "Equivale a R$ 12,50 por mês · 2 meses grátis", pay: "Pix Automático ou cartão de crédito" },
    month: { price: "R$ 15", per: "/mês", note: "Cancele quando quiser", pay: "Cartão de crédito" },
  },
  usd: {
    year: { price: "US$ 30", per: "/year", was: "US$ 36", note: "US$ 2.50 a month · 2 months free", pay: "Credit card" },
    month: { price: "US$ 3", per: "/month", note: "Cancel anytime", pay: "Credit card" },
  },
};
function subscribeHtml({ interval = "year", currency = "brl" }) {
  const o = OFFERS[currency][interval];
  const seg = (k, v, label, on) =>
    `<button type="button" role="radio" aria-checked="${on}" class="seg-btn" data-act="plan-pick" data-k="${k}" data-v="${v}">${label}</button>`;
  return `<div class="sub-head"><div><p class="eyebrow-sm">Escribanote Pro</p><h2>Suas reuniões em qualquer computador, com IA inclusa</h2></div>
      <div class="segs">
        <div class="seg" role="radiogroup" aria-label="Cobrança">${seg("interval", "year", `Anual <span class="save">−17%</span>`, interval === "year")}${seg("interval", "month", "Mensal", interval === "month")}</div>
        <div class="seg" role="radiogroup" aria-label="Moeda">${seg("currency", "brl", "R$", currency === "brl")}${seg("currency", "usd", "US$", currency === "usd")}</div>
      </div></div>
    <div class="offer">
      <div class="offer-price" aria-live="polite">
        ${o.was ? `<s class="was">${o.was}</s>` : ""}<span class="amount">${o.price}<small>${o.per}</small></span>
        <span class="note">${o.note}</span>
        <span class="pay">${interval === "year" && currency === "brl" ? "◆ " : ""}${o.pay}</span>
        <button class="btn primary big" data-act="checkout" data-c="${currency}" data-i="${interval}">${currency === "usd" ? "Subscribe" : "Assinar"} ${interval === "year" ? (currency === "usd" ? "yearly" : "o anual") : currency === "usd" ? "monthly" : "o mensal"}</button>
        ${currency === "brl" && interval === "month" ? `<span class="small muted">Quer pagar com Pix? O Pix está disponível no plano anual.</span>` : ""}
      </div>
      <ul class="feat">
        <li>Reuniões salvas na conta e sincronizadas entre computadores</li>
        <li>Esta área web: busca em todas as falas, ata ao lado da transcrição, análise de fala</li>
        <li>IA sem chave de API: 15 créditos por mês, que acumulam até 30</li>
        <li>Links de leitura para quem não usa o Escribanote</li>
      </ul>
    </div>
    <div class="trust" aria-label="Segurança e privacidade">
      <div><b>Protegido no caminho e guardado cifrado</b><span>HTTPS no envio e AES-256 no armazenamento; os backups diários também são cifrados.</span></div>
      <div><b>Seus dados são seus</b><span>Não vendemos, não usamos para treinar IA e você exporta ou apaga tudo quando quiser.</span></div>
      <div><b>Direitos garantidos</b><span>Seguimos a LGPD e respeitamos os direitos do GDPR (União Europeia) e das leis de privacidade dos EUA, como a CCPA. <a href="/privacidade.html#pro">Política</a>.</span></div>
    </div>
    <p class="small muted">Pagamento processado pela Stripe; o Escribanote não vê o número do seu cartão. A extensão continua grátis e local para sempre: o Pro é opcional.</p>`;
}
function pickPlan(el) {
  const box = $("subscribe");
  const cur = {
    interval: box.querySelector('[data-k="interval"][aria-checked="true"]').dataset.v,
    currency: box.querySelector('[data-k="currency"][aria-checked="true"]').dataset.v,
  };
  cur[el.dataset.k] = el.dataset.v;
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(cur));
  } catch {}
  box.innerHTML = subscribeHtml(cur);
  box.querySelector(`[data-k="${el.dataset.k}"][aria-checked="true"]`)?.focus();
}

async function pollPro(tries = 0) {
  if (tries > 20 || parseRoute().parts[0] !== "conta") return;
  await new Promise((r) => setTimeout(r, 3000));
  const me = await api.get("/me").catch(() => null);
  if (me?.plan === "pro") {
    state.me = me;
    return renderAccount(new URLSearchParams("assinatura=ok"));
  }
  pollPro(tries + 1);
}

// ---------------- conectar a extensão ----------------
function renderConnect() {
  setNav("account");
  view.innerHTML = `<section class="page">
    <h1>Conectar a <em>extensão</em></h1>
    <p class="lead">Com a extensão conectada, cada reunião vai para a sua conta sozinha e a IA funciona sem chave de API. Use o Chrome onde a extensão do Escribanote está instalada.</p>
    ${isPro() ? "" : `<div class="notice">A conexão serve para o Escribanote Pro. <a href="#/conta">Assine primeiro</a>.</div>`}
    <div class="panel"><div class="row"><button class="btn primary" data-act="connect" ${isPro() ? "" : "disabled"}>Conectar este navegador</button></div>
    <p id="connect-msg" class="small" role="status"></p></div>
    <p class="small muted">Ainda não tem a extensão? <a href="/#baixar">Baixe grátis</a>, instale e volte aqui.</p></section>`;
}

// Reuniões gravadas pela extensão neste navegador que ainda não chegaram à conta
// (gravadas antes de conectar, sincronização desligada ou com erro). A extensão só responde ao
// app quando está conectada à conta.
async function renderLocalNotice() {
  const el = $("local-notice");
  if (!el) return;
  el.innerHTML = "";
  if (!isPro()) return;
  const r = await sendToExtension({ type: "escribanote-unsynced" });
  if (!r.ok || !r.count) return;
  el.innerHTML = `<div class="notice small" style="margin:0 12px 10px">${r.count === 1 ? "1 reunião gravada neste navegador ainda não está" : `${r.count} reuniões gravadas neste navegador ainda não estão`} na conta.
    <button type="button" class="btn sm dark" data-act="send-local" style="margin-left:8px">Enviar agora</button></div>`;
}

async function sendLocal(btn) {
  btn.disabled = true;
  btn.textContent = "Enviando…";
  const r = await sendToExtension({ type: "escribanote-save" });
  if (!r.ok) {
    toast(`A extensão não enviou (${r.reason || "erro"})`);
    btn.disabled = false;
    btn.textContent = "Enviar agora";
    return;
  }
  toast(r.failed?.length ? `${r.synced.length} enviadas, ${r.failed.length} com erro${r.error ? `: ${r.error}` : ""}` : `${r.synced.length} ${r.synced.length === 1 ? "reunião enviada" : "reuniões enviadas"}`);
  await loadList(true);
  renderList(state.meeting?.id);
  renderLocalNotice();
}

function sendToExtension(message) {
  return new Promise((resolve) => {
    const rt = globalThis.chrome?.runtime;
    if (!rt?.sendMessage) return resolve({ ok: false, reason: "no-runtime" });
    try {
      rt.sendMessage(EXTENSION_ID, message, (reply) => {
        if (rt.lastError || !reply) resolve({ ok: false, reason: rt.lastError?.message || "sem resposta" });
        else resolve(reply);
      });
    } catch (err) {
      resolve({ ok: false, reason: err.message });
    }
  });
}

async function connectExtension() {
  const msg = $("connect-msg");
  msg.textContent = "Conectando…";
  const probe = await sendToExtension({ type: "escribanote-ping" });
  if (!probe.ok) {
    msg.innerHTML = `A extensão do Escribanote não respondeu neste navegador. Confira se ela está instalada e atualizada (versão 2.5 ou mais nova) e recarregue esta página. <a href="/#baixar">Baixar a extensão</a>`;
    return;
  }
  try {
    const browser = /Edg\//.test(navigator.userAgent) ? "Edge" : "Chrome";
    const os = /Windows/.test(navigator.userAgent) ? "Windows" : /Mac/.test(navigator.userAgent) ? "macOS" : /Linux/.test(navigator.userAgent) ? "Linux" : "";
    const dev = await api.post("/devices", { name: `Extensão no ${browser}${os ? ` (${os})` : ""}` });
    const r = await sendToExtension({ type: "escribanote-connect", token: dev.token, email: state.me.email, deviceId: dev.id });
    if (!r.ok) {
      await api.del(`/devices/${dev.id}`).catch(() => {});
      msg.textContent = `A extensão recusou a conexão (${r.reason || "erro"}).`;
      return;
    }
    msg.innerHTML = `<span style="color:var(--ok);font-weight:600">Pronto! A extensão está conectada.</span> ${r.pending ? `Ela vai perguntar se você quer enviar as ${r.pending} reuniões que já estão no computador.` : ""}`;
    toast("Extensão conectada");
  } catch (err) {
    handleError(err);
    msg.textContent = "";
  }
}

// ---------------- paleta de comandos ----------------
let paletteItems = [];
let paletteSel = 0;
function openPalette() {
  if (!state.me) return;
  $("palette").hidden = false;
  const input = $("palette-input");
  input.value = "";
  fillPalette("");
  input.focus();
}
function closePalette() {
  $("palette").hidden = true;
}
function fillPalette(q) {
  const f = fold(q);
  const actions = [
    { label: "Reuniões", hint: "ir", go: "#/" },
    { label: "Perguntar às reuniões", hint: "IA", go: "#/perguntar" },
    { label: "Conta e assinatura", hint: "ir", go: "#/conta" },
    { label: "Conectar a extensão", hint: "ir", go: "#/conectar" },
  ];
  const meetings = state.list.map((m) => ({ label: m.title, hint: dateShort(m.startedAt), go: `#/r/${encodeURIComponent(m.id)}` }));
  paletteItems = [...actions, ...meetings].filter((i) => !f || fold(i.label).includes(f)).slice(0, 30);
  if (q.trim()) paletteItems.push({ label: `Buscar "${q.trim()}" nas falas`, hint: "busca", search: q.trim() });
  paletteSel = 0;
  drawPalette();
}
function drawPalette() {
  $("palette-list").innerHTML = paletteItems
    .map((i, n) => `<li role="option" data-n="${n}" aria-selected="${n === paletteSel}">${esc(i.label)}<span>${esc(i.hint)}</span></li>`)
    .join("");
}
function choosePalette(n) {
  const item = paletteItems[n];
  if (!item) return;
  closePalette();
  if (item.search) {
    location.hash = "#/";
    setTimeout(() => {
      $("search").value = item.search;
      runSearch();
    }, 50);
  } else location.hash = item.go;
}
$("palette-input").addEventListener("input", (e) => fillPalette(e.target.value));
$("palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") (paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1)), drawPalette(), e.preventDefault();
  else if (e.key === "ArrowUp") (paletteSel = Math.max(paletteSel - 1, 0)), drawPalette(), e.preventDefault();
  else if (e.key === "Enter") choosePalette(paletteSel);
  else if (e.key === "Escape") closePalette();
});
$("palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li) choosePalette(Number(li.dataset.n));
});
$("palette").addEventListener("click", (e) => e.target.id === "palette" && closePalette());
$("palette-open").addEventListener("click", openPalette);
$("credits").addEventListener("click", () => (location.hash = "#/conta"));

// Atalhos: Ctrl+K paleta, / busca, j/k na lista.
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return $("palette").hidden ? openPalette() : closePalette();
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/" && $("search")) {
    e.preventDefault();
    $("search").focus();
  }
  if ((e.key === "j" || e.key === "k") && $("list")) {
    const cards = [...$("list").querySelectorAll(".card")];
    if (!cards.length) return;
    const i = cards.findIndex((c) => c.getAttribute("aria-current") === "true");
    const next = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === "j" ? 1 : -1)))];
    if (next) location.hash = next.getAttribute("href");
  }
});

// ---------------- cliques ----------------
view.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) {
    const chip = e.target.closest("[data-filter]");
    if (chip) {
      state.filter = chip.dataset.filter;
      state.results = null;
      for (const c of document.querySelectorAll("[data-filter]")) c.setAttribute("aria-pressed", c === chip);
      renderList(state.meeting?.id);
    }
    return;
  }
  const act = el.dataset.act;
  const m = state.meeting;
  try {
    switch (act) {
      case "reload":
        return location.reload();
      case "send-local":
        return sendLocal(el);
      case "slack-save":
        return saveSlackSettings();
      case "slack-disconnect":
        return disconnectSlack();
      case "slack-post":
        return postToSlack(el);
      case "relogin":
        e.preventDefault();
        return renderLogin();
      case "tab":
        state.tab = el.dataset.tab;
        return renderPane();
      case "drawer":
        state.drawer = state.drawer === el.dataset.d ? null : el.dataset.d || null;
        return renderDrawer();
      case "rename":
        return renameSpeaker(el.dataset.spk, el);
      case "jump":
        return jumpTo(el.dataset.e);
      case "ata":
        return generateAta();
      case "copy-ata":
        return copy(m.doc.summary.text, mdToHtml(m.doc.summary.text));
      case "quick":
        return askMeeting(el.dataset.q);
      case "ask":
        return askMeeting($("ask-input").value);
      case "askall":
        return askAll();
      case "export": {
        const f = FORMATS[el.dataset.f];
        return download(fileName(m.doc, el.dataset.f), f.render(m.doc, { tags: DEFAULT_TAGS }), f.mime);
      }
      case "copy-rich": {
        const html = toHtml(m.doc, { tags: DEFAULT_TAGS });
        return copy(FORMATS.txt.render(m.doc, { tags: DEFAULT_TAGS }), html);
      }
      case "delete":
        await api.del(`/meetings/${encodeURIComponent(m.id)}`);
        state.list = state.list.filter((x) => x.id !== m.id);
        state.meeting = null;
        toast("Reunião movida para a lixeira");
        location.hash = "#/";
        return;
      case "share":
        return createShare();
      case "copy-url":
        return copy($("sh-url").value);
      case "revoke":
        await api.del(`/shares/${el.dataset.id}`);
        toast("Link revogado");
        return loadShares();
      case "plan-pick":
        return pickPlan(el);
      case "checkout": {
        el.disabled = true;
        const r = await api.post("/billing/checkout", { currency: el.dataset.c, interval: el.dataset.i }).catch((err) => {
          el.disabled = false;
          throw err;
        });
        location.href = r.url;
        return;
      }
      case "portal": {
        const r = await api.post("/billing/portal");
        location.href = r.url;
        return;
      }
      case "device-off":
        await api.del(`/devices/${el.dataset.id}`);
        toast("Extensão desconectada");
        return renderAccount(new URLSearchParams());
      case "export-all": {
        const data = await api.get("/export");
        return download(`escribanote-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1), "application/json");
      }
      case "restore":
        await api.post(`/meetings/${encodeURIComponent(el.dataset.id)}/restore`);
        state.listLoaded = false;
        toast("Reunião restaurada");
        return renderAccount(new URLSearchParams());
      case "logout":
        await api.post("/auth/logout");
        state.me = null;
        state.list = [];
        state.listLoaded = false;
        state.meeting = null;
        location.hash = "#/entrar";
        return;
      case "delete-account-open":
        $("del-acc").hidden = !$("del-acc").hidden;
        return $("del-confirm").focus();
      case "delete-account":
        await api.del("/me", { confirm: $("del-confirm").value });
        state.me = null;
        view.innerHTML = `<section class="page"><h1>Conta apagada</h1><p class="lead">Seus dados foram apagados e a assinatura foi cancelada. A extensão continua funcionando no seu computador, grátis.</p></section>`;
        $("credits").hidden = true;
        return;
      case "connect":
        return connectExtension();
      default:
    }
  } catch (err) {
    handleError(err);
    el.disabled = false;
  }
});

route();
