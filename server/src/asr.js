// Transcrição de arquivos no servidor (plano Pro), pelo Whisper large-v3-turbo do Groq.
// A extensão lê o arquivo localmente (em fluxo), manda pedaços de até 10 min em WAV 16 kHz mono e
// recebe as falas com horário. Custo: 1 crédito por hora de áudio (arredondado para cima), cobrado no
// início; se nada for transcrito, os créditos voltam. O Groq cobra ~US$ 0,04 por hora (mínimo de 10 s por envio).
import { randomUUID } from "node:crypto";
import { refund, reserve } from "./credits.js";
import { fail } from "./http.js";
import { requirePro } from "./meetings.js";

export const ASR_MODEL = "whisper-large-v3-turbo";
export const ASR_USD_PER_HOUR = 0.04;
export const ASR_CHUNK_MAX_BYTES = 24 * 1024 * 1024; // abaixo dos 25 MB do Groq
const HOUR = 3_600_000;
export const asrCredits = (ms) => Math.max(1, Math.ceil((Number(ms) || 0) / HOUR));

// Cliente padrão: API do Groq compatível com a da OpenAI (multipart).
export function groqTranscriber(apiKey, fetchImpl = globalThis.fetch) {
  return async (wav, { language } = {}) => {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "trecho.wav");
    form.append("model", ASR_MODEL);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (language) form.append("language", language);
    const res = await fetchImpl("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Groq ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  };
}

// Duração de um WAV PCM 16 bits (o que a extensão manda), pelo cabeçalho.
export function wavMs(buf) {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let pos = 12, rate = 0, bytesPerSec = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { rate = buf.readUInt32LE(pos + 12); bytesPerSec = buf.readUInt32LE(pos + 16); }
    if (id === "data") return bytesPerSec ? Math.round((Math.min(size, buf.length - pos - 8) / bytesPerSec) * 1000) : null;
    pos += 8 + size + (size & 1);
  }
  return null;
}

// Falas do Whisper: descarta trechos de silêncio (alta chance de "sem fala" e baixa confiança).
export function asrSegments(data, offsetMs = 0) {
  return (Array.isArray(data?.segments) ? data.segments : [])
    .filter((s) => s && typeof s.text === "string" && s.text.trim() && !(s.no_speech_prob > 0.6 && s.avg_logprob < -0.8))
    .map((s) => ({ start: Math.round(offsetMs + s.start * 1000), end: Math.round(offsetMs + s.end * 1000), text: s.text.trim() }));
}

export function registerAsr(app, { db, config, transcribe }) {
  const auth = { preHandler: app.authenticate };
  // Pedaços de áudio chegam como corpo binário.
  app.addContentTypeParser(["audio/wav", "application/octet-stream"], { parseAs: "buffer", bodyLimit: ASR_CHUNK_MAX_BYTES }, (_req, body, done) => done(null, body));

  async function guard(req) {
    if (!transcribe) fail(503, "asr_unavailable", "A transcrição no servidor está indisponível no momento.");
    await requirePro(db, req.user.id);
    const spent = await db.one("SELECT COALESCE(SUM(cost_usd), 0)::float AS usd FROM ai_requests WHERE created_at >= date_trunc('day', now())");
    if (spent.usd >= config.aiDailyBudgetUsd) fail(503, "ai_paused", "A transcrição no servidor está pausada por alguns instantes. Tente de novo mais tarde.");
  }
  async function jobOf(req, id) {
    const job = await db.one("SELECT * FROM ai_requests WHERE id = $1 AND user_id = $2 AND kind = 'asr'", [String(id || ""), req.user.id]).catch(() => null);
    if (!job) fail(404, "not_found", "Transcrição não encontrada.");
    return job;
  }

  // Início: reserva os créditos pela duração do áudio.
  app.post("/api/v1/asr/start", auth, async (req) => {
    await guard(req);
    const durationMs = Number(req.body?.durationMs);
    if (!(durationMs > 0) || durationMs > 12 * HOUR) fail(400, "bad_request", "Informe a duração do áudio (até 12 h).");
    const credits = asrCredits(durationMs);
    const id = randomUUID();
    const balance = await reserve(db, req.user.id, credits, id);
    await db.query("INSERT INTO ai_requests (id, user_id, meeting_id, kind, model, credits) VALUES ($1, $2, $3, 'asr', $4, $5)", [id, req.user.id, req.body?.meetingId ? String(req.body.meetingId).slice(0, 100) : null, ASR_MODEL, credits]);
    return { job: id, credits, balance };
  });

  // Um pedaço (WAV 16 kHz mono, até 10 min). offsetMs: onde ele começa no áudio original.
  app.post("/api/v1/asr/chunk", { ...auth, bodyLimit: ASR_CHUNK_MAX_BYTES }, async (req) => {
    const job = await jobOf(req, req.query?.job);
    if (job.status !== "running") fail(409, "asr_closed", "Esta transcrição já terminou.");
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    const ms = buf && wavMs(buf);
    if (!ms) fail(400, "bad_audio", "Envie o trecho em WAV.");
    // não passa do que foi pago (com folga de 2 min para arredondamentos)
    if (Number(job.audio_ms) + ms > job.credits * HOUR + 120_000) fail(402, "asr_exceeded", "O áudio é maior que o informado no início.");
    const offsetMs = Math.max(0, Number(req.query?.offsetMs) || 0);
    const language = /^[a-z]{2}$/.test(String(req.query?.lang || "")) ? String(req.query.lang) : undefined;
    let data;
    try {
      data = await transcribe(buf, { language });
    } catch (err) {
      req.log.error({ err: err.message, status: err.status }, "falha no Groq");
      fail(err.status === 429 ? 429 : 502, "asr_failed", err.status === 429 ? "O serviço de transcrição está ocupado. Tentando de novo em instantes." : "O serviço de transcrição falhou neste trecho.");
    }
    const usd = (ASR_USD_PER_HOUR * Math.max(10_000, ms)) / HOUR;
    await db.query("UPDATE ai_requests SET audio_ms = audio_ms + $2, cost_usd = cost_usd + $3 WHERE id = $1", [job.id, ms, usd]);
    return { segments: asrSegments(data, offsetMs), ms };
  });

  // Fim: ok, ou falha (sem nada transcrito, os créditos voltam).
  app.post("/api/v1/asr/finish", auth, async (req) => {
    const job = await jobOf(req, req.body?.job);
    if (job.status !== "running") return { status: job.status };
    if (req.body?.ok || Number(job.audio_ms) > 0) {
      await db.query("UPDATE ai_requests SET status = 'done', finished_at = now() WHERE id = $1", [job.id]);
      return { status: "done" };
    }
    await db.query("UPDATE ai_requests SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [job.id, String(req.body?.error || "cancelado").slice(0, 500)]);
    const balance = await refund(db, req.user.id, job.credits, job.id);
    return { status: "refunded", balance };
  });
}
