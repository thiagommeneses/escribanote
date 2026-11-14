// Escribanote — área logada. Rotas pelo fragmento (#/…); dados pela API; transcrição, ata, exportações
// e análise com as mesmas bibliotecas da extensão (copiadas para ./lib na publicação).
import { api, ApiError, stream } from "./api.js";
import { QUICK_PROMPTS, QUESTION_MAX, questionCredits } from "./lib/ai.js";
import { clock, FORMATS, fileName, mdToHtml, PLATFORM, toHtml, ataPlainText, ataFileName, ataEditorHtml } from "./lib/format.js";
import { DEFAULT_TAGS } from "./lib/settings.js";
import { computeStats, fmtDuration } from "./lib/stats.js";
import { normalize, toBlocks, mergeSpeakers, speakerName } from "./lib/transcript.js";
import { commitSummary, diffDocument, diffStats, diffHtml } from "./lib/diff.js";
import { DECK_KINDS, DECK_SIZES, DECK_STYLES, DECK_DEFAULTS, deckOptions, cleanDeck } from "./lib/slides.js";
import { openDeck, showReturnBar, hideReturnBar, deckThumbHtml, downloadPptx, printDeck, paletteChooserHtml, paletteClick, paletteInput, slidePreviewHtml } from "./lib/deckview.js";
import "./lib/icons.js"; // ícones da extensão (duotone): globalThis.EsIcons

const { icon, tagIcon } = globalThis.EsIcons;

// IDs da extensão: instalação pelo zip do site e pela Chrome Web Store (o primeiro que responder vale).
const EXTENSION_IDS = ["ohbnmfogdcbgegnpcaphidkjinplednd"];
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
const dateTimeShort = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
// Teste grátis do Pro (48 h, sem cartão): disponível, ativo ou já usado.
const onTrial = () => !!state.me?.trial?.active;
function trialOfferHtml(t) {
  if (!t?.available) return "";
  return `<div class="trial-offer"><div><b>Teste o Pro grátis por ${t.hours} horas</b>
      <span>Sem cartão e sem cobrança no fim. Tudo do Pro liberado, com ${t.credits} créditos de IA para experimentar a ata, as perguntas e a transcrição no servidor.</span></div>
      <button class="btn dark" data-act="trial">Começar o teste grátis</button></div>`;
}
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
// O servidor devolve o crédito quando a resposta é interrompida; o saldo é relido um instante depois.
const STOPPED_NOTE = "_(Resposta interrompida por você.)_";
function refreshCredits() {
  setTimeout(() => api.get("/me").then((me) => { state.me = me; renderCredits(); }).catch(() => {}), 1500);
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
  if (head === "criar" || head === "esqueci") return renderEmailLink(head);
  if (head === "senha" && arg) return renderSetPassword(arg);
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
  showChrome(true);
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
// E-mail + senha, ou um link por e-mail (sem senha). "Criar conta" e "Esqueci a senha" mandam um link
// que confirma o e-mail e leva a #/senha/<token>, onde a pessoa escolhe a senha. Google e Apple: em breve.
let typedEmail = "";
const SOCIAL = [
  { id: "google", label: "Google", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.09A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>` },
  { id: "apple", label: "Apple", icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.37 12.73c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.6 1.1 8.75.73 1.05 1.6 2.24 2.73 2.2 1.1-.05 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.2 6.27c.6-.73 1.01-1.75.9-2.77-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.68-.92 2.68.97.07 1.96-.49 2.56-1.22z"/></svg>` },
];
function socialHtml() {
  return `<div class="social" role="group" aria-label="Entrar com outra conta">
    ${SOCIAL.map((p) => `<button type="button" class="btn social-btn" disabled aria-describedby="social-soon">${p.icon}Continuar com ${p.label}</button>`).join("")}
    <p class="small muted" id="social-soon">Entrar com Google e Apple chega em breve.</p>
  </div>
  <div class="or" aria-hidden="true"><span>ou com e-mail</span></div>`;
}
const pwField = (id, label, autocomplete, extra = "") =>
  `<label class="field">${label}<span class="pw"><input type="password" id="${id}" autocomplete="${autocomplete}" required ${extra}><button type="button" class="pw-eye" data-act="pw-eye" data-for="${id}" aria-label="Mostrar senha" aria-pressed="false">Mostrar</button></span></label>`;

// Depois de entrar (senha, link ou senha nova): volta para onde a pessoa queria ir.
function afterLogin(me) {
  state.me = me;
  renderCredits();
  const after = sessionStorage.getItem("after");
  sessionStorage.removeItem("after");
  const fallback = pendingPlan() && me.plan !== "pro" ? "#/conta" : "#/";
  const skip = /^#\/(entrar|criar|esqueci|senha)/;
  history.replaceState(null, "", after && !skip.test(after) && after !== "#/" ? after : fallback);
  return route();
}

// Sem conta: o menu e a paleta da área logada somem.
function showChrome(on) {
  document.querySelector(".top .nav").hidden = !on;
  $("palette-open").hidden = !on;
}

function authPage(inner) {
  setNav("");
  showChrome(false);
  $("credits").hidden = true;
  view.innerHTML = `<section class="page auth">${inner}
    <p class="small muted">A extensão do Escribanote continua grátis e funcionando sem conta. A conta é para o Escribanote Pro.</p></section>`;
}

async function renderLogin(token) {
  if (token) {
    setNav("");
    showChrome(false);
    view.innerHTML = `<section class="page"><h1>Entrando…</h1></section>`;
    try {
      return afterLogin(await api.post("/auth/verify", { token }));
    } catch (err) {
      view.innerHTML = `<section class="page"><h1>Este link não vale mais</h1>
        <p class="lead">${esc(err.message)}</p><p><a class="btn dark" href="#/entrar">Voltar para o login</a></p></section>`;
      return;
    }
  }
  authPage(`<h1>Entre no <em>Escribanote</em></h1>
    <p class="lead">Suas reuniões, atas e a IA inclusa do Escribanote Pro, em qualquer computador.</p>
    <div class="auth-box">
      ${socialHtml()}
      <form id="login-form" class="auth-form" novalidate>
        <label class="field">E-mail<input type="email" id="login-email" autocomplete="username email" required placeholder="voce@empresa.com" value="${esc(typedEmail)}"></label>
        ${pwField("login-password", `<span class="row" style="justify-content:space-between">Senha <a href="#/esqueci" class="small" data-keep-email>Esqueci minha senha</a></span>`, "current-password")}
        <button class="btn primary big" type="submit">Entrar</button>
        <p class="err" id="login-err" role="alert"></p>
      </form>
      <button type="button" class="btn ghost magic" data-act="magic">Entrar sem senha: receber um link por e-mail</button>
      <div class="sent" id="login-sent" hidden></div>
    </div>
    <p class="small">Ainda não tem conta? <a href="#/criar" data-keep-email>Criar conta</a></p>`);
  const email = $("login-email");
  (email.value ? $("login-password") : email).focus();
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("login-err");
    err.textContent = "";
    typedEmail = email.value.trim();
    const password = $("login-password").value;
    if (!typedEmail) return ((err.textContent = "Digite o seu e-mail."), email.focus());
    if (!password) return ((err.textContent = "Digite a senha, ou use \"Entrar sem senha\" logo abaixo."), $("login-password").focus());
    const btn = e.submitter || e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      afterLogin(await api.post("/auth/login", { email: typedEmail, password }));
    } catch (ex) {
      err.textContent = ex.code === "invalid_credentials" ? "E-mail ou senha incorretos. Se a sua conta ainda não tem senha, entre pelo link ou use \"Esqueci minha senha\" para criar uma." : ex.message;
      btn.disabled = false;
    }
  });
}

async function sendMagicLink(btn) {
  const email = $("login-email");
  const err = $("login-err");
  typedEmail = email.value.trim();
  err.textContent = "";
  if (!typedEmail) return ((err.textContent = "Digite o seu e-mail para receber o link."), email.focus());
  btn.disabled = true;
  try {
    await api.post("/auth/email", { email: typedEmail });
    $("login-form").hidden = true;
    btn.hidden = true;
    for (const el of document.querySelectorAll(".auth .social, .auth .or")) el.hidden = true;
    $("login-sent").hidden = false;
    $("login-sent").innerHTML = `<div class="notice ok">Enviamos um link para <b>${esc(typedEmail)}</b>. Abra o e-mail neste navegador; o link vale por 15 minutos.</div>
      <p class="small muted">Não chegou? Confira a caixa de spam ou <a href="#/entrar" data-act="relogin">tente de novo</a>.</p>`;
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
}

// "Criar conta" e "Esqueci minha senha": o mesmo link por e-mail, que confirma o endereço e leva à senha nova.
function renderEmailLink(kind) {
  const create = kind === "criar";
  authPage(`<h1>${create ? "Crie sua <em>conta</em>" : "Esqueceu a <em>senha</em>?"}</h1>
    <p class="lead">${create
      ? "Digite o seu e-mail. Enviamos um link para confirmar o endereço e escolher a sua senha."
      : "Digite o e-mail da conta. Enviamos um link para você escolher uma senha nova. Se a conta ainda não tem senha, o mesmo link serve para criar uma."}</p>
    <div class="auth-box">
      ${create ? socialHtml() : ""}
      <form id="link-form" class="auth-form" novalidate>
        <label class="field">E-mail<input type="email" id="link-email" autocomplete="email" required placeholder="voce@empresa.com" value="${esc(typedEmail)}"></label>
        <button class="btn primary big" type="submit">${create ? "Criar conta" : "Enviar link"}</button>
        <p class="err" id="link-err" role="alert"></p>
      </form>
      <div class="sent" id="link-sent" hidden></div>
    </div>
    <p class="small">${create ? "Já tem conta?" : "Lembrou a senha?"} <a href="#/entrar" data-keep-email>Entrar</a></p>`);
  $("link-email").focus();
  $("link-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    typedEmail = $("link-email").value.trim();
    $("link-err").textContent = "";
    if (!typedEmail) return (($("link-err").textContent = "Digite o seu e-mail."), $("link-email").focus());
    const btn = e.submitter || e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await api.post("/auth/password/forgot", { email: typedEmail });
      $("link-form").hidden = true;
      for (const el of document.querySelectorAll(".auth .social, .auth .or")) el.hidden = true;
      $("link-sent").hidden = false;
      $("link-sent").innerHTML = `<div class="notice ok">Se o endereço estiver certo, chega em instantes um e-mail para <b>${esc(typedEmail)}</b> com o link para escolher a senha. Ele vale por 15 minutos.</div>
        <p class="small muted">Não chegou? Confira a caixa de spam ou <a href="#/${kind}" data-act="relink">tente de novo</a>.</p>`;
    } catch (ex) {
      $("link-err").textContent = ex.message;
      btn.disabled = false;
    }
  });
}

// Link do e-mail: escolher a senha (nova conta ou redefinição). Entra na conta ao salvar.
function renderSetPassword(token) {
  authPage(`<h1>Escolha sua <em>senha</em></h1>
    <p class="lead">Use pelo menos 8 caracteres. Uma frase curta que só você conhece costuma ser mais forte e mais fácil de lembrar.</p>
    <div class="auth-box">
      <form id="pw-form" class="auth-form" novalidate>
        ${pwField("pw-new", "Senha nova", "new-password", 'minlength="8"')}
        ${pwField("pw-again", "Repita a senha", "new-password", 'minlength="8"')}
        <button class="btn primary big" type="submit">Salvar e entrar</button>
        <p class="err" id="pw-err" role="alert"></p>
      </form>
    </div>`);
  $("pw-new").focus();
  $("pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("pw-err");
    const password = $("pw-new").value;
    err.textContent = "";
    if (password.length < 8) return ((err.textContent = "A senha precisa ter pelo menos 8 caracteres."), $("pw-new").focus());
    if (password !== $("pw-again").value) return ((err.textContent = "As duas senhas não são iguais."), $("pw-again").focus());
    const btn = e.submitter || e.target.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      const me = await api.post("/auth/password/reset", { token, password });
      toast("Senha salva");
      afterLogin(me);
    } catch (ex) {
      if (ex.code === "invalid_token") {
        view.querySelector(".auth-box").innerHTML = `<div class="notice">${esc(ex.message)}</div><p><a class="btn dark" href="#/esqueci">Pedir um novo link</a></p>`;
        return;
      }
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

// Conta: definir (sem a atual) ou trocar (com a atual) a senha.
function passwordPanel(me) {
  return `<section class="panel" id="pw-panel"><h2>Senha e acesso</h2>
    <p class="small muted">${me.hasPassword
      ? "Você entra com e-mail e senha, ou pelo link por e-mail quando preferir."
      : "Sua conta entra só pelo link enviado por e-mail. Defina uma senha para entrar mais rápido."}
      Entrar com Google e Apple chega em breve.</p>
    <div class="row"><button class="btn" data-act="pw-open">${me.hasPassword ? "Alterar senha" : "Definir senha"}</button></div>
    <form id="pw-change" class="drawer auth-form" hidden novalidate>
      ${me.hasPassword ? pwField("pw-current", "Senha atual", "current-password") : ""}
      ${pwField("pw-change-new", "Senha nova", "new-password", 'minlength="8"')}
      <div class="row"><button class="btn primary" type="submit">Salvar senha</button><button class="btn ghost" type="button" data-act="pw-open">Cancelar</button></div>
      <p class="err" id="pw-change-err" role="alert"></p>
      ${me.hasPassword ? `<p class="small muted">Trocar a senha encerra as sessões do app nos outros navegadores. A extensão continua conectada.</p>` : ""}
    </form></section>`;
}
function bindPasswordPanel() {
  const form = $("pw-change");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("pw-change-err");
    const password = $("pw-change-new").value;
    err.textContent = "";
    if (password.length < 8) return ((err.textContent = "A senha precisa ter pelo menos 8 caracteres."), $("pw-change-new").focus());
    const btn = e.submitter || form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await api.put("/auth/password", { current: $("pw-current")?.value || "", password });
      state.me = { ...state.me, hasPassword: true };
      toast("Senha salva");
      $("pw-panel").outerHTML = passwordPanel(state.me);
      bindPasswordPanel();
    } catch (ex) {
      err.textContent = ex.message;
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
    <span class="meta">${meta.map(esc).join(" · ")}${m.hasSummary ? ' <span class="badge has-ata">ata</span>' : ""}${m.highlights ? ` <span class="badge">${icon("importante")}${m.highlights}</span>` : ""}</span>
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
    hideReturnBar();
    state.meeting = null;
    $("meeting").innerHTML = `<div class="empty-pane" style="margin:auto;padding:80px 24px">
      <p style="font:400 26px/1.2 var(--serif)">Escolha uma reunião</p>
      <p class="muted">Use <kbd>j</kbd> e <kbd>k</kbd> para passar pela lista, <kbd>/</kbd> para buscar e <kbd>Ctrl</kbd> <kbd>K</kbd> para ir direto.</p></div>`;
    return;
  }
  if (state.meeting?.id !== id) {
    hideReturnBar(); // a volta aos slides é só da reunião aberta
    $("meeting").innerHTML = `<div class="empty-pane" style="padding:80px 24px"><p class="muted">Abrindo…</p></div>`;
    try {
      const r = await api.get(`/meetings/${encodeURIComponent(id)}`);
      state.meeting = { id, doc: normalize(r.doc), version: r.version };
      state.ataView = null; state.ataEdit = null; state.showVersions = false;
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
          ${[["tx", "Transcrição", "tab-tx"], ["ata", "Ata"], ["ia", "Pergunte à IA"], ["sl", "Slides"], ["hl", "Destaques"], ["an", "Análise"]]
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
  const tagChip = (id) => {
    const t = DEFAULT_TAGS.find((x) => x.id === id);
    return t ? `<span class="tag" style="--tc:${t.color}">${icon(tagIcon(t))}${esc(t.label)}</span>` : `<span class="tag">${icon("tag")}${esc(id)}</span>`;
  };
  const speakers = speakersOf(doc);
  const html = blocks
    .filter((b) => !q || fold(`${b.speaker} ${b.text}`).includes(q))
    .map((b) => {
      if (b.kind === "chat") return `<p class="chatline" data-ids="${esc(b.ids.join(" "))}">${icon("chat")} ${esc(b.speaker)}: ${esc(b.text)}</p>`;
      return `<div class="blk ${b.tags.length ? "hl" : ""}" data-ids="${esc(b.ids.join(" "))}">
        <span class="av" style="background:${colorFor(b.speakerId)}">${esc(initials(b.speaker))}</span>
        <div><div class="who"><b data-act="rename" data-spk="${esc(b.speakerId)}" title="${isPro() ? "Clique para renomear" : "Renomear participantes é do Pro"}">${esc(b.speaker)}</b> <time>${clock(b.startAt - doc.startedAt)}</time>${b.tags.map(tagChip).join("")}${b.fixed ? '<span class="fixed" title="Corrigido pela revisão da IA">revisado</span>' : ""}</div>
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
  else if (tab === "sl") pane.innerHTML = slidesPane();
  else if (tab === "hl") pane.innerHTML = hlPane();
  else pane.innerHTML = analysisPane();
  // Contagem e custo: pergunta com mais de 2.000 caracteres custa 2 créditos.
  if (tab === "ia") $("ask-input")?.addEventListener("input", (e) => {
    const v = e.target.value;
    $("ask-count").textContent = `${v.length.toLocaleString("pt-BR")}/${QUESTION_MAX.toLocaleString("pt-BR")}`;
    const c = questionCredits(v);
    $("ask-cost").textContent = `${c} crédito${c === 1 ? "" : "s"}`;
  });
  if (tab === "ia") $("ask-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) askMeeting($("ask-input").value);
  });
}

const upsell = (what) => `<div class="empty-pane"><p>${what} faz parte do Escribanote Pro.</p><a class="btn sm primary" href="#/conta">Conhecer o Pro</a></div>`;

// Modelos de ata do usuário: ficam neste navegador (localStorage); o escolhido para a reunião fica no documento.
const TPL_KEY = "escribanote.ataTemplates";
function templates() {
  try { const v = JSON.parse(localStorage.getItem(TPL_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); } catch { toast("Não deu para guardar o modelo neste navegador."); }
}
function templateText(doc) {
  const id = doc.ataTemplateId;
  if (!id || id === "none") return "";
  return templates().find((t) => t.id === id)?.text || "";
}
function ataPane() {
  const doc = state.meeting.doc;
  const s = doc.summary;
  if (!isPro() && !s?.text) return upsell("A ata com IA");
  const cost = toBlocks(doc).reduce((a, b) => a + b.text.length, 0) > 180_000 ? 2 : 1;
  const tpls = templates();
  const picker = isPro() ? `<label class="small muted" style="display:flex;gap:8px;align-items:center">Modelo
      <select class="input" style="width:auto;padding:5px 8px" data-act="tpl-pick"><option value="">Formato do Escribanote</option>${tpls.map((t) => `<option value="${esc(t.id)}" ${doc.ataTemplateId === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select>
      <button class="btn sm ghost" data-act="drawer" data-d="templates">Modelos…</button></label>
    <details class="ata-prompt" ${(doc.ataPrompt || "").trim() ? "open" : ""}><summary class="small muted">Instruções extras para a IA${(doc.ataPrompt || "").trim() ? ' <b class="pill">ativas</b>' : ""}</summary>
      <textarea class="input" data-act="ata-prompt" rows="3" maxlength="4000" placeholder="Ex.: conclusão em um parágrafo só; não cite valores; inclua uma seção de riscos.">${esc(doc.ataPrompt || "")}</textarea>
      <p class="small muted">Valem só para esta reunião e prevalecem sobre o formato e o modelo. Salvas ao sair do campo; gere a ata de novo para aplicar.</p></details>` : "";
  const gen = `<button class="btn ${s?.text ? "sm ghost" : "primary"}" data-act="ata">${s?.text ? "Gerar de novo" : "Gerar ata"} <span class="cost">${cost} crédito${cost > 1 ? "s" : ""}</span></button>`;
  if (!s?.text) {
    return `<div class="empty-pane"><p style="font:400 20px/1.3 var(--serif)">Ata desta reunião</p>
      <p class="small muted">${tpls.length && doc.ataTemplateId ? "No formato do seu modelo, pronta para colar no seu sistema." : "Resumo, pontos principais, decisões, itens de ação e pendências."}</p>
      ${picker}${gen}</div>
      <div class="ata" id="ata-live" hidden></div>`;
  }
  const hist = doc.summaryHistory || [];
  const editing = state.ataEdit;
  const body = editing
    ? `<textarea class="input" id="ata-edit-text" rows="18" spellcheck="true">${esc(editing.text)}</textarea>
       <div class="row" style="margin-top:8px"><input class="input" id="ata-edit-label" style="flex:1;min-width:160px" maxlength="80" placeholder="O que mudou? (opcional, vira o rótulo da versão)"><button class="btn sm primary" data-act="ata-edit-save">Salvar como nova versão</button><button class="btn sm ghost" data-act="ata-edit-cancel">Cancelar</button></div>`
    : `<div class="ata" id="ata-live">${state.ataView ? `<p class="small muted">Mostrando a v${state.ataView.n} (${esc(state.ataView.label)}). A ata atual não mudou.</p>` + mdToHtml(state.ataView.text) : mdToHtml(s.text)}</div>`;
  return `${body}
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-act="copy-ata">Copiar</button>
      <button class="btn sm" data-act="copy-ata" data-k="editor" title="HTML no formato do Editor (TinyMCE): cole direto no editor">Copiar p/ Editor</button>
      <button class="btn sm" data-act="copy-ata" data-k="html" title="Código HTML para o 'Código-fonte' do editor">Copiar HTML</button>
      <button class="btn sm" data-act="dl-ata" data-f="txt">Baixar .txt</button>
      <button class="btn sm" data-act="dl-ata" data-f="md">Baixar .md</button>
      <button class="btn sm" data-act="dl-ata" data-f="pdf">PDF</button>
      ${isPro() ? `<button class="btn sm" data-act="ata-edit">Editar</button>` : ""}
      ${hist.length ? `<button class="btn sm" data-act="ata-versions">${state.showVersions ? "Ocultar versões" : `Versões (${hist.length})`}</button>` : ""}
      ${isPro() ? gen : ""}</div>
    ${picker ? `<div class="row" style="margin-top:8px">${picker}</div>` : ""}
    ${state.showVersions && hist.length ? versionsPane(doc) : ""}`;
}

// Histórico da ata e comparador (diff por palavras, da biblioteca compartilhada)
state.cmp = state.cmp || { a: null, b: null };
const fmtWhen = (t) => new Date(t).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
function versionsPane(doc) {
  const hist = doc.summaryHistory;
  const cur = hist[hist.length - 1];
  const ids = hist.map((v) => v.id);
  if (!ids.includes(state.cmp.b)) state.cmp.b = cur.id;
  if (!ids.includes(state.cmp.a)) state.cmp.a = hist.length > 1 ? hist[hist.length - 2].id : cur.id;
  const opt = (sel) => hist.map((v) => `<option value="${esc(v.id)}" ${sel === v.id ? "selected" : ""}>v${v.n} · ${fmtWhen(v.createdAt)}</option>`).join("");
  const A = hist.find((v) => v.id === state.cmp.a);
  const B = hist.find((v) => v.id === state.cmp.b);
  const blocks = diffDocument(A.text, B.text);
  const st = diffStats(blocks);
  const list = hist.slice().reverse().map((v) => {
    const prev = hist.find((x) => x.id === v.parentId);
    const d = prev ? diffStats(diffDocument(prev.text, v.text)) : null;
    const isCur = doc.summary && doc.summary.text.trim() === v.text.trim();
    return `<div class="ver ${isCur ? "current" : ""}"><span class="vn">v${v.n}</span><span class="vl">${esc(v.label)}${isCur ? " · <b>atual</b>" : ""}<small>${fmtWhen(v.createdAt)}</small></span>
      <span class="vs">${d ? `<b class="plus">+${d.added}</b> <b class="minus">−${d.removed}</b>` : "primeira"}</span>
      <button class="btn sm ghost" data-act="ver-view" data-v="${esc(v.id)}">Ver</button><button class="btn sm ghost" data-act="ver-cmp" data-v="${esc(v.id)}">Comparar</button>
      ${isCur || !isPro() ? "" : `<button class="btn sm ghost" data-act="ver-restore" data-v="${esc(v.id)}">Restaurar</button>`}</div>`;
  }).join("");
  return `<div class="versions"><div class="versions-head"><b class="small">Histórico da ata</b>
      <div class="row"><label class="small muted">Comparar <select class="input" style="width:auto;padding:3px 6px" data-cmp="a">${opt(state.cmp.a)}</select> com <select class="input" style="width:auto;padding:3px 6px" data-cmp="b">${opt(state.cmp.b)}</select></label>
      <label class="small muted"><input type="checkbox" data-cmp="side" ${state.cmpSide ? "checked" : ""}> lado a lado</label>
      <label class="small muted"><input type="checkbox" data-cmp="only" ${state.cmpOnly === false ? "" : "checked"}> só mudanças</label></div></div>
    <div class="versions-list">${list}</div>
    <p class="small muted">${A.id === B.id ? "Escolha duas versões diferentes." : `v${A.n} → v${B.n}: <b style="color:#15803d">+${st.added}</b> adicionadas, <b style="color:#b91c1c">−${st.removed}</b> removidas, ${st.changedLines} linha${st.changedLines === 1 ? "" : "s"} alterada${st.changedLines === 1 ? "" : "s"}.`}</p>
    <div class="diff">${diffHtml(blocks, { mode: state.cmpSide ? "side" : "inline", onlyChanges: state.cmpOnly !== false })}</div></div>`;
}

function downloadAta(doc, kind) {
  if (!doc.summary?.text) return;
  if (kind === "pdf") {
    const w = window.open("", "_blank");
    if (!w) return toast("O navegador bloqueou a janela. Libere pop-ups para salvar o PDF.");
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Ata — ${esc(doc.title)}</title>
      <style>body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#16181d;max-width:780px;margin:40px auto;padding:0 24px}h1{font-size:22px}h2{font-size:16px;margin-top:24px}h3{font-size:14px}hr{border:0;border-top:1px solid #999;margin:18px 0}@media print{body{margin:0}}</style></head>
      <body>${mdToHtml(doc.summary.text)}<script>setTimeout(()=>print(),300)</script></body></html>`);
    w.document.close();
    return;
  }
  const text = kind === "txt" ? ataPlainText(doc.summary.text) : doc.summary.text;
  const url = URL.createObjectURL(new Blob([text], { type: `${kind === "txt" ? "text/plain" : "text/markdown"};charset=utf-8` }));
  const a = Object.assign(document.createElement("a"), { href: url, download: ataFileName(doc, kind) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function importTemplateFile(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) return toast("Arquivo grande demais (máximo 8 MB).");
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  toast("Lendo a ata e extraindo o modelo…");
  try {
    const body = isPdf
      ? { pdfBase64: await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = () => fail(new Error("Não deu para ler o arquivo.")); r.readAsDataURL(file); }) }
      : { text: await file.text() };
    const r = await api.post("/ai/template", body);
    setCredits(r.balance);
    state.tplEdit = { id: "", name: file.name.replace(/\.(pdf|txt|md)$/i, ""), text: r.text };
    renderDrawer();
    toast("Modelo extraído. Revise e salve.");
  } catch (err) {
    handleError(err);
  }
}

function iaPane() {
  if (!isPro()) return upsell("A IA inclusa");
  const qa = state.qa.get(state.meeting.id) || [];
  const quick = QUICK_PROMPTS.filter((p) => ["email", "acoes", "decisoes", "pontos"].includes(p.id));
  return `<div class="qa" id="qa">${qa.map((x) => `<div class="q">${esc(x.q)}</div><div class="a">${x.a ? mdToHtml(x.a) : thinkingHtml(x.t0)}</div>`).join("")}</div>
    <div class="quick">${quick.map((p) => `<button class="chip" data-act="quick" data-q="${esc(p.text)}">${esc(p.label)}</button>`).join("")}</div>
    <div class="ask-box"><textarea class="input" id="ask-input" maxlength="${QUESTION_MAX}" placeholder="Pergunte qualquer coisa sobre esta reunião…" aria-label="Pergunta"></textarea>
      <div class="row">${state.aiStop ? '<button class="btn danger" data-act="ai-stop" title="Interromper a resposta (o que já veio fica na conversa)">Parar</button>' : '<button class="btn dark" data-act="ask">Perguntar <span class="cost" id="ask-cost">1 crédito</span></button>'}<span class="small muted"><span id="ask-count">0/${QUESTION_MAX.toLocaleString("pt-BR")}</span> · Ctrl+Enter envia</span></div></div>`;
}

// ---------------- slides ----------------
// Mesma biblioteca da extensão: a IA monta a apresentação (1 crédito) e os slides ficam salvos na reunião.
// Estilo, cores e tema mudam depois sem gastar crédito. As capturas de tela ficam no computador, então aqui
// os slides de imagem aparecem só com o texto.
const SLIDE_OPTS_KEY = "escribanote.slideOpts";
const slideUi = { form: false, instructions: "", opts: null };
function slideOpts() {
  if (slideUi.opts) return slideUi.opts;
  try { slideUi.opts = deckOptions({ ...DECK_DEFAULTS, ...JSON.parse(localStorage.getItem(SLIDE_OPTS_KEY) || "{}") }); } catch { slideUi.opts = deckOptions(DECK_DEFAULTS); }
  return slideUi.opts;
}
function slidesPane() {
  const doc = state.meeting.doc;
  const deck = cleanDeck(doc.slides);
  if (!isPro() && !deck) return upsell("Os slides com IA");
  const busy = state.slidesBusy === state.meeting.id;
  const o = slideOpts();
  const words = toBlocks(doc).reduce((n, b) => n + b.text.length, 0);
  const tooShort = (doc.endedAt || doc.updatedAt) - doc.startedAt < 2 * 60_000 || words < 400;
  const card = deck
    ? `<div class="sl-deck">
        <div class="sl-cover" role="button" tabindex="0" data-act="sl-open" aria-label="Abrir os slides">${deckThumbHtml(deck, doc, {}, 0)}</div>
        <p class="small" style="margin:8px 0 2px"><b>${esc(deck.title)}</b></p>
        <p class="small muted" style="margin:0 0 8px">${deck.slides.length} slides · ${esc((DECK_KINDS.find((k) => k.id === deck.kind) || DECK_KINDS[0]).label)} · ${new Date(deck.createdAt || Date.now()).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</p>
        <div class="row"><button class="btn sm primary" data-act="sl-present">Apresentar</button><button class="btn sm" data-act="sl-open">Ver e editar</button><button class="btn sm" data-act="sl-pptx">.pptx</button><button class="btn sm" data-act="sl-pdf">PDF</button></div>
        <p class="small muted">Clique no horário de um slide para ir à fala de onde ele saiu. O .pptx abre no PowerPoint e no Google Slides, com as notas do apresentador.${deck.slides.some((x) => x.shot) ? " As capturas de tela ficam no computador: abra pela extensão para vê-las nos slides." : ""}</p>
        ${isPro() && !slideUi.form && !busy ? `<div class="row"><button class="btn sm ghost" data-act="sl-again">Gerar outra versão</button><button class="btn sm ghost danger" data-act="sl-clear">Apagar slides</button></div>` : ""}
      </div>`
    : `<div class="empty-pane small"><p><b>Slides a partir desta reunião</b></p><p class="muted">A IA monta a apresentação com o que foi dito: cada slide aponta o momento da reunião de onde saiu e vem com notas do apresentador.</p></div>`;
  const form = isPro() && (!deck || slideUi.form || busy)
    ? `<div class="sl-form">
        <p class="small" style="font-weight:700;margin:0">Tipo de apresentação</p>
        <div class="sl-kinds">${DECK_KINDS.map((k) => `<label class="sl-kind ${o.kind === k.id ? "on" : ""}"><input type="radio" name="sl-kind" value="${k.id}" ${o.kind === k.id ? "checked" : ""}><b>${esc(k.label)}</b><span>${esc(k.hint)}</span></label>`).join("")}</div>
        <div class="sl-grid">
          <label class="field"><span class="small muted">Tamanho</span><select class="input" id="sl-size">${DECK_SIZES.map((z) => `<option value="${z.id}" ${o.size === z.id ? "selected" : ""}>${esc(z.label)}</option>`).join("")}</select></label>
          <label class="field"><span class="small muted">Estilo</span><select class="input" id="sl-style">${DECK_STYLES.map((z) => `<option value="${z.id}" ${o.style === z.id ? "selected" : ""}>${esc(z.label)}</option>`).join("")}</select></label>
          <label class="field"><span class="small muted">Tema</span><select class="input" id="sl-mode"><option value="claro" ${o.mode === "claro" ? "selected" : ""}>Claro</option><option value="escuro" ${o.mode === "escuro" ? "selected" : ""}>Escuro</option></select></label>
        </div>
        <p class="small muted sl-hint">${esc((DECK_STYLES.find((z) => z.id === o.style) || DECK_STYLES[0]).hint)}</p>
        <p class="small" style="font-weight:700;margin:0">Cores</p>
        ${paletteChooserHtml(o, { editing: !!slideUi.palEdit, attrs: 'data-act="sl-pal"' })}
        <div class="sl-preview" aria-hidden="true">${slidePreviewHtml(doc, o)}</div>
        <label class="field"><span class="small muted">Instruções (opcional)</span><textarea class="input" id="sl-inst" rows="2" maxlength="1000" placeholder="Ex.: foque nas decisões de preço; público: diretoria">${esc(slideUi.instructions)}</textarea></label>
        <div class="row"><button class="btn dark" data-act="sl-gen" ${busy || tooShort ? "disabled" : ""}>${busy ? "Montando os slides…" : deck ? "Gerar de novo" : "Gerar slides"} ${busy ? "" : '<span class="cost">1 crédito</span>'}</button>${deck && !busy ? '<button class="btn sm ghost" data-act="sl-cancel">Cancelar</button>' : ""}</div>
        <p class="small muted">${busy ? "Leva até um minuto." : tooShort ? "Slides só a partir de 2 minutos de reunião com falas." : "Estilo, cores e tema também mudam depois, sem gastar crédito."}</p>
      </div>`
    : "";
  return card + form;
}
async function generateSlides() {
  const m = state.meeting;
  if (state.slidesBusy) return;
  const options = { ...slideOpts(), instructions: $("sl-inst")?.value || "" };
  try { localStorage.setItem(SLIDE_OPTS_KEY, JSON.stringify({ kind: options.kind, size: options.size, style: options.style, palette: options.palette, mode: options.mode })); } catch {}
  state.slidesBusy = m.id;
  renderPane();
  try {
    const r = await api.post("/ai/slides", { meetingId: m.id, options });
    setCredits(r.balance);
    if (state.meeting?.id === m.id) {
      m.doc.slides = r.deck;
      if (r.version) m.version = r.version;
    }
    slideUi.form = false;
    slideUi.instructions = "";
    toast(`${r.deck.slides.length} slides prontos`);
    state.slidesBusy = null;
    if (state.meeting?.id === m.id && state.tab === "sl") { renderPane(); openSlides(); }
  } catch (err) {
    handleError(err);
  }
  state.slidesBusy = null;
  if (state.tab === "sl") renderPane();
}
function openSlides({ present = false, index = 0 } = {}) {
  const m = state.meeting;
  const deck = cleanDeck(m.doc.slides);
  if (!deck) return;
  openDeck({
    deck,
    session: m.doc,
    present,
    index,
    editable: isPro(),
    onSave: async (d) => {
      if (state.meeting?.id !== m.id) return;
      const ok = await saveDoc((doc) => { doc.slides = d; });
      if (!ok) throw new Error("Não salvou");
      if (state.tab === "sl") renderPane();
    },
    onJump: (rel, back) => {
      if (state.meeting?.id !== m.id) return;
      const at = m.doc.startedAt + rel;
      const blocks = toBlocks(m.doc).filter((b) => b.kind !== "chat");
      const b = blocks.filter((x) => x.startAt <= at + 2000).pop() || blocks[0];
      if (b) jumpTo(b.ids[0]);
      if (back) showReturnBar(back, (x) => { if (state.meeting?.id === m.id) openSlides({ present: x.present, index: x.index }); });
    },
    onRegenerate: isPro() ? () => { slideUi.form = true; state.tab = "sl"; renderPane(); } : null,
  });
}
document.addEventListener("change", (e) => {
  if (!e.target.closest?.("#pane") || state.tab !== "sl") return;
  const o = slideOpts();
  const t = e.target;
  if (t.name === "sl-kind") o.kind = t.value;
  else if (t.id === "sl-size") o.size = t.value;
  else if (t.id === "sl-style") o.style = t.value;
  else if (t.id === "sl-mode") o.mode = t.value;
  else return;
  slideUi.instructions = $("sl-inst")?.value || slideUi.instructions;
  renderPane();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "sl-inst") slideUi.instructions = e.target.value;
  else if (state.tab === "sl" && slideUi.opts && paletteInput(e.target, slideUi)) {
    const pv = document.querySelector("#pane .sl-preview");
    if (pv) pv.innerHTML = slidePreviewHtml(state.meeting.doc, slideUi.opts);
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.closest?.(".sl-cover")) { e.preventDefault(); openSlides(); }
});

function hlPane() {
  const blocks = toBlocks(state.meeting.doc).filter((b) => b.tags.length);
  if (!blocks.length) return `<div class="empty-pane small"><p>Nenhum destaque nesta reunião.</p><p class="muted">Marque falas com Destacar (Alt+Shift+H) na extensão durante a reunião.</p></div>`;
  const groups = new Map();
  for (const b of blocks) for (const t of b.tags) (groups.get(t) || groups.set(t, []).get(t)).push(b);
  return [...groups]
    .map(([t, list]) => {
      const tag = DEFAULT_TAGS.find((x) => x.id === t);
      return `<div><p class="small" style="font-weight:700;margin-bottom:6px">${tag ? `<span class="tag-h" style="--tc:${tag.color}">${icon(tagIcon(tag))}</span>${esc(tag.label)}` : esc(t)}</p>
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

function askChoice(anchor, { title, text, choices }) {
  if (askInline.close) askInline.close();
  return new Promise((resolve) => {
    const pop = document.createElement("div");
    pop.className = "ask";
    pop.innerHTML = `<b>${esc(title)}</b><p class="small muted" style="margin:0">${esc(text)}</p>
      <div class="ask-acts">${choices.map((c) => `<button class="btn sm${c.primary ? " primary" : ""}" data-choice="${esc(c.key)}">${esc(c.label)}</button>`).join("")}</div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = Math.min(340, document.documentElement.clientWidth - 24);
    pop.style.width = w + "px";
    pop.style.left = Math.max(12, Math.min(r.left, document.documentElement.clientWidth - w - 12)) + "px";
    pop.style.top = (r.bottom + 8 + 150 > innerHeight ? Math.max(12, r.top - 150) : r.bottom + 8) + "px";
    const done = (v) => {
      pop.remove();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", onKey, true);
      askInline.close = null;
      resolve(v);
    };
    const outside = (ev) => !pop.contains(ev.target) && done(null);
    const onKey = (ev) => ev.key === "Escape" && done(null);
    pop.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-choice]");
      if (b) done(b.dataset.choice);
    });
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    askInline.close = () => done(null);
    (pop.querySelector(".primary") || pop.querySelector("button")).focus();
  });
}

async function renameSpeaker(id, anchor) {
  if (!isPro()) return toast("Renomear participantes faz parte do Escribanote Pro.");
  const doc = state.meeting.doc;
  const current = speakersOf(doc).find(([s]) => s === id)?.[1] || "";
  const others = [...new Set(speakersOf(doc).map(([, n]) => n))].filter((n) => n && n !== current);
  const name = await askInline(anchor || document.body, { label: "Nome do participante", value: current, placeholder: "Como aparece na ata", suggestions: others });
  if (!name || name === current) return;
  const other = speakersOf(doc).find(([s, n]) => s !== id && n.trim().toLowerCase() === name.toLowerCase());
  if (other) {
    const choice = await askChoice(anchor || document.body, {
      title: `Mesclar com ${other[1]}?`,
      text: `As falas de ${current} passam a ser de ${other[1]}, e os dois viram um único participante. Isso não pode ser desfeito.`,
      choices: [{ key: "merge", label: "Mesclar", primary: true }, { key: "rename", label: "Manter separados" }, { key: "cancel", label: "Cancelar" }],
    });
    if (!choice || choice === "cancel") return;
    if (choice === "merge") {
      if (await saveDoc((d) => mergeSpeakers(d, id, other[0]))) toast(`${current} mesclado em ${speakerName(doc, other[0])}`);
      renderTranscript();
      return;
    }
  }
  if (await saveDoc((d) => (d.speakers[id] = name.slice(0, 120)))) toast(`${current} agora é ${name}`);
  renderTranscript();
}

document.addEventListener("change", (e) => {
  const c = e.target.closest("[data-cmp]");
  if (!c) return;
  if (c.dataset.cmp === "a" || c.dataset.cmp === "b") state.cmp[c.dataset.cmp] = c.value;
  else if (c.dataset.cmp === "side") state.cmpSide = c.checked;
  else if (c.dataset.cmp === "only") state.cmpOnly = c.checked;
  renderPane();
});
document.addEventListener("change", async (e) => {
  const ta = e.target.closest('[data-act="ata-prompt"]');
  if (ta && state.meeting) {
    const text = ta.value.trim().slice(0, 4000);
    if (text === (state.meeting.doc.ataPrompt || "").trim()) return;
    await saveDoc((d) => (d.ataPrompt = text));
    return toast(text ? "Instruções salvas. Gere a ata de novo para aplicar." : "Instruções removidas.");
  }
  const sel = e.target.closest('[data-act="tpl-pick"]');
  if (!sel || !state.meeting) return;
  await saveDoc((d) => (d.ataTemplateId = sel.value || null));
  toast(sel.value ? "Modelo escolhido. Gere a ata para aplicar." : "Formato padrão na próxima ata.");
});

// Espera da IA: indicador animado, tempo decorrido e prévia opcional do texto (como na extensão).
const since = (t0) => {
  const sec = Math.max(0, Math.floor((Date.now() - t0) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
setInterval(() => document.querySelectorAll("[data-since]").forEach((el) => (el.textContent = since(Number(el.dataset.since)))), 1000);
const thinkingHtml = (t0 = Date.now()) => `<span class="wait-inline" role="status"><span class="spin" aria-hidden="true"></span><span class="wait-label">Pensando…</span><time class="wait-time" data-since="${t0}">${since(t0)}</time></span>`;
function waitCard(el, { label, writing }) {
  const t0 = Date.now();
  el.innerHTML = `<div class="wait" role="status" aria-live="polite">
    <div class="wait-head"><span class="spin" aria-hidden="true"></span><b class="wait-label">${esc(label)}</b><span class="wait-meta"><time data-since="${t0}">0:00</time><span class="wait-words"></span></span></div>
    <div class="skel" aria-hidden="true"><i style="width:42%"></i><i></i><i style="width:93%"></i><i style="width:68%"></i><i class="gap" style="width:30%"></i><i></i><i style="width:58%"></i></div>
    <details class="wait-prev" hidden><summary>Mostrar prévia</summary><div class="ata wait-text"></div></details>
  </div>`;
  const q = (sel) => el.querySelector(sel);
  let text = "";
  const paint = () => {
    const box = q(".wait-text");
    if (!box || !q(".wait-prev").open) return;
    const end = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.innerHTML = mdToHtml(text);
    if (end) box.scrollTop = box.scrollHeight;
  };
  q(".wait-prev").addEventListener("toggle", () => {
    q(".wait-prev summary").textContent = q(".wait-prev").open ? "Esconder prévia" : "Mostrar prévia";
    paint();
  });
  return {
    phase(label) {
      if (q(".wait") && !text) q(".wait-label").textContent = label;
    },
    update(t) {
      if (!q(".wait")) return;
      text = t;
      q(".wait-label").textContent = writing;
      q(".wait-prev").hidden = false;
      const n = (t.match(/\S+/g) || []).length;
      q(".wait-words").textContent = ` · ${n} ${n === 1 ? "palavra" : "palavras"}`;
      paint();
    },
  };
}

async function generateAta() {
  if (state.busy) return;
  state.busy = true;
  state.tab = "ata";
  renderPane();
  const pane = $("pane");
  pane.innerHTML = `<div id="ata-live"></div>`;
  const card = waitCard($("ata-live"), { label: "Lendo a transcrição…", writing: "Escrevendo a ata…" });
  try {
    const template = templateText(state.meeting.doc);
    const instructions = (state.meeting.doc.ataPrompt || "").trim();
    const done = await stream("/ai/summary", { meetingId: state.meeting.id, ...(template ? { template } : {}), ...(instructions ? { instructions } : {}) }, {
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => card.update(text),
      onPhase: (p) => card.phase(p === "Escrevendo…" ? "Escrevendo a ata…" : p),
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
  const item = { q: question, a: "", t0: Date.now() };
  qa.push(item);
  state.tab = "ia";
  renderPane();
  const answerEl = () => [...$("qa").querySelectorAll(".a")].at(-1);
  const stop = (state.aiStop = new AbortController());
  renderPane();
  try {
    const done = await stream("/ai/ask", { meetingId: id, history: [...history, { role: "user", text: question }] }, {
      signal: stop.signal,
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => {
        item.a = text;
        answerEl().innerHTML = mdToHtml(text);
      },
      onPhase: (p) => {
        const l = answerEl()?.querySelector(".wait-label");
        if (l) l.textContent = p;
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
    if (stop.signal.aborted && item.a.trim()) {
      // Parar: o que já veio fica na conversa, marcado; o servidor devolve o crédito da resposta cortada.
      item.a += `\n\n${STOPPED_NOTE}`;
      await saveDoc((d) => {
        d.chats = d.chats || [];
        d.chats.push({ id: `web-${Date.now().toString(36)}`, createdAt: Date.now(), messages: [{ role: "user", text: question, at: Date.now() }, { role: "assistant", text: item.a, at: Date.now() }] });
      }).catch(() => {});
    } else {
      qa.pop();
      if (!stop.signal.aborted) handleError(err);
    }
  }
  if (state.aiStop === stop) state.aiStop = null;
  state.busy = false;
  renderPane();
  if (stop.signal.aborted) refreshCredits();
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
  } else if (d === "templates") {
    const tpls = templates();
    const e = state.tplEdit;
    el.innerHTML = `<div class="drawer"><p class="small" style="font-weight:700">Modelos de ata</p>
      <p class="small muted">Importe um PDF ou texto de uma ata que a sua equipe usa: a IA extrai a estrutura (títulos, campos, participantes, assinatura) e as próximas atas saem nesse formato. Logotipos, QR codes e assinaturas eletrônicas são ignorados. 1 crédito por importação.</p>
      ${tpls.length ? tpls.map((t) => `<div class="row" style="justify-content:space-between"><b class="small">${esc(t.name)}</b><span><button class="btn sm ghost" data-act="tpl-edit" data-id="${esc(t.id)}">Editar</button><button class="btn sm ghost" data-act="tpl-del" data-id="${esc(t.id)}">Apagar</button></span></div>`).join("") : '<p class="small muted">Nenhum modelo ainda.</p>'}
      <div class="row"><button class="btn sm" data-act="tpl-import">Importar de PDF ou texto</button><button class="btn sm ghost" data-act="tpl-new">Escrever um modelo</button><input type="file" id="tpl-file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" hidden></div>
      ${e ? `<label class="field"><span class="small muted">Nome</span><input class="input" id="tpl-name" maxlength="80" value="${esc(e.name)}"></label>
        <label class="field"><span class="small muted">Modelo em Markdown. Use {{data}}, {{participantes}}, {{resumo_por_participante}}, {{conclusao}}… onde a IA deve preencher.</span><textarea class="input" id="tpl-text" rows="14" spellcheck="false">${esc(e.text)}</textarea></label>
        <div class="row"><button class="btn sm primary" data-act="tpl-save">Salvar modelo</button><button class="btn sm ghost" data-act="tpl-cancel">Cancelar</button></div>` : ""}
      </div>`;
    el.querySelector("#tpl-file")?.addEventListener("change", (ev) => importTemplateFile(ev.target.files[0]));
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
    <div class="qa" id="qa">${state.askAll.map((x) => `<div class="q">${esc(x.q)}</div><div class="a">${x.a ? mdToHtml(x.a) : thinkingHtml(x.t0)}</div>`).join("")}</div>
    <div class="panel ask-box">
      <textarea class="input" id="askall-input" placeholder="Ex.: O que decidimos sobre o orçamento de mídia este mês?" ${isPro() ? "" : "disabled"}></textarea>
      <div class="row"><label class="row small">Período <select class="input" id="askall-days" style="width:auto"><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option><option value="365">1 ano</option></select></label>
      ${state.aiStop ? '<button class="btn danger" data-act="ai-stop" title="Interromper a resposta">Parar</button>' : `<button class="btn dark" data-act="askall" ${isPro() ? "" : "disabled"}>Perguntar <span class="cost">2 créditos</span></button>`}</div>
    </div></section>`;
}

async function askAll() {
  const question = $("askall-input").value.trim();
  if (!question || state.busy) return;
  state.busy = true;
  const item = { q: question, a: "", t0: Date.now() };
  state.askAll.push(item);
  const history = state.askAll.slice(-6).flatMap((x) => [{ role: "user", text: x.q }, ...(x.a ? [{ role: "assistant", text: x.a }] : [])]);
  const stop = (state.aiStop = new AbortController());
  const days = Number($("askall-days").value);
  renderAskAll();
  try {
    const done = await stream("/ai/ask_all", { history, days }, {
      signal: stop.signal,
      onStart: (d) => setCredits(d.balance),
      onDelta: (text) => {
        item.a = text;
        [...$("qa").querySelectorAll(".a")].at(-1).innerHTML = mdToHtml(text);
      },
    });
    item.a = done.text;
    setCredits(done.balance);
  } catch (err) {
    if (stop.signal.aborted && item.a.trim()) item.a += `\n\n${STOPPED_NOTE}`;
    else {
      state.askAll.pop();
      if (!stop.signal.aborted) handleError(err);
    }
  }
  if (state.aiStop === stop) state.aiStop = null;
  state.busy = false;
  renderAskAll();
  if (stop.signal.aborted) refreshCredits();
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
    trial: me.trial?.active ? `Teste grátis até ${dateTimeShort(me.trial.endsAt)}` : "O teste grátis terminou",
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
        <dl class="kv"><dt>Assinatura</dt><dd>${esc(statusText)}</dd><dt>Plano</dt><dd>${onTrial() ? `Teste grátis de ${me.trial.hours} horas, sem cobrança` : `${sub?.interval === "year" ? "Anual" : "Mensal"} · ${PLAN_NAMES[sub?.currency === "usd" ? "usd" : "brl"][sub?.interval === "year" ? "year" : "month"]}`}</dd></dl>
        <div><div class="row" style="justify-content:space-between"><b>Créditos de IA</b><span class="small muted">${c.balance} de ${c.max} · ${onTrial() ? `do teste grátis; assinando, +${c.perCycle} por mês` : `+${c.perCycle} ${c.renewsAt ? `em ${dateShort(c.renewsAt)}` : "a cada mês"}`}</span></div>
        <div class="meter" style="margin-top:6px"><b style="width:${Math.min(100, (c.balance / c.max) * 100)}%"></b></div>
        <p class="small muted" style="margin-top:6px">Ata, revisão, pergunta, e-mail de follow-up e tarefas: 1 crédito. Pergunta com mais de 2.000 caracteres ou sobre todas as reuniões: 2. Os que sobram acumulam até ${c.max}${sub?.interval === "year" ? ". No plano anual, os créditos chegam todo mês" : ""}.</p></div>
        ${onTrial() ? "" : `<div class="row"><button class="btn" data-act="portal">Forma de pagamento, recibos e cancelamento</button></div>`}</section>
      ${onTrial() ? `<section class="panel subscribe" id="subscribe"><div class="notice">Gostou? Assine para continuar com o Pro depois do teste. Os créditos que sobrarem continuam com você.</div>${subscribeHtml(pendingPlan() || {})}</section>` : ""}`
    : `<section class="panel subscribe" id="subscribe">${sub?.status === "trial" ? `<div class="notice">O seu teste grátis do Pro terminou. Assine para continuar; as reuniões que subiram continuam na conta para ler e exportar.</div>` : trialOfferHtml(me.trial)}${subscribeHtml(pendingPlan() || {})}</section>`;
  view.innerHTML = `<section class="page">
    <h1>Sua <em>conta</em></h1>
    ${justPaid && !isPro() ? `<div class="notice" id="paid-wait">Recebemos o seu pagamento. Estamos confirmando com a Stripe; com Pix pode levar alguns instantes.</div>` : ""}
    ${justPaid && isPro() ? `<div class="notice ok">Assinatura confirmada. Bem-vindo ao Escribanote Pro! Agora <a href="#/conectar">conecte a extensão</a>.</div>` : ""}
    <section class="panel"><dl class="kv"><dt>E-mail</dt><dd>${esc(me.email)}</dd><dt>Conta criada em</dt><dd>${dateShort(me.createdAt)}</dd></dl></section>
    ${plan}
    ${passwordPanel(me)}
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
  bindPasswordPanel();
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
        <li>Quem fala, reconhecido pela voz</li>
        <li>Arquivos longos transcritos no servidor (1 crédito por hora) e várias tarefas de IA ao mesmo tempo</li>
        <li>Links de leitura para quem não usa o Escribanote</li>
        <li>Garantia de 7 dias: desistiu, devolvemos tudo</li>
      </ul>
    </div>
    <div class="trust" aria-label="Segurança e privacidade">
      <div><b>Protegido no caminho e guardado cifrado</b><span>HTTPS no envio e AES-256 no armazenamento; os backups diários também são cifrados.</span></div>
      <div><b>Seus dados são seus</b><span>Não vendemos, não usamos para treinar IA e você exporta ou apaga tudo quando quiser.</span></div>
      <div><b>Direitos garantidos</b><span>Seguimos a LGPD e respeitamos os direitos do GDPR (União Europeia) e das leis de privacidade dos EUA, como a CCPA. <a href="/privacidade.html#pro">Política</a>.</span></div>
    </div>
    <p class="small muted">Ao assinar, você concorda com os <a href="/termos.html">termos de uso</a>. Pagamento processado pela Stripe; o Escribanote não vê o número do seu cartão. A extensão continua grátis e local para sempre: o Pro é opcional.</p>`;
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

function sendToExtensionId(id, message) {
  return new Promise((resolve) => {
    const rt = globalThis.chrome?.runtime;
    if (!rt?.sendMessage) return resolve({ ok: false, reason: "no-runtime" });
    try {
      rt.sendMessage(id, message, (reply) => {
        if (rt.lastError || !reply) resolve({ ok: false, reason: rt.lastError?.message || "sem resposta" });
        else resolve(reply);
      });
    } catch (err) {
      resolve({ ok: false, reason: err.message });
    }
  });
}
let extensionIdFound = null;
async function sendToExtension(message) {
  let last = { ok: false, reason: "no-runtime" };
  for (const id of extensionIdFound ? [extensionIdFound] : EXTENSION_IDS) {
    const r = await sendToExtensionId(id, message);
    if (r.ok !== false || r.reason !== "no-runtime" && !/Could not establish|Receiving end|Invalid extension id|sem resposta/i.test(r.reason || "")) {
      extensionIdFound = id;
      return r;
    }
    last = r;
  }
  return last;
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
  // Entre as telas de login, o e-mail digitado vai junto.
  if (e.target.closest("[data-keep-email]")) typedEmail = ($("login-email") || $("link-email"))?.value.trim() || typedEmail;
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
      case "relink":
        e.preventDefault();
        return renderEmailLink(parseRoute().parts[0]);
      case "magic":
        return sendMagicLink(el);
      case "pw-eye": {
        const input = $(el.dataset.for);
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        el.textContent = show ? "Ocultar" : "Mostrar";
        el.setAttribute("aria-pressed", show);
        el.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
        return;
      }
      case "pw-open": {
        const f = $("pw-change");
        f.hidden = !f.hidden;
        if (!f.hidden) f.querySelector("input")?.focus();
        return;
      }
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
      case "copy-ata": {
        const md = m.doc.summary.text;
        if (el.dataset.k === "html") return copy(ataEditorHtml(md));
        if (el.dataset.k === "editor") return copy(ataPlainText(md), ataEditorHtml(md));
        return copy(md, mdToHtml(md));
      }
      case "dl-ata":
        return downloadAta(m.doc, el.dataset.f);
      case "ata-versions":
        state.showVersions = !state.showVersions;
        return renderPane();
      case "ata-edit":
        state.ataEdit = { text: m.doc.summary?.text || "" };
        state.ataView = null;
        return renderPane();
      case "ata-edit-cancel":
        state.ataEdit = null;
        return renderPane();
      case "ata-edit-save": {
        const text = document.getElementById("ata-edit-text").value.trim();
        const label = document.getElementById("ata-edit-label").value.trim();
        if (!text) return toast("A ata está vazia.");
        state.ataEdit = null;
        if (text === (m.doc.summary?.text || "").trim()) { renderPane(); return toast("Nada mudou."); }
        if (await saveDoc((d) => { d.summary = { ...(d.summary || {}), text, createdAt: Date.now(), model: "manual" }; commitSummary(d, d.summary, { source: "edit", label: label ? `Editada à mão · ${label}` : "Editada à mão" }); })) toast("Nova versão salva");
        return renderPane();
      }
      case "ver-view":
        state.ataView = m.doc.summaryHistory.find((v) => v.id === el.dataset.v) || null;
        return renderPane();
      case "ver-cmp": {
        const hist = m.doc.summaryHistory;
        const cur = hist[hist.length - 1];
        state.cmp = { a: el.dataset.v, b: cur.id === el.dataset.v && hist.length > 1 ? hist[hist.length - 2].id : cur.id };
        state.showVersions = true;
        return renderPane();
      }
      case "ver-restore": {
        const v = m.doc.summaryHistory.find((x) => x.id === el.dataset.v);
        const ok = await askChoice(el, { title: `Restaurar a v${v.n}?`, text: "Ela volta a ser a ata atual, como uma nova versão. Nada é apagado do histórico.", choices: [{ key: "ok", label: "Restaurar", primary: true }, { key: "cancel", label: "Cancelar" }] });
        if (ok !== "ok") return;
        state.ataView = null;
        if (await saveDoc((d) => { d.summary = { text: v.text, createdAt: Date.now(), model: v.model, templateId: v.templateId ?? null }; commitSummary(d, d.summary, { source: "restore", label: `Restaurada da v${v.n}`, parentId: v.id }); })) toast(`v${v.n} restaurada`);
        return renderPane();
      }
      case "tpl-pick":
      case "ata-prompt":
        return;
      case "tpl-import":
        return document.getElementById("tpl-file")?.click();
      case "tpl-new":
        state.tplEdit = { id: "", name: "", text: "" };
        return renderDrawer();
      case "tpl-edit":
        state.tplEdit = { ...templates().find((t) => t.id === el.dataset.id) };
        return renderDrawer();
      case "tpl-del": {
        const t = templates().find((x) => x.id === el.dataset.id);
        const ok = await askChoice(el, { title: `Apagar "${t?.name}"?`, text: "As atas já geradas continuam como estão.", choices: [{ key: "del", label: "Apagar", primary: true }, { key: "cancel", label: "Cancelar" }] });
        if (ok !== "del") return;
        saveTemplates(templates().filter((x) => x.id !== el.dataset.id));
        if (m?.doc.ataTemplateId === el.dataset.id) await saveDoc((d) => (d.ataTemplateId = null));
        renderDrawer();
        return renderPane();
      }
      case "tpl-save": {
        const name = document.getElementById("tpl-name").value.trim() || "Modelo";
        const text = document.getElementById("tpl-text").value.trim();
        if (!text) return toast("Cole ou escreva o modelo antes de salvar.");
        const list = templates();
        const id = state.tplEdit?.id || Date.now().toString(36);
        const i = list.findIndex((t) => t.id === id);
        const item = { id, name, text: text.slice(0, 24000), updatedAt: Date.now() };
        if (i >= 0) list[i] = item; else list.push(item);
        saveTemplates(list);
        state.tplEdit = null;
        renderDrawer();
        toast("Modelo salvo");
        return renderPane();
      }
      case "tpl-cancel":
        state.tplEdit = null;
        return renderDrawer();
      case "sl-gen":
        return generateSlides();
      case "sl-open":
        return openSlides();
      case "sl-present":
        return openSlides({ present: true });
      case "sl-pptx":
        return downloadPptx(cleanDeck(m.doc.slides), m.doc, {});
      case "sl-pdf":
        return printDeck(cleanDeck(m.doc.slides), m.doc, {});
      case "sl-pal":
        slideOpts();
        slideUi.instructions = $("sl-inst")?.value || slideUi.instructions;
        if (paletteClick(el, slideUi)) renderPane();
        return;
      case "sl-again":
        slideUi.form = true;
        return renderPane();
      case "sl-cancel":
        slideUi.form = false;
        return renderPane();
      case "sl-clear":
        if (!confirm("Apagar os slides desta reunião? A transcrição e a ata continuam.")) return;
        await saveDoc((doc) => { doc.slides = null; });
        return renderPane();
      case "quick":
        return askMeeting(el.dataset.q);
      case "ask":
        return askMeeting($("ask-input").value);
      case "askall":
        return askAll();
      case "ai-stop":
        state.aiStop?.abort();
        return;
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
      case "trial": {
        el.disabled = true;
        state.me = await api.post("/billing/trial").catch((err) => {
          el.disabled = false;
          throw err;
        });
        renderCredits();
        toast(`Teste grátis começou: o Pro está liberado até ${dateTimeShort(state.me.trial.endsAt)}`);
        return renderAccount(new URLSearchParams());
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
