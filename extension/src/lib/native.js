// Ajudante de áudio do Escribanote (Windows, opcional): um programa pequeno que entrega o áudio que o
// computador está tocando pela mensageria nativa do Chrome, já em mono 16 kHz. Com ele, o gravador do
// computador funciona com um clique, sem o seletor "compartilhar tela". Fonte em desktop/windows/.
export const NATIVE_HOST = "com.escribanote.audio";
export const HELPER_URL = "https://escribanote.meneseslabs.com.br/download/escribanote-audio-windows.zip";

export async function nativePermission({ request = false } = {}) {
  if (!chrome.permissions) return false;
  const has = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
  if (has || !request) return has;
  return chrome.permissions.request({ permissions: ["nativeMessaging"] });
}

// Pergunta ao ajudante se ele está instalado e responde: {ok, version, device} ou {ok:false, reason}.
export function probeNative(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!chrome.runtime?.connectNative) return resolve({ ok: false, reason: "sem permissão" });
    let port;
    const done = (r) => {
      clearTimeout(timer);
      try {
        port?.disconnect();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: "o ajudante não respondeu" }), timeoutMs);
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      return done({ ok: false, reason: err.message });
    }
    port.onDisconnect.addListener(() => done({ ok: false, reason: chrome.runtime.lastError?.message || "o ajudante fechou" }));
    port.onMessage.addListener((m) => {
      if (m && m.type === "hello") done({ ok: true, version: m.version, device: m.device });
    });
    port.postMessage({ type: "hello" });
  });
}

// Abre o ajudante para captura: onAudio(Float32Array) a cada ~100 ms; onStopped(reason) quando acabar.
export function openNative({ onAudio, onStarted, onStopped, onError }) {
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  let closed = false;
  port.onMessage.addListener((m) => {
    if (!m) return;
    if (m.type === "audio" && m.data) {
      const bin = atob(m.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      onAudio?.(new Float32Array(bytes.buffer, 0, bytes.length >> 2));
    } else if (m.type === "started") onStarted?.(m);
    else if (m.type === "error") onError?.(new Error(m.message || "erro no ajudante"));
    else if (m.type === "stopped") onStopped?.("parado");
  });
  port.onDisconnect.addListener(() => {
    if (closed) return;
    closed = true;
    onStopped?.(chrome.runtime.lastError?.message || "o ajudante desconectou");
  });
  return {
    start: () => port.postMessage({ type: "start" }),
    stop: () => {
      try {
        port.postMessage({ type: "stop" });
      } catch {}
    },
    disconnect: () => {
      closed = true;
      try {
        port.disconnect();
      } catch {}
    },
  };
}
