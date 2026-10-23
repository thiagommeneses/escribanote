import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { grantCycle } from "../src/credits.js";
import { login, makePro, parseSse, sampleMeeting, setup } from "./helpers.js";

let ctx, u;
before(async () => {
  ctx = await setup();
  u = await login(ctx);
  await makePro(ctx, u.me.id, { credits: 5 });
  await u.put("/api/v1/meetings/mt-1", { doc: sampleMeeting("mt-1") });
});
after(async () => ctx.close());
beforeEach(() => {
  ctx.anthropic.failWith = null;
  ctx.anthropic.stopReason = "end_turn";
  ctx.anthropic.calls.length = 0;
});
const balance = async () => (await ctx.db.one("SELECT balance FROM credit_balances WHERE user_id = $1", [u.me.id])).balance;

test("concessão do ciclo: uma vez por fatura e com teto de 30", async () => {
  const db = ctx.db;
  const { id } = (await login(ctx)).me;
  const cfg = { perCycle: 15, max: 30 };
  assert.equal(await grantCycle(db, id, "invoice:1", new Date(), cfg), 15);
  assert.equal(await grantCycle(db, id, "invoice:1", new Date(), cfg), null, "a mesma fatura não concede de novo");
  assert.equal(await grantCycle(db, id, "invoice:2", new Date(), cfg), 30);
  assert.equal(await grantCycle(db, id, "invoice:3", new Date(), cfg), 30, "não passa de 30");
});

test("ata em streaming: consome 1 crédito, mede o custo e salva na reunião", async () => {
  const before = await balance();
  const r = await u.post("/api/v1/ai/summary", { meetingId: "mt-1" });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-type"], /text\/event-stream/);
  const events = parseSse(r.body);
  assert.equal(events[0].event, "start");
  assert.ok(events.filter((e) => e.event === "delta").length > 1);
  const done = events.find((e) => e.event === "done");
  assert.equal(done.data.text, ctx.anthropic.text);
  assert.equal(await balance(), before - 1);

  const call = ctx.anthropic.calls[0].params;
  assert.equal(call.model, "claude-sonnet-5-5");
  assert.equal(call.output_config.effort, "medium");
  assert.match(call.messages[0].content, /orçamento do quarto trimestre/);

  const req = await ctx.db.one("SELECT status, cost_usd::float AS cost FROM ai_requests WHERE kind = 'summary'");
  assert.equal(req.status, "done");
  assert.ok(Math.abs(req.cost - (1000 * 2 + 200 * 10) / 1e6) < 1e-6);

  const doc = (await u.get("/api/v1/meetings/mt-1")).json();
  assert.equal(doc.doc.summary.text, ctx.anthropic.text);
  assert.equal(doc.version, 2);
});

test("falha da IA devolve o crédito", async () => {
  const before = await balance();
  ctx.anthropic.failWith = Object.assign(new Error("overloaded"), { status: 529 });
  const r = await u.post("/api/v1/ai/ask", { meetingId: "mt-1", history: [{ role: "user", text: "O que foi decidido?" }] });
  const events = parseSse(r.body);
  const err = events.find((e) => e.event === "error");
  assert.match(err.data.message, /crédito foi devolvido/);
  assert.equal(await balance(), before);
  assert.equal((await ctx.db.one("SELECT status FROM ai_requests WHERE kind = 'ask' ORDER BY created_at DESC LIMIT 1")).status, "failed");
});

test("pergunta usa o modelo rápido e o cache da transcrição", async () => {
  const r = await u.post("/api/v1/ai/ask", { meeting: sampleMeeting("mt-live"), history: [{ role: "user", text: "Quem aprovou a mídia?" }] });
  assert.ok(parseSse(r.body).some((e) => e.event === "done"));
  const p = ctx.anthropic.calls[0].params;
  assert.equal(p.model, "claude-haiku-5-5");
  assert.deepEqual(p.system[0].cache_control, { type: "ephemeral" });
  assert.match(p.system[0].text, /Bruno/);
});

test("revisão: 1 crédito por reunião a cada 24 h", async () => {
  ctx.anthropic.reviewText = JSON.stringify({ fixes: [{ id: "1", text: "Bom dia, vamos revisar o orçamento do Q4." }] });
  const items = [{ id: "1", speaker: "Ana", text: "Bom dia, vamos revisar o orçamento do quiu quatro." }];
  const before = await balance();
  const a = await u.post("/api/v1/ai/review", { meetingId: "mt-1", items, glossary: "Q4" });
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json().fixes, { 1: "Bom dia, vamos revisar o orçamento do Q4." });
  assert.equal(a.json().credits, 1);
  const b = await u.post("/api/v1/ai/review", { meetingId: "mt-1", items });
  assert.equal(b.json().credits, 0, "o segundo lote da mesma reunião não cobra");
  assert.equal(await balance(), before - 1);
  assert.equal(ctx.anthropic.calls[0].params.output_config.format.type, "json_schema");
});

test("sem créditos: 402 com a data da renovação e sem chamar a IA", async () => {
  await ctx.db.query("UPDATE credit_balances SET balance = 0 WHERE user_id = $1", [u.me.id]);
  const r = await u.post("/api/v1/ai/ask", { meetingId: "mt-1", history: [{ role: "user", text: "Resumo?" }] });
  assert.equal(r.statusCode, 402);
  assert.equal(r.json().error, "no_credits");
  assert.ok(r.json().renewsAt);
  assert.equal(ctx.anthropic.calls.length, 0);
  await ctx.db.query("UPDATE credit_balances SET balance = 10 WHERE user_id = $1", [u.me.id]);
});

test("reunião longa custa 2 créditos; perguntar a todas as reuniões custa 2", async () => {
  const long = sampleMeeting("mt-long");
  long.entries = Array.from({ length: 2500 }, (_, i) => ({
    id: `l${i}`, at: long.startedAt + i * 4000, updatedAt: long.startedAt + i * 4000 + 3000, speakerId: i % 2 ? "a" : "b",
    text: "Esta é uma fala comprida para simular uma reunião de mais de três horas de duração.", kind: "caption",
  }));
  const b0 = await balance();
  await u.post("/api/v1/ai/summary", { meeting: long });
  assert.equal(await balance(), b0 - 2);
  const r = await u.post("/api/v1/ai/ask_all", { history: [{ role: "user", text: "O que decidimos sobre mídia?" }] });
  assert.ok(parseSse(r.body).some((e) => e.event === "done"));
  assert.equal(await balance(), b0 - 4);
  assert.match(ctx.anthropic.calls.at(-1).params.system[0].text, /<reuniao titulo="Planejamento do orçamento"/);
});

test("ata com modelo do usuário: o modelo vai no prompt e a resposta segue o formato", async () => {
  const template = "# Registro de Reunião {{numero_do_registro}}\n**Data:** {{data}}\n**Participantes:**\n{{participantes}}\n## Conclusão\n{{conclusao}}\n\nRAFAEL CORREA COSTA\nPromotor de Justiça";
  const r = await u.post("/api/v1/ai/summary", { meetingId: "mt-1", template });
  assert.equal(r.statusCode, 200);
  const call = ctx.anthropic.calls.at(-1).params;
  const sys = Array.isArray(call.system) ? call.system.map((b) => b.text).join("") : call.system;
  const user = Array.isArray(call.messages[0].content) ? call.messages[0].content.map((b) => b.text || "").join("") : call.messages[0].content;
  assert.match(sys, /EXATAMENTE o modelo/);
  assert.match(user, /<modelo>[\s\S]*Promotor de Justiça[\s\S]*<\/modelo>/);
  assert.ok(user.includes("<transcricao"), "a transcrição continua no prompt");
});

test("modelo a partir de uma ata existente (texto ou PDF): 1 crédito, texto do modelo de volta", async () => {
  ctx.anthropic.reviewText = "# Registro de Reunião {{numero_do_registro}}\n**Data:** {{data}}";
  const before = await balance();
  const a = await u.post("/api/v1/ai/template", { text: "Registro de Reunião 2026000638386\nData: 16 de janeiro de 2026\nParticipantes: Ana, Bruno\nConclusão: a reunião foi encerrada." });
  assert.equal(a.statusCode, 200);
  assert.match(a.json().text, /\{\{data\}\}/);
  assert.equal(a.json().credits, 1);
  assert.equal(await balance(), before - 1);
  const pdf = Buffer.from("%PDF-1.4 fake").toString("base64");
  const b = await u.post("/api/v1/ai/template", { pdfBase64: pdf });
  assert.equal(b.statusCode, 200);
  const params = ctx.anthropic.calls.at(-1).params;
  assert.equal(params.messages[0].content[0].type, "document");
  assert.equal(params.messages[0].content[0].source.media_type, "application/pdf");
  const bad = await u.post("/api/v1/ai/template", { text: "curto" });
  assert.equal(bad.statusCode, 400);
});

test("teto diário de gasto pausa a IA inclusa", async () => {
  await ctx.db.query("INSERT INTO ai_requests (user_id, kind, model, cost_usd, status) VALUES ($1, 'summary', 'x', $2, 'done')", [
    u.me.id, ctx.config.aiDailyBudgetUsd,
  ]);
  const r = await u.post("/api/v1/ai/ask", { meetingId: "mt-1", history: [{ role: "user", text: "Oi?" }] });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, "ai_paused");
});
