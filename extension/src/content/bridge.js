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
    if (state.consent === false || state.paused) return;
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
    if (ev.kind === "caption") {
      lastCaptionAt = Date.now();
      if (ev.source === "protocol") lastProtocolCaption = lastCaptionAt;
      if (!state.captionsSeen) {
        state.captionsSeen = true;
        emitState();
      }
    }
    enqueue(ev);
  });

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

  // ---------- Google Meet: ligar legendas + plano B por DOM ----------
  const CAPTION_ON = /^(ativar legendas|turn on captions|activar subtítulos|mostrar legendas)/i;
  const LEAVE = /(sair da chamada|leave call|salir de la llamada)/i;
  let autoClicks = 0;

  function inCall() {
    return [...document.querySelectorAll("button[aria-label]")].some((b) => LEAVE.test(b.ariaLabel));
  }
  bus.inCall = inCall;

  function tryEnableCaptions() {
    if (!state.consent || state.paused || !state.settings.autoCaptions || autoClicks >= 3) return;
    if (Date.now() - lastCaptionAt < 30_000 || !inCall()) return;
    const btn = [...document.querySelectorAll("button[aria-label]")].find((b) => CAPTION_ON.test(b.ariaLabel));
    if (btn) {
      autoClicks++;
      btn.click();
    }
  }

  const blockIds = new WeakMap();
  const blockVersions = new WeakMap();
  let blockSeq = 0;

  function scrapeDom() {
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
    tryEnableCaptions();
    // Só usa o DOM se o protocolo nunca entregou legendas nesta página (evita duplicatas).
    if (state.consent !== false && state.settings.domFallback && lastProtocolCaption === 0) scrapeDom();
  }, 1500);
})();
