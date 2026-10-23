// Gravador do computador: transcreve apps fora do navegador (ex.: huddles no app do Slack para
// Windows). O Chrome só entrega o áudio do sistema junto com um compartilhamento de tela, e só
// para uma página visível; por isso a captura e o Whisper rodam aqui, e não no offscreen.
// Esta aba faz o papel da "aba da reunião": fechar a aba encerra a sessão.
import { createPipeline } from "../asr/pipeline.js";
import { hasWebGPU, saveDiag } from "../asr/engine.js";
import { HQ_MODELS, getSettings, setSettings } from "../lib/settings.js";

const $ = (id) => document.getElementById(id);
const PALETTE = ["#2f6bff", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#65a30d"];
const SILENCE_WARN_MS = 25_000;

const send = async (msg) => {
  const r = await chrome.runtime.sendMessage(msg);
  if (r && r.error) throw new Error(r.error);
  return r;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = (n) => {
  const p = String(n).split(/\s+/).filter(Boolean);
  return ((p[0] || "?")[0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
};
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  return (h ? h + ":" : "") + mm + ":" + String(s % 60).padStart(2, "0");
};

const rec = {
  id: null,
  startedAt: 0,
  display: null,
  pipe: null,
  running: null, // promessa do carregamento do modelo
  paused: false,
  stopping: false,
  heard: { system: 0, mic: 0 }, // último instante com som (0: nunca)
  level: { system: 0, mic: 0 },
  timer: null,
  status: {},
};
let settings;

// ---------------- Preparação ----------------
const defaultTitle = (platform) =>
  `${platform === "slack" ? "Huddle no Slack" : "Gravação do computador"} — ${new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;

async function setup() {
  settings = await getSettings();
  const gpu = await hasWebGPU();
  $("model").innerHTML = Object.entries(HQ_MODELS)
    .map(([k, m]) => {
      const ok = gpu ? !!(m.webgpu || m.wasm) : !!m.wasm;
      return `<option value="${k}" ${ok ? "" : "disabled"}>${esc(m.label)}${ok ? "" : " — requer placa de vídeo"}</option>`;
    })
    .join("");
  const want = settings.recorderModel || (settings.hq !== "off" ? settings.hq : "small");
  $("model").value = HQ_MODELS[want] && (gpu || HQ_MODELS[want].wasm) ? want : "small";
  $("platform").value = settings.recorderPlatform || "slack";
  $("mic").checked = settings.recorderMic !== false;
  $("me-name").textContent = settings.myName || "Você";
  $("title").value = defaultTitle($("platform").value);
  $("title").dataset.auto = "1";
  $("title").addEventListener("input", () => delete $("title").dataset.auto);
  $("platform").addEventListener("change", () => {
    if ($("title").dataset.auto) $("title").value = defaultTitle($("platform").value);
  });
}

// Confere o modelo antes de gravar: transcreve o trecho de fala de referência embutido
// ("...da América do Sul e da região da América Latina...") com o mesmo motor da gravação.
$("test").addEventListener("click", async () => {
  const out = $("test-out");
  const modelKey = $("model").value;
  out.hidden = false;
  out.className = "test-out muted";
  out.textContent = "Carregando o modelo (na primeira vez ele é baixado)…";
  $("test").disabled = $("start").disabled = true;
  const pipe = createPipeline({
    onResult: () => {},
    onStatus: (st) => {
      if (st.state === "loading") out.textContent = `Baixando e carregando o modelo… ${st.progress || 0}%`;
    },
  });
  let engine;
  try {
    engine = await pipe.loadEngine(modelKey, settings.captionLang);
    out.textContent = "Transcrevendo o trecho de teste…";
    const r = await engine.selfTest();
    const where = r.device === "webgpu" ? "placa de vídeo" : "processador";
    out.className = "test-out " + (r.ok ? "ok" : "err");
    out.textContent = r.ok
      ? `Funcionando (${where}, ${(r.ms / 1000).toFixed(1)} s para 3,6 s de fala). Ouviu: "${r.text}"`
      : `Não transcreveu direito (${where}). Ouviu: "${r.text || "nada"}"`;
    if (r.fallback) out.textContent += " — a placa de vídeo falhou e o Escribanote passou para o processador.";
    saveDiag({ lastTest: { ...r, model: modelKey, at: Date.now() } });
  } catch (err) {
    out.className = "test-out err";
    out.textContent = "Falhou: " + (err.message || err);
    saveDiag({ lastTest: { error: String(err.message || err), model: modelKey, at: Date.now() } });
  } finally {
    await engine?.dispose().catch(() => {}); // a gravação carrega o seu próprio motor
    $("test").disabled = $("start").disabled = false;
  }
});

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  start();
});

async function start() {
  $("setup-err").textContent = "";
  $("start").disabled = true;
  const platform = $("platform").value;
  const modelKey = $("model").value;
  const withMic = $("mic").checked;
  setSettings({ recorderModel: modelKey, recorderPlatform: platform, recorderMic: withMic }).catch(() => {});

  let display;
  try {
    // A imagem é exigida pelo Chrome para liberar o som; pedimos o mínimo e não a usamos.
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1, width: { max: 640 }, height: { max: 360 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "exclude",
      monitorTypeSurfaces: "include",
    });
  } catch (err) {
    $("start").disabled = false;
    $("setup-err").textContent = err.name === "NotAllowedError" ? "O compartilhamento foi cancelado." : "Não foi possível capturar a tela: " + err.message;
    return;
  }
  if (!display.getAudioTracks().length) {
    display.getTracks().forEach((t) => t.stop());
    $("start").disabled = false;
    $("setup-err").innerHTML =
      "O som do computador não veio junto. Clique de novo, escolha <b>Tela inteira</b> e ative <b>Compartilhar áudio do sistema</b> (no Windows a opção fica embaixo, à esquerda).";
    return;
  }

  // Começa a ouvir já: o que for dito enquanto o resto se prepara entra na fila.
  rec.display = display;
  rec.startedAt = Date.now();
  rec.heard = { system: 0, mic: 0 };
  rec.pipe = createPipeline({
    onResult: (seg) => send({ type: "asr-result", seg }).catch(() => {}),
    onStatus: (s) => {
      rec.status = { ...rec.status, ...s };
      renderStatus();
    },
    onLevel: (source, rms) => {
      rec.level[source] = Math.max(rms, rec.level[source] * 0.8);
      if (rms > 0.004) rec.heard[source] = Date.now();
    },
  });
  await rec.pipe.addStream(new MediaStream(display.getAudioTracks()), "system");

  let mic = null;
  let micError = "";
  if (withMic) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      micError = err.name === "NotAllowedError" ? "o Chrome bloqueou o microfone" : err.message;
    }
  }

  if (mic) await rec.pipe.addStream(mic, "mic");

  try {
    rec.id = await send({ type: "recorder-start", title: $("title").value.trim() || defaultTitle(platform), platform });
  } catch (err) {
    await rec.pipe.stopCapture();
    rec.pipe = null;
    display.getTracks().forEach((t) => t.stop());
    $("start").disabled = false;
    $("setup-err").textContent = err.message;
    return;
  }

  // Clicar em "Parar de compartilhar" na barra do Chrome encerra a gravação.
  for (const t of display.getTracks()) t.addEventListener("ended", () => stop(), { once: true });

  $("setup").hidden = true;
  $("live").hidden = false;
  $("live-title").textContent = $("title").value.trim();
  $("meter-mic").classList.toggle("off", !mic);
  if (micError) showWarn(`Gravando sem o microfone (${micError}): a sua fala só entra se sair pela caixa de som.`);
  renderPause();
  renderFeed({ blocks: [] });
  rec.timer = setInterval(tick, 120);

  // O áudio já está sendo segmentado enquanto o modelo carrega; nada se perde.
  // Identificação de falantes pela voz (Pro): no gravador não há legendas, então é ela que separa
  // "Falante 1", "Falante 2"… em vez de juntar tudo em "Participantes".
  const diarize = !!settings.diarize && (await chrome.runtime.sendMessage({ type: "is-pro" }).catch(() => false));
  rec.running = rec.pipe.run(modelKey, settings.captionLang, { diarize }).catch((err) => {
    rec.status = { state: "error", message: err.message };
    renderStatus();
  });
}

// ---------------- Gravando ----------------
function tick() {
  $("clock").textContent = mmss(Date.now() - rec.startedAt);
  for (const k of ["system", "mic"]) {
    $("lv-" + k).style.width = Math.min(100, Math.round(Math.sqrt(rec.level[k]) * 260)) + "%";
    rec.level[k] *= 0.85;
  }
  // Só avisa se o som do computador nunca chegou: silêncio depois disso é só a conversa parada.
  const never = !rec.heard.system && Date.now() - rec.startedAt > SILENCE_WARN_MS;
  if (never && !rec.paused && !$("warn").dataset.kind) {
    showWarn("Ainda não chegou som do computador. Se o huddle já começou, clique em Parar e salvar e comece de novo marcando <b>Compartilhar áudio do sistema</b>.", "silence");
  } else if (rec.heard.system && $("warn").dataset.kind === "silence") {
    hideWarn();
  }
}

function showWarn(html, kind = "info") {
  $("warn").innerHTML = html;
  $("warn").dataset.kind = kind;
  $("warn").hidden = false;
}
function hideWarn() {
  $("warn").hidden = true;
  delete $("warn").dataset.kind;
}

function renderStatus() {
  const s = rec.status;
  const text = {
    loading: `· baixando o modelo ${s.progress || 0}% (só na primeira vez)`,
    running: `· transcrevendo neste computador${s.device === "webgpu" ? " (placa de vídeo)" : ""}${s.queue > 2 ? ` · ${s.queue} trechos na fila` : ""}`,
    error: `· erro: ${s.message || ""}`,
  }[s.state];
  $("status").textContent = rec.stopping ? "· terminando de transcrever…" : text || "· preparando…";
  if (s.warning && $("warn").dataset.kind !== "gpu") showWarn(s.warning, "gpu");
  if (s.state === "running" && s.rtf > 1.3 && s.segments > 4 && !$("warn").dataset.kind) {
    showWarn("Este computador está transcrevendo mais devagar que a conversa. O texto vai atrasar; na próxima, escolha uma precisão menor.", "slow");
  }
}

function renderPause() {
  $("pause").innerHTML = rec.paused
    ? '<svg viewBox="0 0 24 24"><path d="m7 4 13 8-13 8z"/></svg>Retomar'
    : '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>Pausar';
  document.body.classList.toggle("paused", rec.paused);
}

function renderFeed(view) {
  const tags = Object.fromEntries((settings.tags || []).map((t) => [t.id, t]));
  const feed = $("feed");
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
  feed.innerHTML = view.blocks.length
    ? view.blocks
        .map((b) => {
          const time = mmss(b.startAt - rec.startedAt);
          const tagHtml = (b.tags || []).map((id) => (tags[id] ? `<span class="tag">${tags[id].emoji} ${esc(tags[id].label)}</span>` : "")).join("");
          return `<div class="blk"><span class="av" style="background:${colorFor(b.speaker)}">${esc(initials(b.speaker))}</span>
            <div><div class="who">${esc(b.speaker)}<time>${time}</time>${tagHtml}</div><p>${esc(b.text)}</p></div></div>`;
        })
        .join("")
    : `<div class="feed-empty">As falas aparecem aqui alguns segundos depois de ditas.${
        rec.status.state === "loading" ? "<br>Enquanto o modelo baixa, o áudio fica guardado e é transcrito em seguida." : ""
      }</div>`;
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}

async function refresh() {
  const view = await send({ type: "my-view", id: rec.id }).catch(() => null);
  if (!view || view.id !== rec.id) return;
  if (view.paused !== rec.paused) {
    rec.paused = view.paused;
    renderPause();
  }
  renderFeed(view);
}
let refreshTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "session-updated" && msg.id === rec.id && !refreshTimer) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 250);
  }
});

$("pause").addEventListener("click", async () => {
  const s = await send({ type: "pause", id: rec.id, paused: !rec.paused });
  rec.paused = !!(s && s.paused);
  renderPause();
});
$("star").addEventListener("click", () => send({ type: "highlight-last", id: rec.id }).catch(() => {}));
const openApp = () => chrome.tabs.create({ url: chrome.runtime.getURL(`src/app/app.html?id=${encodeURIComponent(rec.id)}`) });
$("open").addEventListener("click", openApp);
$("done-open").addEventListener("click", openApp);
$("again").addEventListener("click", () => location.reload());
$("stop").addEventListener("click", () => stop());

async function stop() {
  if (rec.stopping || !rec.pipe) return;
  rec.stopping = true;
  for (const b of $("live").querySelectorAll("button")) b.disabled = true;
  renderStatus();
  await rec.pipe.stopCapture(); // fecha os últimos trechos e libera o compartilhamento
  rec.display.getTracks().forEach((t) => t.stop());
  await rec.running; // se o modelo ainda estava baixando, espera para transcrever o que ficou na fila
  await rec.pipe.drain();
  clearInterval(rec.timer);
  await send({ type: "recorder-stop" }).catch(() => {});
  const view = await send({ type: "get", id: rec.id }).catch(() => null);
  const n = view ? view.asr.length : 0;
  $("done-sub").textContent = `${$("live-title").textContent} · ${mmss(Date.now() - rec.startedAt)} · ${n} trecho${n === 1 ? "" : "s"} transcrito${n === 1 ? "" : "s"}`;
  $("live").hidden = true;
  $("done").hidden = false;
  rec.pipe = null;
}

// Fechar a aba no meio da gravação perderia o que ainda está na fila.
window.addEventListener("beforeunload", (e) => {
  if (rec.pipe && !rec.stopping) e.preventDefault();
});

// Gancho de teste: injeta streams no lugar do compartilhamento de tela.
if (new URLSearchParams(location.search).has("test")) {
  globalThis.__escribanoteRecorderTest = { rec, start, stop };
}

setup();
