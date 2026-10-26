// Guarda o áudio da reunião em faixas separadas (Opus em WebM), direto no cofre (lib/audiovault.js).
// Usa a saída de gravação do pipeline (pipeline.recordStream), que continua a mesma quando o microfone
// é trocado, então uma faixa nunca é partida em dois arquivos.
import { createTrackWriter, writeMeta } from "../lib/audiovault.js";

const MIME = ["audio/webm;codecs=opus", "audio/webm"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "";
export const canKeepAudio = () => !!MIME;

export function startKeeping({ sessionId, streams, onMeta = () => {}, timesliceMs = 5000 }) {
  const recs = [];
  const writers = {};
  const meta = { startedAt: Date.now(), tracks: [], mime: MIME, bytes: 0, done: false, keep: false };
  for (const [source, stream] of Object.entries(streams)) {
    if (!stream || !stream.getAudioTracks().length) continue;
    const w = createTrackWriter(sessionId, source);
    writers[source] = w;
    const rec = new MediaRecorder(stream, { mimeType: MIME, audioBitsPerSecond: 24_000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) w.write(e.data); };
    rec.onstart = () => { meta.startedAt = Math.min(meta.startedAt, Date.now()); };
    rec.start(timesliceMs);
    recs.push(rec);
    meta.tracks.push(source);
  }
  if (!recs.length) return null;
  writeMeta(sessionId, meta).catch(() => {});
  onMeta({ ...meta });
  const tick = setInterval(() => {
    meta.bytes = Object.values(writers).reduce((a, w) => a + w.bytes, 0);
    onMeta({ ...meta });
  }, 30_000);
  return {
    async stop() {
      clearInterval(tick);
      await Promise.all(recs.map((rec) => new Promise((ok) => {
        if (rec.state === "inactive") return ok();
        rec.onstop = ok;
        try { rec.stop(); } catch { ok(); }
      })));
      await Promise.all(Object.values(writers).map((w) => w.close()));
      meta.bytes = Object.values(writers).reduce((a, w) => a + w.bytes, 0);
      meta.durationMs = Date.now() - meta.startedAt;
      meta.done = true;
      await writeMeta(sessionId, meta).catch(() => {});
      onMeta({ ...meta });
      return { ...meta };
    },
  };
}
