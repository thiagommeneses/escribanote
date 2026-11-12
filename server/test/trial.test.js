import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, makePro, sampleMeeting, setup } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => ctx.close());

test("teste grátis: 48 h de Pro e 5 créditos, sem cartão; a IA libera; uma vez só", async () => {
  const u = await login(ctx);
  let me = (await u.get("/api/v1/me")).json();
  assert.equal(me.plan, "free");
  assert.deepEqual({ ...me.trial }, { available: true, active: false, endsAt: null, hours: 48, credits: 5 });
  assert.equal((await u.put("/api/v1/meetings/mt-t", { doc: sampleMeeting("mt-t") })).statusCode, 402, "sem Pro, não sincroniza");

  const r = await u.post("/api/v1/billing/trial", {});
  assert.equal(r.statusCode, 200, r.body);
  me = r.json();
  assert.equal(me.plan, "pro");
  assert.equal(me.trial.active, true);
  assert.equal(me.trial.available, false);
  assert.equal(me.credits.balance, 5);
  const hours = (new Date(me.trial.endsAt) - Date.now()) / 3600_000;
  assert.ok(hours > 47.9 && hours <= 48, "48 h: " + hours);
  assert.equal(me.subscription.status, "trial");
  assert.equal(ctx.stripe.calls.length, 0, "não passa pela Stripe");
  assert.equal((await u.put("/api/v1/meetings/mt-t", { doc: sampleMeeting("mt-t") })).statusCode, 200, "no teste, sincroniza");

  const again = await u.post("/api/v1/billing/trial", {});
  assert.equal(again.statusCode, 409);
  assert.equal((await u.get("/api/v1/me")).json().credits.balance, 5, "não ganha créditos de novo");
});

test("teste vencido: volta para o grátis e não pode testar de novo", async () => {
  const u = await login(ctx);
  assert.equal((await u.post("/api/v1/billing/trial", {})).statusCode, 200);
  await ctx.db.query("UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE user_id = $1", [u.me.id]);
  const me = (await u.get("/api/v1/me")).json();
  assert.equal(me.plan, "free");
  assert.equal(me.trial.active, false);
  assert.equal(me.trial.available, false);
  assert.equal((await u.put("/api/v1/meetings/mt-v", { doc: sampleMeeting("mt-v") })).statusCode, 402);
  // durante ou depois do teste, pode assinar normalmente
  const c = await u.post("/api/v1/billing/checkout", { currency: "brl", interval: "year" });
  assert.equal(c.statusCode, 200, c.body);
});

test("apagar a conta e criar de novo com o mesmo e-mail não dá outro teste", async () => {
  const email = "repete@exemplo.com";
  const u = await login(ctx, email);
  assert.equal((await u.post("/api/v1/billing/trial", {})).statusCode, 200);
  const del = await u.del("/api/v1/me", { confirm: email });
  assert.equal(del.statusCode, 202, del.body);
  const u2 = await login(ctx, email.toUpperCase());
  const me = (await u2.get("/api/v1/me")).json();
  assert.equal(me.trial.available, false);
  assert.equal((await u2.post("/api/v1/billing/trial", {})).statusCode, 409);
});

test("quem já assina não tem teste", async () => {
  const u = await login(ctx);
  await makePro(ctx, u.me.id);
  const me = (await u.get("/api/v1/me")).json();
  assert.equal(me.trial.available, false);
  assert.equal((await u.post("/api/v1/billing/trial", {})).statusCode, 409);
});

test("aviso do fim do teste: um e-mail só, nas últimas 6 horas, e nunca para quem assinou", async () => {
  const { trialReminders } = await import("../src/reminders.js");
  const a = await login(ctx);
  const b = await login(ctx);
  const c = await login(ctx);
  for (const u of [a, b, c]) assert.equal((await u.post("/api/v1/billing/trial", {})).statusCode, 200);
  await ctx.db.query("UPDATE subscriptions SET current_period_end = now() + interval '5 hours' WHERE user_id = ANY($1)", [[a.me.id, c.me.id]]);
  await ctx.db.query("UPDATE subscriptions SET status = 'active' WHERE user_id = $1", [c.me.id]); // assinou durante o teste
  const before = ctx.mailer.sent.length;
  assert.equal(await trialReminders(ctx.db, ctx.mailer, ctx.config), 1);
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(ctx.mailer.sent.length, before + 1);
  assert.equal(mail.to, a.email, "só quem está a menos de 6 h do fim (b ainda tem 48 h)");
  assert.match(mail.subject, /termina em cerca de 5 horas/);
  assert.match(mail.text, /https:\/\/escribanote\.test\/app\/#\/conta\?plano=anual/);
  assert.match(mail.html, /começou o teste grátis/);
  assert.equal(await trialReminders(ctx.db, ctx.mailer, ctx.config), 0, "não repete");
  assert.equal(ctx.mailer.sent.length, before + 1);
});
