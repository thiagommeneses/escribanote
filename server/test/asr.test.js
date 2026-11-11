import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { asrCredits, asrSegments, wavMs } from "../src/asr.js";
import { login, makePro, setup, silentWav } from "./helpers.js";

let ctx, u;
before(async () => {
  ctx = await setup();
  u = await login(ctx);
  await makePro(ctx, u.me.id, { credits: 10 });
});
after(async () => ctx.close());
beforeEach(() => {
  ctx.groq.failWith = null;
  ctx.groq.calls.length = 0;
});
const balance = async () => (await ctx.db.one("SELECT balance FROM credit_balances WHERE user_id = $1", [u.me.id])).balance;
const chunk = (job, wav, offsetMs = 0) => u.req("POST", `/api/v1/asr/chunk?job=${job}&offsetMs=${offsetMs}&lang=pt`, wav, { "content-type": "audio/wav" });

test("créditos: 1 por hora, arredondado para cima; WAV e falas", () => {
  assert.equal(asrCredits(10 * 60_000), 1);
  assert.equal(asrCredits(60 * 60_000), 1);
  assert.equal(asrCredits(130 * 60_000), 3);
  assert.equal(wavMs(silentWav(90)), 90_000);
  assert.equal(wavMs(Buffer.from("não é wav")), null);
  const segs = asrSegments({ segments: [{ start: 1, end: 2, text: " Oi." }, { start: 5, end: 6, text: " Obrigado.", no_speech_prob: 0.95, avg_logprob: -1.2 }] }, 600_000);
  assert.deepEqual(segs, [{ start: 601_000, end: 602_000, text: "Oi." }], "silêncio com baixa confiança sai");
});

test("transcrição no servidor: reserva pela duração, manda trechos e devolve as falas no horário do áudio", async () => {
  const before = await balance();
  const s = await u.post("/api/v1/asr/start", { durationMs: 130 * 60_000, meetingId: "imp-1" });
  assert.equal(s.statusCode, 200, s.body);
  assert.equal(s.json().credits, 3);
  assert.equal(await balance(), before - 3);
  const job = s.json().job;
  const r = await chunk(job, silentWav(20), 600_000);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().segments, [{ start: 601_500, end: 604_000, text: "Bom dia a todos." }]);
  assert.equal(ctx.groq.calls[0].opts.language, "pt");
  const row = await ctx.db.one("SELECT audio_ms, cost_usd::float AS usd, model FROM ai_requests WHERE id = $1", [job]);
  assert.equal(Number(row.audio_ms), 20_000);
  assert.equal(row.model, "whisper-large-v3-turbo");
  assert.ok(row.usd > 0 && row.usd < 0.001, "custo do Groq registrado: " + row.usd);
  const f = await u.post("/api/v1/asr/finish", { job, ok: true });
  assert.equal(f.json().status, "done");
  assert.equal(await balance(), before - 3, "concluída: os créditos ficam");
  assert.equal((await chunk(job, silentWav(5))).statusCode, 409, "trabalho encerrado não aceita mais trechos");
});

test("não aceita mais áudio do que o pago, nem corpo que não seja WAV", async () => {
  const job = (await u.post("/api/v1/asr/start", { durationMs: 60_000 })).json().job;
  assert.equal((await chunk(job, Buffer.from("x".repeat(100)))).statusCode, 400);
  // 1 crédito = 1 h (+2 min de folga): 63 min passam do limite
  await ctx.db.query("UPDATE ai_requests SET audio_ms = $2 WHERE id = $1", [job, 59 * 60_000]);
  const r = await chunk(job, silentWav(240));
  assert.equal(r.statusCode, 402);
  assert.equal(ctx.groq.calls.length, 0, "o Groq nem é chamado");
  await u.post("/api/v1/asr/finish", { job, ok: true });
});

test("falha do Groq: o trecho dá erro; sem nada transcrito, os créditos voltam no fim", async () => {
  const before = await balance();
  const job = (await u.post("/api/v1/asr/start", { durationMs: 30 * 60_000 })).json().job;
  assert.equal(await balance(), before - 1);
  ctx.groq.failWith = Object.assign(new Error("rate"), { status: 429 });
  const r = await chunk(job, silentWav(10));
  assert.equal(r.statusCode, 429);
  ctx.groq.failWith = Object.assign(new Error("boom"), { status: 500 });
  assert.equal((await chunk(job, silentWav(10))).statusCode, 502);
  const f = await u.post("/api/v1/asr/finish", { job, ok: false, error: "falhou" });
  assert.equal(f.json().status, "refunded");
  assert.equal(await balance(), before);
});

test("sem Pro, sem créditos ou de outra pessoa: recusado", async () => {
  const free = await login(ctx);
  assert.equal((await free.post("/api/v1/asr/start", { durationMs: 60_000 })).statusCode, 402);
  const job = (await u.post("/api/v1/asr/start", { durationMs: 60_000 })).json().job;
  const other = await login(ctx);
  await makePro(ctx, other.me.id, { credits: 0 });
  assert.equal((await other.req("POST", `/api/v1/asr/chunk?job=${job}`, silentWav(5), { "content-type": "audio/wav" })).statusCode, 404);
  assert.equal((await other.post("/api/v1/asr/start", { durationMs: 60_000 })).statusCode, 402, "sem créditos");
  assert.equal((await u.post("/api/v1/asr/start", { durationMs: 0 })).statusCode, 400);
  await u.post("/api/v1/asr/finish", { job, ok: true });
});
