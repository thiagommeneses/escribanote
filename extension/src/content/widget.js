// Widget flutuante dentro da reunião (isolated world, Shadow DOM).
// Depende do window.__escribanoteBus criado por bridge.js.
(() => {
  "use strict";
  if (window.top !== window || window.__escribanoteWidget) return;
  window.__escribanoteWidget = true;
  const bus = window.__escribanoteBus;
  if (!bus) return;
  const state = bus.state;

  const TAGS_FALLBACK = [
    { id: "importante", label: "Importante", emoji: "⭐" },
    { id: "decisao", label: "Decisão", emoji: "✅" },
    { id: "acao", label: "Ação", emoji: "📌" },
    { id: "pergunta", label: "Pergunta", emoji: "❓" },
    { id: "risco", label: "Risco", emoji: "⚠️" },
  ];
  const QUICK = [
    ["Pontos principais", "Quais são os pontos principais discutidos até agora?"],
    ["Itens de ação", "Liste os itens de ação até agora, com responsável e prazo quando mencionados."],
    ["3 perguntas", "Sugira 3 perguntas pertinentes que eu poderia fazer agora, com base no que foi dito."],
    ["O que perdi?", "Resuma em 3 tópicos curtos o que foi dito nos últimos minutos."],
  ];
  const COLORS = ["#60a5fa", "#4ade80", "#fbbf24", "#f472b6", "#a78bfa", "#22d3ee", "#f87171", "#a3e635"];

  const ICON = {
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
    note: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.4-1"/>',
    megaphone: '<path d="M3 10v4h4l7 4V6L7 10z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
    open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v6H4V6h6"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    min: '<path d="M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  };
  const svg = (name, size = 16) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const colorFor = (id) => {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const send = (msg) => chrome.runtime.sendMessage(msg);

  // ---------- Montagem ----------
  const hostEl = document.createElement("escribanote-widget");
  hostEl.style.cssText = "all: initial; position: fixed; z-index: 2147483000; right: 16px; bottom: 96px;";
  const root = hostEl.attachShadow({ mode: "closed" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .card { width: 360px; max-height: min(560px, 70vh); display: flex; flex-direction: column;
      background: rgba(24,25,29,.96); color: #e8eaed; border: 1px solid rgba(255,255,255,.08);
      border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden; font-size: 13px; line-height: 1.45;
      backdrop-filter: blur(12px); }
    .card[hidden], .pill[hidden] { display: none; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; cursor: grab; user-select: none;
      border-bottom: 1px solid rgba(255,255,255,.06); }
    header:active { cursor: grabbing; }
    .brand { font-weight: 600; letter-spacing: .2px; }
    .rec { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #9aa0a6; font-variant-numeric: tabular-nums; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #5f6368; }
    .dot.on { background: #f28b82; box-shadow: 0 0 0 0 rgba(242,139,130,.6); animation: pulse 1.8s infinite; }
    .dot.paused { background: #fdd663; }
    @keyframes pulse { 70% { box-shadow: 0 0 0 7px rgba(242,139,130,0); } 100% { box-shadow: 0 0 0 0 rgba(242,139,130,0); } }
    .spacer { flex: 1; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    .ib { width: 32px; height: 32px; border-radius: 50%; display: inline-grid; place-items: center; color: #bdc1c6; }
    .ib:hover { background: rgba(255,255,255,.08); color: #fff; }
    .ib.active { color: #8ab4f8; }
    .ib:disabled { opacity: .35; cursor: default; background: none; }
    .body { flex: 1; overflow-y: auto; padding: 6px 4px 6px 14px; scrollbar-width: thin; scrollbar-color: #5f6368 transparent; }
    .blk { position: relative; padding: 7px 10px 7px 0; border-radius: 8px; }
    .blk .who { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
    .blk .who b { font-weight: 600; cursor: pointer; border-bottom: 1px dotted transparent; }
    .blk .who b:hover { border-bottom-color: currentColor; }
    .rn { display: inline-flex; gap: 4px; align-items: center; }
    .rn input { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.25); border-radius: 6px; color: #e8eaed; font: inherit; font-size: 12px; padding: 2px 6px; width: 140px; outline: none; }
    .rn input:focus { border-color: #8ab4f8; }
    .rn button { padding: 1px 6px; border-radius: 6px; font-size: 12px; background: rgba(255,255,255,.1); color: #e8eaed; }
    .blk .who time { color: #9aa0a6; font-size: 11px; }
    .blk .tags { margin-left: auto; font-size: 12px; }
    .blk p { margin: 1px 0 0; color: #e8eaed; word-wrap: break-word; }
    .blk .acts { position: absolute; right: 6px; top: 2px; display: none; gap: 2px; background: #2d2e33; border-radius: 999px; padding: 2px 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,.4); }
    .blk:hover .acts { display: flex; }
    .acts button { padding: 2px 4px; border-radius: 6px; font-size: 13px; opacity: .55; }
    .acts button.on, .acts button:hover { opacity: 1; background: rgba(255,255,255,.08); }
    .center { text-align: center; padding: 18px 10px 18px 0; color: #bdc1c6; }
    .center h4 { margin: 0 0 6px; font-size: 14px; color: #fff; font-weight: 600; }
    .row { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; margin-top: 10px; }
    .btn { padding: 7px 14px; border-radius: 999px; background: rgba(255,255,255,.08); color: #e8eaed; font-weight: 500; }
    .btn:hover { background: rgba(255,255,255,.14); }
    .btn.primary { background: #8ab4f8; color: #202124; }
    .btn.primary:hover { background: #aecbfa; }
    .share { margin: 0 14px; padding: 8px 0 2px; font-size: 12px; color: #bdc1c6; }
    .bar { position: relative; height: 6px; background: rgba(255,255,255,.08); border-radius: 999px; margin-top: 4px; overflow: hidden; }
    .bar i { position: absolute; inset: 0 auto 0 0; background: #8ab4f8; border-radius: 999px; }
    .bar s { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #fdd663; }
    .bar.over i { background: #fdd663; }
    .panel { border-top: 1px solid rgba(255,255,255,.06); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .panel[hidden] { display: none; }
    .input { display: flex; gap: 6px; align-items: center; background: rgba(255,255,255,.06); border-radius: 12px; padding: 2px 4px 2px 10px; }
    .input input { flex: 1; min-width: 0; background: none; border: 0; outline: none; color: #e8eaed; font: inherit; padding: 6px 0; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); color: #bdc1c6; }
    .chip:hover { border-color: #8ab4f8; color: #fff; }
    .answer { max-height: 200px; overflow-y: auto; background: rgba(138,180,248,.08); border-radius: 10px; padding: 8px 10px; white-space: pre-wrap; }
    .answer:empty { display: none; }
    footer { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-top: 1px solid rgba(255,255,255,.06); }
    .toast { position: absolute; left: 50%; top: 56px; transform: translateX(-50%); background: #e8eaed; color: #202124;
      padding: 6px 12px; border-radius: 8px; font-size: 12px; white-space: nowrap; opacity: 0; transition: opacity .2s; pointer-events: none; }
    .toast.show { opacity: 1; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; background: rgba(24,25,29,.96);
      color: #e8eaed; border: 1px solid rgba(255,255,255,.1); box-shadow: 0 6px 20px rgba(0,0,0,.4); font-size: 13px; cursor: pointer; }
    .muted { color: #9aa0a6; }
    .badge { font-size: 11px; opacity: .8; }
    .hqchip { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: rgba(129,201,149,.16); color: #81c995; }
    .banner { margin: 4px 10px 6px 0; padding: 7px 10px; border-radius: 10px; background: rgba(138,180,248,.1); color: #d2e3fc; font-size: 12px; }
    .banner.warn { background: rgba(253,214,99,.12); color: #fde293; }
  </style>
  <div class="pill" id="pill" hidden><span class="dot" id="pdot"></span><b>Escribanote</b><span class="muted" id="ptime"></span></div>
  <div class="card" id="card" style="position:relative">
    <header id="drag">
      <span class="dot" id="dot"></span>
      <span class="brand">Escribanote</span>
      <span class="rec" id="rec"></span>
      <span class="hqchip" id="hqchip" hidden title="Alta precisão ativa: Whisper rodando neste computador">🎧 HQ</span>
      <span class="spacer"></span>
      <button class="ib" id="pause" title="Pausar transcrição"></button>
      <button class="ib" id="end" title="Encerrar transcrição (salva a reunião e abre o pós-reunião, se configurado)">${svg("stop")}</button>
      <button class="ib" id="min" title="Minimizar">${svg("min")}</button>
    </header>
    <div class="body" id="body"></div>
    <div class="share" id="share" hidden></div>
    <div class="panel" id="note-panel" hidden>
      <div class="input"><input id="note-input" placeholder="Escreva uma nota com o horário atual…" maxlength="2000">
        <button class="ib" id="note-send" title="Salvar nota">${svg("send")}</button></div>
    </div>
    <div class="panel" id="ai-panel" hidden>
      <div class="chips" id="ai-chips"></div>
      <div class="answer" id="ai-answer"></div>
      <div class="input"><input id="ai-input" placeholder="Pergunte sobre a reunião…" maxlength="2000">
        <button class="ib" id="ai-send" title="Perguntar">${svg("send")}</button></div>
    </div>
    <footer>
      <button class="ib" id="hl" title="Destacar o último bloco (Alt+Shift+H)">${svg("star")}</button>
      <button class="ib" id="note" title="Adicionar nota">${svg("note")}</button>
      <button class="ib" id="shot" title="Capturar a tela (Alt+Shift+S)">${svg("camera")}</button>
      <button class="ib" id="ai" title="Pergunte à IA">${svg("spark")}</button>
      <span class="spacer"></span>
      <button class="ib" id="caps" title="Mostrar/ocultar legendas nativas"></button>
      <button class="ib" id="notify" title="Avisar os participantes">${svg("megaphone")}</button>
      <button class="ib" id="open" title="Abrir no Escribanote">${svg("open")}</button>
    </footer>
    <div class="toast" id="toast"></div>
  </div>`;
  const $ = (id) => root.getElementById(id);

  let session = null; // visão calculada pelo service worker (my-view)
  let minimized = false;
  let shown = false;
  let follow = true;
  let renaming = null; // { speakerId, name } enquanto o usuário edita um nome no bloco
  let chatId = null;
  let aiPort = null;

  function toast(text) {
    const t = $("toast");
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------- Posição (arrastar) ----------
  chrome.storage.local.get(["widgetPos", "widgetMin"]).then(({ widgetPos, widgetMin }) => {
    if (widgetPos) Object.assign(hostEl.style, { right: widgetPos.right + "px", bottom: widgetPos.bottom + "px" });
    minimized = !!widgetMin;
    render();
  });
  for (const handle of [$("drag"), $("pill")]) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const r0 = parseInt(hostEl.style.right, 10);
      const b0 = parseInt(hostEl.style.bottom, 10);
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
        hostEl.style.right = Math.min(Math.max(0, r0 - dx), innerWidth - 120) + "px";
        hostEl.style.bottom = Math.min(Math.max(0, b0 - dy), innerHeight - 48) + "px";
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        chrome.storage.local.set({ widgetPos: { right: parseInt(hostEl.style.right, 10), bottom: parseInt(hostEl.style.bottom, 10) } });
        if (!moved && handle === $("pill")) setMin(false);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
  }

  function setMin(v) {
    minimized = v;
    chrome.storage.local.set({ widgetMin: v });
    render();
  }
  $("min").addEventListener("click", () => setMin(true));

  // ---------- Dados ----------
  let fetchTimer = null;
  function refresh() {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(async () => {
      const s = await send({ type: "my-view" }).catch(() => null);
      session = s && !s.error ? s : null;
      if (session) state.paused = session.paused;
      render();
    }, 300);
  }
  bus.addEventListener("state", render);
  bus.addEventListener("message", (e) => {
    const m = e.detail;
    if (m.type === "session-updated" || m.type === "hq-updated") refresh();
    if (m.type === "toast") {
      if (m.error) toast(m.error);
      else if (m.command === "highlight-last") toast("Destaque alternado ⭐");
      else if (m.command === "screenshot") toast("Captura salva 📷");
      else if (m.command === "toggle-pause") toast("Pausa alternada");
    }
  });
  refresh();

  function tags() {
    return state.settings.tags && state.settings.tags.length ? state.settings.tags : TAGS_FALLBACK;
  }

  const LANG = { pt: "português", en: "inglês", es: "espanhol", fr: "francês", de: "alemão", it: "italiano" };

  function shareHtml() {
    const sh = session.share;
    if (!sh) return "";
    if (!sh.me) return `Quem mais fala: <b>${esc(sh.name)}</b> · ${sh.pct}%`;
    const target = state.settings.talkTarget || 30;
    return `Sua parcela de fala: <b>${sh.pct}%</b> <span class="muted">· meta ${target}%</span>
      <div class="bar${sh.pct > target ? " over" : ""}"><i style="width:${Math.min(100, sh.pct)}%"></i><s style="left:${target}%"></s></div>`;
  }

  function bannerHtml() {
    const li = session.langIssue;
    if (li && li.source === "interface") {
      return `<div class="banner warn"><b>O Meet está em ${esc(LANG[li.seen] || li.seen)}</b>, e as legendas vêm no idioma da interface.
        Antes de começar, confira em <i>Mais opções › Configurações › Legendas › Idioma da reunião</i> → ${esc(LANG[li.expected] || li.expected)}.</div>`;
    }
    if (li) {
      return `<div class="banner warn"><b>As legendas estão em ${esc(LANG[li.seen] || li.seen)}.</b> A transcrição fica bem pior assim.
        No Meet: <i>Mais opções › Configurações › Legendas › Idioma da reunião</i> → ${esc(LANG[li.expected] || li.expected)}.</div>`;
    }
    const hq = session.hq || {};
    if (hq.state === "loading") return `<div class="banner">🎧 Baixando o modelo de alta precisão… ${hq.progress || 0}%</div>`;
    if (hq.state === "error") return `<div class="banner warn">🎧 ${esc(hq.message || "Erro no modo de alta precisão")}</div>`;
    if (hq.warning) return `<div class="banner">${esc(hq.warning)}</div>`;
    return "";
  }

  // ---------- Renderização ----------
  function shouldShow() {
    if (!state.settings.widget) return false;
    if (session) return true;
    if (state.platform === "meet") return !!(bus.inCall && bus.inCall()) || state.captionsSeen;
    if (state.platform === "slack") return state.stage === "meeting" || !!(bus.inCall && bus.inCall());
    return state.captionsSeen;
  }

  function render() {
    const visible = shouldShow();
    if (visible && !shown) {
      document.documentElement.append(hostEl);
      shown = true;
    } else if (!visible && shown) {
      hostEl.remove();
      shown = false;
    }
    if (!visible) return;

    const live = state.consent && !state.paused;
    const elapsed = session ? clock(Date.now() - session.startedAt) : "";
    for (const id of ["dot", "pdot"]) {
      $(id).className = "dot" + (state.paused ? " paused" : live && session ? " on" : "");
    }
    $("rec").textContent = state.paused ? "Pausado" : session && live ? elapsed : "";
    $("ptime").textContent = state.paused ? "pausado" : elapsed;
    $("pause").innerHTML = svg(state.paused ? "play" : "pause");
    $("pause").title = state.paused ? "Retomar transcrição (Alt+Shift+P)" : "Pausar transcrição (Alt+Shift+P)";
    $("pause").disabled = !session;
    $("end").disabled = !session || state.ended;
    $("hqchip").hidden = !(session && session.hq && session.hq.state === "running");
    const hidden = state.settings.hideCaptions;
    $("caps").innerHTML = svg(hidden ? "eyeOff" : "eye");
    $("caps").title = hidden ? "Mostrar legendas nativas" : "Ocultar legendas nativas";
    $("caps").hidden = state.platform !== "meet";
    $("pill").hidden = !minimized;
    $("card").hidden = minimized;
    if (minimized) return;

    const body = $("body");
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;

    if (state.consent === null && state.settings.mode === "ask") {
      body.innerHTML = `<div class="center"><h4>Transcrever esta reunião?</h4>
        <div>A transcrição fica salva só neste computador.</div>
        <div class="row"><button class="btn primary" data-consent="once">Sim, desta vez</button>
        <button class="btn" data-consent="always">Sim, sempre</button><button class="btn" data-consent="no">Não</button></div></div>`;
    } else if (state.ended) {
      body.innerHTML = `<div class="center"><h4>Transcrição encerrada</h4><div>A reunião ficou salva. O que for dito agora não entra.</div>
        <div class="row"><button class="btn primary" data-resume="1">Voltar a transcrever</button></div></div>`;
    } else if (state.consent === false) {
      body.innerHTML = `<div class="center"><h4>Transcrição desligada</h4><div>Nada desta reunião está sendo salvo.</div>
        <div class="row"><button class="btn primary" data-consent="once">Transcrever esta reunião</button></div></div>`;
    } else if (state.platform === "slack" && (!session || !session.count)) {
      const hq = (session && session.hq) || { state: "idle" };
      const running = ["running", "loading", "starting"].includes(hq.state);
      body.innerHTML = (session ? bannerHtml() : "") + `<div class="center"><h4>Huddle do Slack</h4>
        <div>${running ? (hq.state === "running" ? "Ouvindo o huddle. A transcrição aparece aqui assim que alguém falar." : `Preparando o reconhecimento… ${hq.progress || 0}%`) : "O áudio deste huddle é transcrito aqui, no seu computador, e não sai dele."}</div>
        ${running ? "" : '<div class="row"><button class="btn primary" data-hq="start">Transcrever este huddle</button></div>'}
        <div class="muted" id="hq-hint" style="margin-top:8px;font-size:12px">${state.hqHint ? esc(state.hqHint) : ""}</div></div>`;
    } else if (!session || !session.count) {
      const hint = state.platform === "meet"
        ? "As legendas são ligadas automaticamente. Comece a falar para ver a transcrição aqui."
        : "Ative as legendas ao vivo na reunião. A transcrição aparece aqui assim que alguém falar.";
      body.innerHTML = (session ? bannerHtml() : "") + `<div class="center"><h4>${state.paused ? "Transcrição pausada" : "Ouvindo…"}</h4><div>${hint}</div></div>`;
    } else if (renaming) {
      // Não redesenha enquanto o nome está sendo editado (a transcrição ao vivo chega a cada segundo).
    } else {
      const t = tags();
      body.innerHTML = bannerHtml() + session.blocks
        .map((b) => `<div class="blk" data-ids="${esc(JSON.stringify(b.ids))}" data-tags="${esc(JSON.stringify(b.tags))}">
          <div class="who"><b style="color:${colorFor(b.speaker)}" data-speaker="${esc(b.speakerId)}" title="Clique para renomear">${esc(b.speaker)}</b>
            <time>${clock(b.startAt - session.startedAt)}</time>${b.kind === "chat" ? '<span class="muted">chat</span>' : ""}
            ${b.hq ? '<span class="badge" title="Transcrito pelo modo de alta precisão">🎧</span>' : ""}${b.fixed ? `<span class="badge" title="Revisado pela IA. Original: ${esc(b.original)}">✓</span>` : ""}
            <span class="tags">${b.tags.map((id) => (t.find((x) => x.id === id) || {}).emoji || "🏷").join(" ")}</span></div>
          <p>${esc(b.text)}</p>
          <div class="acts">${t.map((x) => `<button data-tag="${x.id}" class="${b.tags.includes(x.id) ? "on" : ""}" title="${esc(x.label)}">${x.emoji}</button>`).join("")}</div>
        </div>`)
        .join("");
      if (follow || atBottom) body.scrollTop = body.scrollHeight;
    }

    const share = session ? shareHtml() : "";
    $("share").hidden = !share;
    $("share").innerHTML = share;
    for (const id of ["hl", "note", "shot", "ai"]) $(id).disabled = !session;
  }
  setInterval(() => shown && !minimized && session && ($("rec").textContent = state.paused ? "Pausado" : clock(Date.now() - session.startedAt)), 1000);
  setInterval(() => !shown && render(), 2000);

  $("body").addEventListener("scroll", () => {
    const b = $("body");
    follow = b.scrollTop + b.clientHeight >= b.scrollHeight - 30;
  });

  // ---------- Ações ----------
  $("body").addEventListener("click", async (e) => {
    if (e.target.closest("[data-hq]")) {
      const r = await send({ type: "hq-start" }).catch((err) => ({ error: err.message }));
      state.hqHint = r && r.error ? r.error.replace(/^O Chrome só libera o áudio depois que você clica no ícone do Escribanote na aba da reunião\. Clique no ícone e tente de novo\.$/, "Toque no ícone do Escribanote na barra do Chrome (ou Alt+Shift+E) para liberar o áudio desta aba, e toque de novo em Transcrever.") : "";
      refresh();
      render();
      return;
    }
    if (e.target.closest("[data-resume]")) {
      bus.resumeSession();
      refresh();
      return;
    }
    const c = e.target.closest("[data-consent]");
    if (c) {
      const v = c.dataset.consent;
      await bus.decide(v !== "no", v === "always");
      return;
    }
    const who = e.target.closest("[data-speaker]");
    if (who && session && !renaming) {
      // Edição inline do nome do falante, direto no bloco (vale ao vivo).
      const speakerId = who.dataset.speaker;
      const current = who.textContent;
      renaming = { speakerId };
      const form = document.createElement("span");
      form.className = "rn";
      form.innerHTML = `<input maxlength="120" aria-label="Nome do participante"><button data-rn-ok>OK</button>`;
      const input = form.querySelector("input");
      input.value = current;
      who.replaceWith(form);
      const finish = async (save) => {
        if (!renaming) return;
        const name = input.value.trim();
        renaming = null;
        if (save && name && name !== current) {
          await send({ type: "update", id: session.id, speakers: { [speakerId]: name.slice(0, 120) } }).catch(() => {});
        }
        refresh();
        render();
      };
      form.querySelector("[data-rn-ok]").addEventListener("click", () => finish(true));
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") finish(true);
        if (ev.key === "Escape") finish(false);
        ev.stopPropagation();
      });
      input.addEventListener("keyup", (ev) => ev.stopPropagation());
      input.addEventListener("blur", () => setTimeout(() => finish(true), 150));
      input.focus();
      input.select();
      return;
    }
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn && session) {
      const blk = tagBtn.closest(".blk");
      const ids = JSON.parse(blk.dataset.ids);
      const current = JSON.parse(blk.dataset.tags);
      const tag = tagBtn.dataset.tag;
      const next = current.includes(tag) ? current.filter((x) => x !== tag) : [...current, tag];
      await send({ type: "tag-block", id: session.id, ids, tags: next });
      refresh();
    }
  });

  $("pause").addEventListener("click", async () => {
    if (!session) return;
    const r = await send({ type: "pause", id: session.id, paused: !state.paused });
    state.paused = r.paused;
    refresh();
    toast(state.paused ? "Transcrição pausada" : "Transcrição retomada");
    render();
  });

  $("end").addEventListener("click", async () => {
    if (!session) return;
    await bus.endSession();
    session = null;
    toast("Transcrição encerrada");
    render();
  });

  $("hl").addEventListener("click", async () => {
    const r = await send({ type: "highlight-last", tagId: "importante" });
    toast(r && r.tags && r.tags.includes("importante") ? "Último bloco destacado ⭐" : r ? "Destaque removido" : "Nada para destacar ainda");
  });

  function togglePanel(id, focus) {
    for (const p of ["note-panel", "ai-panel"]) $(p).hidden = p === id ? !$(p).hidden : true;
    $("note").classList.toggle("active", !$("note-panel").hidden);
    $("ai").classList.toggle("active", !$("ai-panel").hidden);
    if (!$(id).hidden) $(focus).focus();
  }

  $("note").addEventListener("click", () => togglePanel("note-panel", "note-input"));
  const saveNote = async () => {
    const text = $("note-input").value.trim();
    if (!text || !session) return;
    await send({ type: "add-note", id: session.id, text });
    $("note-input").value = "";
    toast("Nota salva 📝");
  };
  $("note-send").addEventListener("click", saveNote);
  $("note-input").addEventListener("keydown", (e) => e.key === "Enter" && saveNote());

  $("shot").addEventListener("click", async () => {
    // Esconde o próprio widget para ele não sair na captura.
    hostEl.style.visibility = "hidden";
    await new Promise((r) => setTimeout(r, 120));
    const r = await send({ type: "screenshot" }).catch((err) => ({ error: err.message }));
    hostEl.style.visibility = "";
    toast(r && r.error ? (/permission|activeTab|all_urls/i.test(r.error) ? "Use Alt+Shift+S ou autorize capturas em Ajustes" : r.error) : "Captura salva 📷");
  });

  $("ai-chips").innerHTML = QUICK.map(([label, q]) => `<button class="chip" data-q="${esc(q)}">${esc(label)}</button>`).join("");
  $("ai").addEventListener("click", () => togglePanel("ai-panel", "ai-input"));
  $("ai-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (b) ask(b.dataset.q);
  });
  $("ai-send").addEventListener("click", () => ask($("ai-input").value));
  $("ai-input").addEventListener("keydown", (e) => e.key === "Enter" && ask($("ai-input").value));

  function ask(question) {
    question = (question || "").trim();
    if (!question || !session) return;
    if (aiPort) aiPort.disconnect();
    $("ai-input").value = "";
    $("ai-answer").textContent = "Pensando…";
    aiPort = chrome.runtime.connect({ name: "ai" });
    aiPort.onMessage.addListener((m) => {
      if (m.type === "chat") chatId = m.chatId;
      if (m.type === "delta" || m.type === "done") $("ai-answer").textContent = m.text;
      if (m.type === "error") $("ai-answer").textContent = m.message;
      if (m.type === "done" || m.type === "error") {
        aiPort.disconnect();
        aiPort = null;
      }
    });
    aiPort.postMessage({ action: "chat", id: session.id, chatId, question });
  }

  $("caps").addEventListener("click", async () => {
    const hide = !state.settings.hideCaptions;
    await bus.setCaptionsHidden(hide);
    toast(hide ? "Legendas nativas ocultas (a transcrição continua)" : "Legendas nativas visíveis");
  });

  $("notify").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.settings.notifyMessage || "Estou transcrevendo esta reunião com o Escribanote.");
      toast("Aviso copiado — cole no chat da reunião");
    } catch {
      toast("Não foi possível copiar o aviso");
    }
  });

  $("open").addEventListener("click", () => send({ type: "open-app", id: session && session.id }));
})();
