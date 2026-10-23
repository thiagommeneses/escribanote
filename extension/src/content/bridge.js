// Content script (isolated world): recebe eventos dos coletores do main world,
// aplica consentimento/pausa, agrupa em lotes e envia ao service worker.
// No Meet também liga as legendas, pode ocultá-las e tem um plano B por DOM.
// Expõe window.__escribanoteBus para o widget (mesmo isolated world).
(() => {
  "use strict";
  if (window.__escribanoteBus) return;

  const host = location.host;
  const platform = host === "meet.google.com" ? "meet" : /zoom\.us$/.test(host) ? "zoom" : "teams";
  const isTop = window.top === window;
  // Só o Zoom roda a reunião dentro de um iframe; nos outros, iframes não interessam.
  if (!isTop && platform !== "zoom") return;

  const bus = new EventTarget();
  window.__escribanoteBus = bus;
  const state = {
    platform,
    consent: null, // null = ainda não decidido, true/false
    paused: false,
    captionsSeen: false,
    stage: "unknown", // "prejoin" | "meeting" | "left" (Meet; pelos botões da tela)
    ended: false, // transcrição encerrada (botão do widget ou saída da chamada); nada mais é enviado
    uiLang: null, // idioma da interface do Meet, lido dos rótulos dos botões
    captionsOn: null, // true/false quando dá para saber pelo botão de legendas
    settings: { mode: "always", widget: true, hideCaptions: true, autoCaptions: true, domFallback: true, notifyMessage: "" },
  };
  bus.state = state;
  const emitState = () => bus.dispatchEvent(new CustomEvent("state"));

  function meetingKey() {
    if (platform === "meet") {
      const m = location.pathname.match(/[a-z]{3}-[a-z]{4}-[a-z]{3}/);
      return m ? `meet:${m[0]}` : null;
    }
    if (platform === "zoom") {
      const m = location.pathname.match(/\/(?:wc|j)\/(\d{6,})/);
      return m ? `zoom:${m[1]}` : `zoom:${location.pathname}`;
    }
    return `teams:${location.pathname}${location.hash.split("?")[0]}`;
  }
  bus.meetingKey = meetingKey;

  function meetingTitle() {
    const t = document.title.replace(/^Meet\s*[-–:]\s*/i, "").replace(/\s*\|\s*Microsoft Teams$/i, "").trim();
    if (!t || /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(t) || /^(Meet|Google Meet|Zoom|Microsoft Teams)$/i.test(t)) return null;
    return t;
  }

  // ---------- Configurações, consentimento e pausa ----------
  async function loadSettings() {
    const { settings } = await chrome.storage.local.get("settings");
    Object.assign(state.settings, settings);
    if (state.settings.mode === "always") state.consent = true;
    else if (state.settings.mode === "off") state.consent = false;
    else if (state.consent === null) {
      const key = meetingKey();
      state.consent = key ? await chrome.runtime.sendMessage({ type: "consent-get", key }).catch(() => null) : null;
    }
    applyCaptionVisibility();
    emitState();
    if (state.consent) flush();
  }
  loadSettings();
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.settings) {
      if (ch.settings.newValue?.mode !== ch.settings.oldValue?.mode) state.consent = null;
      loadSettings();
    }
  });

  bus.decide = async (value, remember) => {
    state.consent = value;
    const key = meetingKey();
    if (key) await chrome.runtime.sendMessage({ type: "consent-set", key, value }).catch(() => {});
    if (remember) {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, mode: value ? "always" : "off" } });
    }
    if (!value) pending = [];
    applyCaptionVisibility();
    emitState();
    flush();
  };

  // Botão "Encerrar transcrição" do widget (vale para Meet, Teams e Zoom): fecha a sessão agora,
  // como sair da chamada; o que vier depois é ignorado até a pessoa retomar.
  bus.endSession = async () => {
    flush();
    state.ended = true;
    pending = [];
    emitState();
    await chrome.runtime.sendMessage({ type: "meeting-left" }).catch(() => {});
  };
  bus.resumeSession = () => {
    state.ended = false;
    emitState();
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "session-updated" && typeof msg.paused === "boolean" && msg.paused !== state.paused) {
      state.paused = msg.paused;
      emitState();
    }
    bus.dispatchEvent(new CustomEvent("message", { detail: msg }));
  });

  // ---------- Fila de eventos ----------
  // Antes do consentimento os eventos ficam retidos em memória (até 5000) e só
  // são enviados se a pessoa aceitar transcrever.
  let pending = [];
  let flushTimer = null;

  function enqueue(ev) {
    if (state.consent === false || state.paused || state.ended) return;
    pending.push(ev);
    if (pending.length > 5000) pending.splice(0, pending.length - 5000);
    if (state.consent && !flushTimer) flushTimer = setTimeout(flush, 600);
  }

  function flush() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const key = meetingKey();
    if (!state.consent || !pending.length || !key) return;
    const events = pending;
    pending = [];
    chrome.runtime
      .sendMessage({
        type: "events",
        meeting: { key, platform, url: location.origin + location.pathname, title: meetingTitle() },
        events,
      })
      .catch(() => {
        // Service worker reiniciando: devolve para a fila e tenta de novo.
        pending = events.concat(pending);
        if (!flushTimer) flushTimer = setTimeout(flush, 1500);
      });
  }

  let lastCaptionAt = 0;
  let lastProtocolCaption = 0;
  document.addEventListener("escribanote:evt", (e) => {
    let ev;
    try {
      ev = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (ev.kind === "protocol-health") {
      lastProtocolCaption = Math.max(lastProtocolCaption, ev.lastProtocolCaption || 0);
      return;
    }
    if (ev.kind === "status") return;
    if (ev.kind === "channel-closed") return onCaptionsChannelClosed();
    if (ev.kind === "channel-open") return;
    if (ev.kind === "speaker" && ev.speakerId && ev.name) namedIds.add(ev.speakerId);
    if (ev.kind === "caption") {
      lastCaptionAt = Date.now();
      if (ev.source === "protocol") {
        lastProtocolCaption = lastCaptionAt;
        rememberProtocolCaption(ev);
      }
      if (!state.captionsSeen) {
        state.captionsSeen = true;
        emitState();
      }
    }
    enqueue(ev);
  });

  // ---------- Nomes dos falantes: protocolo × tela ----------
  // O protocolo identifica cada fala por deviceId; o nome vem do canal "collections", que às vezes
  // não chega (ou chega só para quem entrou depois). A legenda na tela mostra nome + texto: casando
  // o texto, descobrimos o nome do deviceId. O nome do protocolo, quando existe, tem prioridade.
  const namedIds = new Set();
  const recentProto = []; // {speakerId, text, at}
  const recentDom = []; // {name, text, at}
  const normText = (t) => (t || "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
  function sameUtterance(a, b) {
    const x = normText(a);
    const y = normText(b);
    if (x.length < 8 || y.length < 8) return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }
  function rememberProtocolCaption(ev) {
    if (namedIds.has(ev.speakerId)) return;
    const i = recentProto.findIndex((p) => p.id === ev.id);
    const item = { id: ev.id, speakerId: ev.speakerId, text: ev.text, at: Date.now() };
    if (i >= 0) recentProto[i] = item;
    else recentProto.push(item);
    if (recentProto.length > 30) recentProto.shift();
    matchNames();
  }
  function rememberDomCaption(name, text) {
    const i = recentDom.findIndex((d) => d.name === name && sameUtterance(d.text, text));
    const item = { name, text, at: Date.now() };
    if (i >= 0) recentDom[i] = item;
    else recentDom.push(item);
    if (recentDom.length > 30) recentDom.shift();
    matchNames();
  }
  function matchNames() {
    for (const p of recentProto) {
      if (namedIds.has(p.speakerId)) continue;
      const hit = recentDom.find((d) => Math.abs(d.at - p.at) < 15_000 && sameUtterance(d.text, p.text));
      if (!hit) continue;
      namedIds.add(p.speakerId);
      enqueue({ kind: "speaker", platform, speakerId: p.speakerId, name: hit.name, source: "dom", weak: true });
    }
    for (let i = recentProto.length - 1; i >= 0; i--) if (namedIds.has(recentProto[i].speakerId)) recentProto.splice(i, 1);
  }

  // Encerramento: o service worker fecha a sessão (e pode gerar a ata automática).
  window.addEventListener("pagehide", () => {
    flush();
    if (isTop) chrome.runtime.sendMessage({ type: "meeting-left" }).catch(() => {});
  });

  // ---------- Legendas nativas ----------
  const CAPTION_REGION =
    '[role="region"][aria-label*="egenda" i], [role="region"][aria-label*="aption" i], [role="region"][aria-label*="ubt" i]';
  let hideStyle = null;

  // Esconde as legendas do Meet sem desligá-las (elas continuam alimentando a transcrição).
  function applyCaptionVisibility() {
    if (platform !== "meet") return;
    const want = state.settings.hideCaptions && state.settings.widget && state.consent !== false;
    if (want && !hideStyle) {
      hideStyle = document.createElement("style");
      hideStyle.id = "escribanote-hide-captions";
      hideStyle.textContent = `${CAPTION_REGION} { opacity: 0 !important; pointer-events: none !important;
        position: fixed !important; left: -10000px !important; top: 0 !important; }`;
      (document.head || document.documentElement).append(hideStyle);
    } else if (!want && hideStyle) {
      hideStyle.remove();
      hideStyle = null;
    }
  }
  bus.setCaptionsHidden = async (hidden) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, hideCaptions: hidden } });
  };

  if (platform !== "meet") return;

  // ---------- Google Meet: rótulos da interface por idioma ----------
  // O Meet gera as legendas no idioma da interface; e os botões (ligar/desligar legendas, sair)
  // dizem em que idioma ela está e em que estágio a reunião está. Rótulos observados no Meet.
  const MEET_UI = {
    pt: { on: /^(ativar|mostrar) legendas/i, off: /^(desativar|ocultar) legendas/i, leave: /^sair da chamada/i },
    en: { on: /^turn on captions/i, off: /^turn off captions/i, leave: /^leave call/i },
    es: { on: /^(activar|mostrar) subtítulos/i, off: /^(desactivar|ocultar) subtítulos/i, leave: /^salir de la llamada/i },
    fr: { on: /^activer les sous-titres/i, off: /^désactiver les sous-titres/i, leave: /^quitter l'appel/i },
    de: { on: /^untertitel aktivieren/i, off: /^untertitel deaktivieren/i, leave: /^anruf verlassen/i },
    it: { on: /^attiva (i )?sottotitoli/i, off: /^disattiva (i )?sottotitoli/i, leave: /^abbandona la chiamata/i },
  };
  const buttons = () => [...document.querySelectorAll("button[aria-label]")];
  const findButton = (key) => {
    for (const [lang, rx] of Object.entries(MEET_UI)) {
      const b = buttons().find((el) => rx[key].test(el.ariaLabel));
      if (b) return { lang, button: b };
    }
    return null;
  };

  function inCall() {
    return !!findButton("leave");
  }
  bus.inCall = inCall;

  // Lê idioma da interface e estado das legendas pelos botões presentes.
  function readMeetUi() {
    const leave = findButton("leave");
    const on = findButton("on");
    const off = findButton("off");
    const lang = (leave || off || on)?.lang || null;
    if (lang && lang !== state.uiLang) {
      state.uiLang = lang;
      enqueue({ kind: "ui-lang", platform, lang });
      emitState();
    }
    const captionsOn = off ? true : on ? false : null;
    if (captionsOn !== state.captionsOn) {
      state.captionsOn = captionsOn;
      emitState();
    }
    return { leave, on, off };
  }

  // Estágio: entrou na chamada / saiu. Sair do Meet não descarrega a página, então sem isto a
  // sessão só terminaria 30 min depois. Se a pessoa volta na mesma aba, a reunião continua
  // (menos de 10 min) ou vira uma nova parte.
  let leftAt = null;
  const LEFT_GRACE_MS = 20_000;
  function trackStage(ui) {
    const now = Date.now();
    if (ui.leave) {
      if (state.stage !== "meeting") {
        if (state.stage === "left") state.ended = false; // voltou à chamada: transcreve de novo
        state.stage = "meeting";
        leftAt = null;
        autoClicks = 0;
        emitState();
      }
      return;
    }
    if (state.stage === "meeting") {
      leftAt ||= now;
      if (now - leftAt >= LEFT_GRACE_MS) {
        state.stage = "left";
        leftAt = null;
        state.ended = true;
        flush();
        if (isTop) chrome.runtime.sendMessage({ type: "meeting-left" }).catch(() => {});
        emitState();
      }
    } else if (state.stage === "unknown") {
      state.stage = "prejoin";
    }
  }

  // Religa as legendas quando o Meet as perde (canal fechado numa reconexão, alguém desligou).
  // Orçamento: até 3 cliques por "perda", no máximo 12 por página.
  let autoClicks = 0;
  let totalClicks = 0;
  let retryAfter = 0;
  function onCaptionsChannelClosed() {
    autoClicks = 0;
    lastCaptionAt = 0;
    retryAfter = Date.now() + 5000;
  }
  function tryEnableCaptions(ui) {
    if (!state.consent || state.paused || !state.settings.autoCaptions || autoClicks >= 3 || totalClicks >= 12) return;
    if (Date.now() < retryAfter || Date.now() - lastCaptionAt < 30_000 || !ui.leave) return;
    if (ui.on) {
      autoClicks++;
      totalClicks++;
      ui.on.button.click();
    }
  }

  const blockIds = new WeakMap();
  const blockVersions = new WeakMap();
  let blockSeq = 0;

  function scrapeDom(namesOnly = false) {
    const region = document.querySelector(CAPTION_REGION);
    if (!region) return;
    // Uma fala é o menor <div> cujo innerText tem "Nome\ntexto…".
    const linesOf = (el) => (el.innerText || "").split("\n").map((t) => t.trim()).filter(Boolean);
    for (const block of region.querySelectorAll("div")) {
      const lines = linesOf(block);
      if (lines.length < 2 || lines[0].length > 80) continue;
      if ([...block.children].some((c) => linesOf(c).length >= 2)) continue;
      const name = lines[0];
      const text = lines.slice(1).join(" ");
      if (namesOnly) {
        rememberDomCaption(name, text);
        continue;
      }
      if (!blockIds.has(block)) blockIds.set(block, `dom/${Date.now()}/${++blockSeq}`);
      if (blockVersions.get(block) === text) continue;
      blockVersions.set(block, text);
      enqueue({
        kind: "caption",
        platform: "meet",
        source: "dom",
        id: blockIds.get(block),
        speakerId: `dom:${name}`,
        speakerName: name,
        version: Date.now(),
        text,
      });
    }
  }

  setInterval(() => {
    document.dispatchEvent(new CustomEvent("escribanote:ping"));
    const ui = readMeetUi();
    trackStage(ui);
    tryEnableCaptions(ui);
    // Só usa o DOM se o protocolo nunca entregou legendas nesta página (evita duplicatas).
    if (state.consent !== false && state.settings.domFallback && lastProtocolCaption === 0) scrapeDom();
    // Com o protocolo ativo, a tela serve só para descobrir nomes que o protocolo não trouxe.
    else if (state.consent && recentProto.length) scrapeDom(true);
  }, 1500);
})();
