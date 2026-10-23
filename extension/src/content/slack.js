// Slack no Chrome (app.slack.com): detecta o huddle e quem está falando, pela própria página.
// O huddle usa WebRTC e toca o áudio dos outros num <audio> com MediaStream: é o sinal de que a
// chamada está ativa. Os nomes vêm dos avatares do painel do huddle e o "falando" do indicador
// que o Slack acende no avatar. O áudio em si é transcrito pela alta precisão (captura da aba),
// com a identificação por voz; aqui só entram metadados. Nada sai do computador.
(() => {
  "use strict";
  if (location.host !== "app.slack.com" || window.top !== window || window.__escribanoteSlack) return;

  const st = { active: false, key: null, title: null, participants: 0, speakingSeen: false };
  window.__escribanoteSlack = st;
  // Marca no DOM (visível de qualquer "mundo"): útil para diagnóstico e testes.
  document.documentElement.dataset.escribanoteSlack = "pronto";
  const emit = (kind, payload) =>
    document.dispatchEvent(new CustomEvent("escribanote:evt", { detail: JSON.stringify({ kind, platform: "slack", ...payload }) }));

  // Seletores do painel do huddle, do avatar e do indicador de fala. O Slack muda o DOM com o tempo:
  // cada um tem alternativas, e sem nenhum deles o huddle ainda é transcrito (só sem nomes).
  const ROOT = '[data-qa*="huddle" i], [class*="huddle" i][class*="panel" i], [role="dialog"][aria-label*="huddle" i], [role="region"][aria-label*="huddle" i]';
  const SPEAKING = '[class*="speaking" i], [data-qa*="speaking" i], [aria-label*="speaking" i], [aria-label*="falando" i], [data-speaking="true"]';

  function liveMedia() {
    for (const el of document.querySelectorAll("audio, video")) {
      const s = el.srcObject;
      if (s && typeof s.getAudioTracks === "function" && s.getAudioTracks().some((t) => t.readyState === "live") && !el.paused) return true;
    }
    return false;
  }
  function channelId() {
    const m = location.pathname.match(/\/client\/[A-Z0-9]+\/([A-Z0-9]+)/i);
    return m ? m[1] : null;
  }
  function pageTitle() {
    const t = document.title.replace(/^\(\d+\)\s*/, "").replace(/\s*[-–|]\s*Slack\s*$/i, "").trim();
    const chan = t.split(/\s[-–|]\s/)[0].trim();
    return chan ? `Huddle em ${chan}` : "Huddle no Slack";
  }
  const plausible = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 60 && !/^slack$/i.test(s.trim()) && !/\n/.test(s);

  // Participantes do painel: [{name, el}]; `el` é o avatar/cartão, usado para ler o indicador de fala.
  function participants() {
    const root = document.querySelector(ROOT);
    if (!root) return [];
    const seen = new Map();
    for (const el of root.querySelectorAll("img[alt], [aria-label], [title]")) {
      const raw = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title") || "";
      const name = raw.replace(/\s*\((?:muted|mudo|silenciad\w+|falando|speaking)\)\s*$/i, "").replace(/,.*$/, "").trim();
      if (!plausible(name) || /huddle|microfone|microphone|câmera|camera|share|compartilh|leave|sair|mute|mudo/i.test(name)) continue;
      if (!seen.has(name)) seen.set(name, el);
    }
    return [...seen].map(([name, el]) => ({ name, el }));
  }

  function isSpeaking(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n !== document.body; i++) {
      if (n.matches && n.matches(SPEAKING)) return true;
      if (n.querySelector && i > 0 && n.querySelector(SPEAKING)) return true;
      n = n.parentElement;
    }
    return false;
  }

  const named = new Set();
  const open = new Map(); // name -> {id, start}
  let turnSeq = 0;

  function scan() {
    const active = liveMedia();
    if (active && !st.active) {
      st.active = true;
      st.key = `slack:${channelId() || "huddle"}`;
      st.title = pageTitle();
      emit("meeting-start", { key: st.key, title: st.title });
    } else if (!active && st.active) {
      st.active = false;
      for (const [name, t] of open) emit("turn", { id: t.id, speakerId: `slack:${name}`, start: t.start, end: Date.now() });
      open.clear();
    }
    document.documentElement.dataset.escribanoteHuddle = st.active ? "ativo" : "inativo";
    if (!st.active) return;
    const list = participants();
    st.participants = list.length;
    const now = Date.now();
    for (const { name, el } of list) {
      const id = `slack:${name}`;
      if (!named.has(name)) {
        named.add(name);
        emit("speaker", { speakerId: id, name });
      }
      const speaking = isSpeaking(el);
      if (speaking) st.speakingSeen = true;
      const t = open.get(name);
      if (speaking && !t) open.set(name, { id: `turn/${now}/${++turnSeq}`, start: now, last: 0 });
      else if (speaking && t && now - t.last >= 2000) {
        t.last = now;
        emit("turn", { id: t.id, speakerId: id, start: t.start, end: now }); // fala longa: atualiza o fim
      } else if (!speaking && t) {
        open.delete(name);
        if (now - t.start >= 300) emit("turn", { id: t.id, speakerId: id, start: t.start, end: now });
      }
    }
  }

  setInterval(() => {
    try {
      scan();
    } catch {}
  }, 500);
})();
