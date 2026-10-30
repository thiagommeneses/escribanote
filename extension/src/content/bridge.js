// Content script (isolated world): recebe eventos dos coletores do main world,
// aplica consentimento/pausa, agrupa em lotes e envia ao service worker.
// No Meet também liga as legendas, pode ocultá-las e tem um plano B por DOM.
// Expõe window.__escribanoteBus para o widget (mesmo isolated world).
(() => {
  "use strict";
  if (window.__escribanoteBus) return;

  const host = location.host;
  const platform = host === "meet.google.com" ? "meet" : host === "app.slack.com" ? "slack" : /zoom\.us$/.test(host) ? "zoom" : "teams";
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
    captionsStuck: false, // na chamada há um tempo e as legendas não ligaram (nem sozinhas, nem à mão)
    protocol: { connections: 0, connectionsSeen: false, lastConnectionAt: 0 }, // conexões WebRTC vistas pelo coletor (Meet)
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
    if (platform === "slack") return window.__escribanoteSlack?.key || null; // huddle detectado por slack.js
    return `teams:${location.pathname}${location.hash.split("?")[0]}`;
  }
  bus.meetingKey = meetingKey;

  function meetingTitle() {
    if (platform === "slack") return window.__escribanoteSlack?.title || null;
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
    await chrome.runtime.sendMessage({ type: "meeting-left", reason: "stop-widget" }).catch(() => {});
  };
  bus.resumeSession = () => {
    state.ended = false;
    emitState();
  };
  // Garante que a reunião exista no service worker antes de ligar a transcrição pelo áudio
  // (os resultados do Whisper só são guardados quando há uma sessão ativa para a aba).
  bus.ensureSession = () => {
    enqueue({ kind: "meeting-start", platform });
    flush();
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // O service worker só aplica uma versão nova quando nenhuma aba está numa reunião ou na sala de espera
    // do Meet ("prejoin" também vale para a página inicial do Meet e para o Slack aberto, que não contam).
    // Só responde quem está ocupado: as outras molduras da aba ficam em silêncio.
    if (msg.type === "busy?") {
      const lobby = platform === "meet" && state.stage === "prejoin" && /^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}\b/.test(location.pathname);
      const busy = state.stage === "meeting" || lobby || !!(bus.inCall && bus.inCall());
      if (!busy) return;
      sendResponse(true);
      return;
    }
    if (msg.type === "update-pending") {
      state.update = msg.version;
      emitState();
    }
    if (msg.type === "session-updated" && typeof msg.paused === "boolean" && msg.paused !== state.paused) {
      state.paused = msg.paused;
      emitState();
    }
    // Parar/retomar pedidos pelo painel do Escribanote ou pelo atalho de teclado.
    if (msg.type === "end-session") bus.endSession();
    if (msg.type === "resume-session") bus.resumeSession();
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
  let lastUndecoded = 0; // última mensagem de legenda (com texto) que o coletor não conseguiu decodificar
  document.addEventListener("escribanote:evt", (e) => {
    let ev;
    try {
      ev = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (ev.kind === "protocol-health") {
      lastProtocolCaption = Math.max(lastProtocolCaption, ev.lastProtocolCaption || 0);
      lastUndecoded = Math.max(lastUndecoded, ev.lastUndecoded || 0);
      if ("connections" in ev) state.protocol = { connections: ev.connections || 0, connectionsSeen: !!ev.connectionsSeen, lastConnectionAt: ev.lastConnectionAt || 0 };
      if (ev.channels) diag.channels = ev.channels;
      return;
    }
    if (ev.kind === "status") return;
    if (ev.kind === "channel-closed") return onCaptionsChannelClosed();
    if (ev.kind === "channel-open") return;
    if (ev.kind === "connections-closed") {
      // Saiu da chamada (ou caiu): não espera o próximo tique para começar a contar.
      state.protocol = { ...state.protocol, connections: 0, connectionsSeen: true };
      trackStage(readMeetUi());
      return;
    }
    if (ev.kind === "speaker" && ev.speakerId && ev.name) namedIds.add(ev.speakerId);
    if (ev.kind === "caption") {
      lastCaptionAt = Date.now();
      if (ev.source === "protocol") {
        lastProtocolCaption = lastCaptionAt;
        rememberProtocolCaption(ev);
        rememberLastProtocol(ev);
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
  // "Você"/"You" na legenda ou no bloco de vídeo é o próprio usuário; o nome está em data-self-name.
  const SELF_LABELS = new Set(["você", "voce", "you", "tú", "tu", "vous", "du", "sie", "io", "yo", "eu"]);
  const isSelfLabel = (s) => SELF_LABELS.has((s || "").trim().toLowerCase().replace(/[()]/g, ""));
  function selfName() {
    const el = document.querySelector("[data-self-name]");
    return ((el && el.getAttribute("data-self-name")) || state.settings.myName || "").trim();
  }
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
  // Últimas falas do protocolo (com ou sem nome). Ao sair da chamada o Meet fecha o canal na hora e a
  // última fala fica pela metade; a legenda que ainda estava na tela costuma ter o texto inteiro.
  const lastProto = []; // {id, speakerId, version, text, lang, at}
  function rememberLastProtocol(ev) {
    const i = lastProto.findIndex((p) => p.id === ev.id);
    const item = { id: ev.id, speakerId: ev.speakerId, version: ev.version || 0, text: ev.text, lang: ev.lang, at: Date.now() };
    if (i >= 0) lastProto[i] = item;
    else lastProto.push(item);
    if (lastProto.length > 12) lastProto.shift();
  }
  function complementFromScreen() {
    const now = Date.now();
    for (const p of lastProto) {
      if (now - p.at > 20_000) continue;
      const hit = recentDom.find((d) => now - d.at < 20_000 && d.text.length > p.text.length + 2 && normText(d.text).startsWith(normText(p.text)));
      if (!hit) continue;
      p.text = hit.text;
      enqueue({ kind: "caption", platform: "meet", source: "protocol", id: p.id, speakerId: p.speakerId, version: p.version + 1, text: hit.text, ...(p.lang ? { lang: p.lang } : {}) });
    }
  }
  function rememberDomCaption(name, text) {
    if (isSelfLabel(name)) name = selfName() || "Você";
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
    if (isTop) chrome.runtime.sendMessage({ type: "meeting-left", reason: "tab-closed" }).catch(() => {});
  });

  // ---------- Legendas nativas ----------
  const CAPTION_REGION =
    '[role="region"][aria-label*="egenda" i], [role="region"][aria-label*="aption" i], [role="region"][aria-label*="ubt" i]';
  let hideStyle = null;

  // Esconde as legendas do Meet sem desligá-las (elas continuam alimentando a transcrição).
  function applyCaptionVisibility() {
    if (platform !== "meet" || state.orphaned) return;
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
  // Extensão recarregada à força (⟳ em chrome://extensions) com a aba aberta: este script fica órfão.
  // Devolve as legendas nativas e avisa no widget; a aba precisa ser recarregada para voltar a transcrever.
  const orphanCheck = setInterval(() => {
    if (chrome.runtime?.id) return;
    clearInterval(orphanCheck);
    if (hideStyle) hideStyle.remove();
    hideStyle = null;
    state.orphaned = true;
    emitState();
  }, 3000);
  bus.setCaptionsHidden = async (hidden) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, hideCaptions: hidden } });
  };

  // Estágio: entrou na chamada / saiu (Meet pelo botão de sair; Slack pelo áudio do huddle). Sair não descarrega a página, então sem isto a
  // sessão só terminaria 30 min depois. Se a pessoa volta na mesma aba, a reunião continua
  // (menos de 10 min) ou vira uma nova parte.
  // Sinais, do mais confiável ao menos: (1) as conexões WebRTC que o coletor vê — sair fecha todas,
  // em qualquer idioma; (2) a tela "Você saiu da chamada" (botão de voltar a participar); (3) o botão
  // de sair sumiu. Numa reconexão as conexões caem por alguns segundos com a tela da chamada ainda
  // aberta, por isso o botão de sair presente alonga a espera em vez de encurtá-la.
  let leftAt = null;
  let meetingSince = 0;
  const GRACE = { reconnecting: 20_000, connections: 6_000, button: 10_000 };
  function trackStage(ui) {
    const now = Date.now();
    const { leave = false, rejoin = false, uiInCall = !!leave } = typeof ui === "boolean" ? { leave: ui } : ui || {};
    const pcs = state.protocol;
    // Conexão viva + algum sinal da tela da chamada (botões de sair/legendas, ou legendas já vistas):
    // a sala de espera também pode abrir conexão, mas não tem esses botões.
    const inCallNow = (pcs.connections > 0 && (uiInCall || state.captionsSeen)) || (!pcs.connectionsSeen && !!leave);
    if (inCallNow) {
      if (state.stage !== "meeting") {
        if (state.stage === "left") state.ended = false; // voltou à chamada: transcreve de novo
        state.stage = "meeting";
        meetingSince = now;
        leftAt = null;
        autoClicks = 0;
        emitState();
      }
      return;
    }
    if (state.stage === "meeting") {
      leftAt ||= now;
      const grace = rejoin ? 0 : leave ? GRACE.reconnecting : pcs.connectionsSeen ? GRACE.connections : GRACE.button;
      if (now - leftAt >= grace) {
        state.stage = "left";
        leftAt = null;
        if (platform === "meet") {
          complementFromScreen();
          writeDiag("left");
        }
        flush();
        state.ended = true;
        pending = [];
        const reason = rejoin ? "rejoin-screen" : leave ? "leave-button" : pcs.connectionsSeen ? "connections-closed" : "call-ui-gone";
        if (isTop) chrome.runtime.sendMessage({ type: "meeting-left", reason }).catch(() => {});
        emitState();
      }
    } else if (state.stage === "unknown") {
      state.stage = "prejoin";
    }
  }
  bus.trackStage = trackStage;

  if (platform === "slack") {
    // Huddle do Slack: o detector (slack.js) diz se há áudio ao vivo; não há legendas, só o áudio da aba.
    bus.inCall = () => !!window.__escribanoteSlack?.active;
    setInterval(() => trackStage(bus.inCall()), 1500);
    return;
  }

  if (platform !== "meet") return;

  // ---------- Google Meet: rótulos da interface por idioma ----------
  // O Meet gera as legendas no idioma da interface; e os botões (ligar/desligar legendas, sair)
  // dizem em que idioma ela está e em que estágio a reunião está. Rótulos observados no Meet.
  const MEET_UI = {
    // "legenda(s)" / "legenda instantânea": o Meet mudou o nome em 2026; os regex aceitam os dois.
    pt: { on: /^(ativar|mostrar) (a )?legenda/i, off: /^(desativar|ocultar) (a )?legenda/i, unavailable: /legenda.*indispon[ií]vel/i, leave: /^sair da chamada/i, rejoin: /^(voltar a participar|participar de novo|voltar à tela inicial)/i },
    en: { on: /^turn on (live )?captions/i, off: /^turn off (live )?captions/i, unavailable: /captions?.*unavailable/i, leave: /^leave call/i, rejoin: /^(rejoin|return to home screen)/i },
    es: { on: /^(activar|mostrar) (los )?subtítulos/i, off: /^(desactivar|ocultar) (los )?subtítulos/i, unavailable: /subtítulos.*no (están )?disponibles?/i, leave: /^salir de la llamada/i, rejoin: /^(volver a unirse|volver a la pantalla principal)/i },
    fr: { on: /^activer les sous-titres/i, off: /^désactiver les sous-titres/i, unavailable: /sous-titres.*indisponibles?/i, leave: /^quitter l'appel/i, rejoin: /^(rejoindre à nouveau|participer à nouveau|revenir à l'écran d'accueil)/i },
    de: { on: /^untertitel aktivieren/i, off: /^untertitel deaktivieren/i, unavailable: /untertitel.*nicht verfügbar/i, leave: /^anruf verlassen/i, rejoin: /^(erneut teilnehmen|zurück zum startbildschirm)/i },
    it: { on: /^attiva (i )?sottotitoli/i, off: /^disattiva (i )?sottotitoli/i, unavailable: /sottotitoli.*non disponibil/i, leave: /^abbandona la chiamata/i, rejoin: /^(partecipa di nuovo|torna alla schermata iniziale)/i },
  };
  const buttons = () => [...document.querySelectorAll("button[aria-label]")];
  const findButton = (key) => {
    for (const [lang, rx] of Object.entries(MEET_UI)) {
      const b = buttons().find((el) => rx[key].test(el.ariaLabel));
      if (b) return { lang, button: b };
    }
    return null;
  };
  // A tela pós-chamada usa botões de texto (sem aria-label): "Voltar a participar", "Rejoin"…
  const rejoinScreen = () => {
    for (const el of document.querySelectorAll("button, [role=button]")) {
      const t = (el.ariaLabel || el.textContent || "").trim();
      if (t && t.length <= 40 && Object.values(MEET_UI).some((rx) => rx.rejoin.test(t))) return true;
    }
    return false;
  };

  function inCall() {
    const leave = !!findButton("leave");
    const uiInCall = leave || !!findButton("on") || !!findButton("off");
    return (state.protocol.connections > 0 && (uiInCall || state.captionsSeen)) || (!state.protocol.connectionsSeen && leave);
  }
  bus.inCall = inCall;

  // Lê idioma da interface e estado das legendas pelos botões presentes.
  function readMeetUi() {
    const leave = findButton("leave");
    const on = findButton("on");
    const off = findButton("off");
    const unavailable = !on && !off ? findButton("unavailable") : null;
    const lang = (leave || off || on || unavailable)?.lang || null;
    if (lang && lang !== state.uiLang) {
      state.uiLang = lang;
      enqueue({ kind: "ui-lang", platform, lang });
      emitState();
    }
    // true/false pelo botão; "unavailable" quando o próprio Meet diz que a legenda está indisponível
    // (acontece em salas só com uma pessoa e em algumas contas): aí só o áudio resolve.
    const captionsOn = off ? true : on ? false : unavailable ? "unavailable" : null;
    if (captionsOn !== state.captionsOn) {
      state.captionsOn = captionsOn;
      emitState();
    }
    return { leave, on, off, uiInCall: !!(leave || on || off || unavailable), rejoin: !leave && rejoinScreen() };
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
  // O botão "Ativar legendas" só existe dentro da chamada, então ele basta: não depende de achar o
  // botão de sair (se o Meet mudar esse rótulo, as legendas continuam ligando sozinhas).
  function tryEnableCaptions(ui) {
    if (!state.consent || state.paused || !state.settings.autoCaptions || autoClicks >= 3 || totalClicks >= 12) return;
    if (Date.now() < retryAfter || Date.now() - lastCaptionAt < 30_000) return;
    if (ui.on) {
      autoClicks++;
      totalClicks++;
      ui.on.button.click();
    }
  }
  // Na chamada há mais de 12 s, com legendas ainda desligadas: o widget pede para ligar à mão.
  function trackCaptionsStuck() {
    const stuck = state.stage === "meeting" && !!state.consent && !state.captionsSeen && (state.captionsOn === "unavailable" || (state.captionsOn === false && Date.now() - meetingSince > 12_000));
    if (stuck !== state.captionsStuck) {
      state.captionsStuck = stuck;
      if (stuck && isTop) chrome.runtime.sendMessage({ type: "session-report", kind: "captions-stuck", detail: { captionsOn: state.captionsOn } }).catch(() => {});
      emitState();
    }
  }

  // ---------- Diagnóstico da chamada ----------
  // Enquanto está na chamada, grava a cada 5 s em chrome.storage.local ("meetDiag") o que a extensão
  // enxerga: canais de dados, botões, regiões de legenda e um trecho do texto. Sem conteúdo da reunião
  // além de um trecho curto da legenda visível. Serve para entender por que nada foi captado.
  const diag = { channels: {}, domEmitted: 0 };
  let diagTimer = 0;
  function ariaLive() {
    return [...document.querySelectorAll("[aria-live]")].slice(0, 10).map((el) => ({
      tag: el.tagName.toLowerCase(), live: el.getAttribute("aria-live"), label: el.getAttribute("aria-label") || "", role: el.getAttribute("role") || "",
      text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    }));
  }
  function writeDiag(reason) {
    if (Date.now() - diagTimer < 5000 && reason !== "left") return;
    diagTimer = Date.now();
    const region = document.querySelector(CAPTION_REGION);
    const snap = {
      at: Date.now(), reason, version: chrome.runtime.getManifest().version, path: location.pathname,
      stage: state.stage, uiLang: state.uiLang, captionsOn: state.captionsOn, captionsSeen: state.captionsSeen, consent: state.consent, ended: state.ended,
      lastCaptionAt, lastProtocolCaption, lastUndecoded, domMode: lastProtocolCaption === 0 || protocolFailing(), protocol: state.protocol, channels: diag.channels, domEmitted: diag.domEmitted,
      regionFound: !!region, regionText: region ? (region.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) : "",
      regions: [...document.querySelectorAll("[role=region]")].slice(0, 20).map((el) => el.getAttribute("aria-label") || "(sem rótulo)"),
      ariaLive: ariaLive(),
      buttons: [...document.querySelectorAll("button[aria-label]")].slice(0, 40).map((b) => b.ariaLabel),
      selfName: selfName(), tiles: document.querySelectorAll("[data-participant-id]").length,
    };
    chrome.storage.local.set({ meetDiag: snap }).catch(() => {});
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
      if (!blockIds.has(block)) blockIds.set(block, `dom/${Date.now()}/${++blockSeq}`);
      if (namesOnly) {
        rememberDomCaption(name, text);
        // texto já entregue pelo protocolo: se a leitura pela tela entrar depois, não o repete
        blockVersions.set(block, text);
        continue;
      }
      if (blockVersions.get(block) === text) continue;
      blockVersions.set(block, text);
      diag.domEmitted++;
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

  // ---------- Nomes pelos blocos de participante ----------
  // Cada bloco de vídeo do Meet traz data-participant-id="spaces/…/devices/N" — o mesmo id que o
  // protocolo usa nas legendas — e o nome na tela. O próprio usuário aparece como "Você"/"You",
  // e o nome dele fica em data-self-name. Cobre quem o canal "collections" não trouxe (em geral,
  // o próprio usuário); o nome do protocolo, quando chega, continua tendo prioridade (weak).
  const tileNamed = new Map(); // speakerId -> nome já enviado
  function scanTiles() {
    const me = selfName();
    for (const el of document.querySelectorAll("[data-participant-id]")) {
      const id = el.getAttribute("data-participant-id") || "";
      if (!/devices\//.test(id) || namedIds.has(id)) continue;
      const lines = (el.innerText || "").split("\n").map((t) => t.trim()).filter(Boolean);
      let name = null;
      if (lines.some(isSelfLabel)) name = me || "Você";
      else name = lines.find((t) => t.length <= 60 && /\p{L}/u.test(t) && !/^\d/.test(t)) || null;
      if (!name || tileNamed.get(id) === name) continue;
      tileNamed.set(id, name);
      enqueue({ kind: "speaker", platform, speakerId: id, name, source: "dom", weak: true });
    }
  }

  function protocolFailing() {
    return Date.now() - lastUndecoded < 6000 && Date.now() - lastProtocolCaption > 4000;
  }

  setInterval(() => {
    document.dispatchEvent(new CustomEvent("escribanote:ping"));
    if (state.consent) scanTiles();
    const ui = readMeetUi();
    trackStage(ui);
    tryEnableCaptions(ui);
    trackCaptionsStuck();
    if (state.stage === "meeting") writeDiag("tick");
    // Usa o DOM se o protocolo nunca entregou legendas nesta página, ou se o canal segue mandando
    // legendas que o coletor não entende (o Meet mudou o esquema) e nada decodificou há alguns segundos.
    // Fora disso a tela só serve para nomes (evita duplicatas).
    if (state.consent !== false && state.settings.domFallback && (lastProtocolCaption === 0 || protocolFailing())) scrapeDom();
    // Com o protocolo ativo, a tela serve para descobrir nomes que o protocolo não trouxe e para
    // guardar a última legenda inteira (complemento ao sair da chamada).
    else if (state.consent) scrapeDom(true);
  }, 1500);
})();
