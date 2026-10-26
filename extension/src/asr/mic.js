// Microfone que acompanha trocas de dispositivo durante a chamada (fone Bluetooth que conecta,
// headset desligado, padrão do sistema alterado). Quando a faixa atual termina ou a lista de
// dispositivos muda, pede o microfone padrão de novo e entrega a nova faixa a `onStream`.
// O chamador liga a nova faixa no mesmo lugar da antiga (pipeline.replaceStream), então o relógio
// não muda: o tempo sem microfone vira silêncio.
const CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

export async function openMic() {
  return navigator.mediaDevices.getUserMedia(CONSTRAINTS);
}

export function watchMic(stream, { onStream, onEvent = () => {} }) {
  let current = stream;
  let closed = false;
  let timer = 0;
  const label = (s) => (s.getAudioTracks()[0]?.label || "").slice(0, 80);

  async function reacquire(why) {
    if (closed) return;
    try {
      const next = await openMic();
      if (closed) { next.getTracks().forEach((t) => t.stop()); return; }
      const same = label(next) === label(current) && current.getAudioTracks()[0]?.readyState === "live";
      if (same) { next.getTracks().forEach((t) => t.stop()); return; }
      current = next;
      hook(next);
      onEvent("mic-reacquired", { why, label: label(next) });
      onStream(next);
    } catch (err) {
      onEvent("mic-lost", { why, error: err.name || String(err) });
    }
  }
  function hook(s) {
    const t = s.getAudioTracks()[0];
    if (!t) return;
    t.addEventListener("ended", () => { onEvent("mic-ended", { label: label(s) }); reacquire("ended"); }, { once: true });
  }
  const onChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => reacquire("devicechange"), 800); // várias mudanças chegam juntas ao trocar de fone
  };
  hook(stream);
  navigator.mediaDevices.addEventListener("devicechange", onChange);
  return {
    get stream() { return current; },
    close() {
      closed = true;
      clearTimeout(timer);
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    },
  };
}
