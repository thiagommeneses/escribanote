import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, sampleMeeting, setup, signedWebhook } from "./helpers.js";

let ctx, u;
before(async () => {
  ctx = await setup();
  u = await login(ctx);
});
after(async () => ctx.close());

const webhook = (event) => {
  const { payload, headers } = signedWebhook(event);
  return ctx.app.inject({ method: "POST", url: "/api/v1/billing/webhook", payload, headers });
};

test("checkout anual em reais oferece cartão e Pix Automático anual", async () => {
  const r = await u.post("/api/v1/billing/checkout", { currency: "brl", interval: "year" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().url, "https://checkout.stripe.test/cs_test");
  const p = ctx.stripe.calls.find((c) => c[0] === "checkout.create")[1];
  assert.equal(p.mode, "subscription");
  assert.deepEqual(p.payment_method_types, ["card", "pix"]);
  assert.deepEqual(p.payment_method_options.pix.mandate_options, {
    amount: 18000, amount_type: "maximum", payment_schedule: "yearly", reference: "Reunilo Pro anual",
  });
  assert.equal(p.line_items[0].price, "price_brl_year");
  assert.equal(p.client_reference_id, u.me.id);
  assert.match(p.success_url, /\/app\/#\/conta\?assinatura=ok$/);
});

test("sem intervalo, o checkout vai para o anual", async () => {
  await u.post("/api/v1/billing/checkout", { currency: "brl" });
  assert.equal(ctx.stripe.calls.filter((c) => c[0] === "checkout.create").at(-1)[1].line_items[0].price, "price_brl_year");
});

test("checkout mensal em reais: só cartão (Pix é só no anual)", async () => {
  await u.post("/api/v1/billing/checkout", { currency: "brl", interval: "month" });
  const p = ctx.stripe.calls.filter((c) => c[0] === "checkout.create").at(-1)[1];
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.line_items[0].price, "price_brl");
  assert.equal(p.payment_method_options, undefined);
});

test("checkout em dólar: só cartão, mensal ou anual", async () => {
  await u.post("/api/v1/billing/checkout", { currency: "usd", interval: "month" });
  let p = ctx.stripe.calls.filter((c) => c[0] === "checkout.create").at(-1)[1];
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.line_items[0].price, "price_usd");
  assert.equal(p.payment_method_options, undefined);
  await u.post("/api/v1/billing/checkout", { currency: "usd", interval: "year" });
  p = ctx.stripe.calls.filter((c) => c[0] === "checkout.create").at(-1)[1];
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.line_items[0].price, "price_usd_year");
});

test("webhook com assinatura inválida é recusado", async () => {
  const r = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/billing/webhook",
    payload: JSON.stringify({ id: "evt_x", type: "invoice.paid", data: { object: {} } }),
    headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
  });
  assert.equal(r.statusCode, 400);
});

test("fluxo completo: checkout concluído, fatura paga (créditos), evento repetido e cancelamento", async () => {
  const customer = (await ctx.db.one("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [u.me.id])).stripe_customer_id;
  const end = Math.floor(Date.now() / 1000) + 30 * 86400;
  const sub = {
    id: "sub_1", object: "subscription", customer, status: "active", currency: "brl", cancel_at_period_end: false,
    metadata: { user_id: u.me.id }, items: { data: [{ price: { id: "price_brl" }, current_period_end: end }] },
  };
  ctx.stripe.subs.set("sub_1", sub);

  let r = await webhook({ id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", customer, client_reference_id: u.me.id } } });
  assert.equal(r.statusCode, 200);
  let me = (await u.get("/api/v1/me")).json();
  assert.equal(me.plan, "pro");
  assert.equal(me.subscription.currency, "brl");

  const invoice = { id: "in_1", customer, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } }, lines: { data: [{ period: { end } }] } };
  r = await webhook({ id: "evt_2", type: "invoice.paid", data: { object: invoice } });
  assert.equal(r.statusCode, 200);
  me = (await u.get("/api/v1/me")).json();
  assert.equal(me.credits.balance, 15);

  r = await webhook({ id: "evt_2", type: "invoice.paid", data: { object: invoice } });
  assert.equal(r.json().duplicate, true);
  r = await webhook({ id: "evt_3", type: "invoice.paid", data: { object: invoice } });
  assert.equal((await u.get("/api/v1/me")).json().credits.balance, 15, "a mesma fatura não concede duas vezes");

  // Pro: pode sincronizar
  assert.equal((await u.put("/api/v1/meetings/m1", { doc: sampleMeeting("m1") })).statusCode, 200);

  await webhook({ id: "evt_4", type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
  me = (await u.get("/api/v1/me")).json();
  assert.equal(me.plan, "free");
  assert.equal((await u.put("/api/v1/meetings/m1", { doc: sampleMeeting("m1"), baseVersion: 1 })).statusCode, 402);
  assert.equal((await u.get("/api/v1/meetings/m1")).statusCode, 200, "depois de cancelar, ainda dá para ler e exportar");
});

test("portal do cliente", async () => {
  const r = await u.post("/api/v1/billing/portal");
  assert.equal(r.json().url, "https://billing.stripe.test/p");
});

test("não deixa assinar duas vezes", async () => {
  await ctx.db.query("UPDATE subscriptions SET status = 'active' WHERE user_id = $1", [u.me.id]);
  const r = await u.post("/api/v1/billing/checkout", { currency: "brl" });
  assert.equal(r.statusCode, 409);
});

test("plano anual: 15 créditos na fatura e mais 15 a cada mês, até o fim do período", async () => {
  const { grantMonthly, addMonths } = await import("../src/credits.js");
  const a = await login(ctx, "anual@exemplo.com");
  await a.post("/api/v1/billing/checkout", { currency: "brl", interval: "year" });
  const customer = (await ctx.db.one("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [a.me.id])).stripe_customer_id;
  const start = new Date(Date.UTC(2026, 0, 31, 12));
  const end = addMonths(start, 12);
  const sec = (d) => Math.floor(d.getTime() / 1000);
  const sub = {
    id: "sub_year", object: "subscription", customer, status: "active", currency: "brl", cancel_at_period_end: false, metadata: { user_id: a.me.id },
    items: { data: [{ price: { id: "price_brl_year", recurring: { interval: "year" } }, current_period_start: sec(start), current_period_end: sec(end) }] },
  };
  ctx.stripe.subs.set("sub_year", sub);
  await webhook({ id: "evt_y1", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_year", customer, client_reference_id: a.me.id } } });
  await webhook({ id: "evt_y2", type: "invoice.paid", data: { object: {
    id: "in_year", customer, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_year" } },
    lines: { data: [{ period: { start: sec(start), end: sec(end) } }] },
  } } });
  let me = (await a.get("/api/v1/me")).json();
  assert.equal(me.subscription.interval, "year");
  assert.equal(me.credits.balance, 15);
  assert.equal(me.credits.renewsAt.slice(0, 10), "2026-02-28", "31/01 + 1 mês cai no último dia de fevereiro");

  // Um mês depois: +15 (acumula até 30). Rodar de novo no mesmo mês não concede outra vez.
  await grantMonthly(ctx.db, ctx.config.credits, new Date(Date.UTC(2026, 1, 28, 13)));
  await grantMonthly(ctx.db, ctx.config.credits, new Date(Date.UTC(2026, 2, 5)));
  me = (await a.get("/api/v1/me")).json();
  assert.equal(me.credits.balance, 30);
  assert.equal(me.credits.renewsAt.slice(0, 10), "2026-03-31");

  // Gastou tudo; no fim do ano recebeu os meses que faltavam, sem passar do teto, e nada depois do período.
  await ctx.db.query("UPDATE credit_balances SET balance = 0 WHERE user_id = $1", [a.me.id]);
  await grantMonthly(ctx.db, ctx.config.credits, new Date(Date.UTC(2027, 5, 1)));
  const grants = await ctx.db.one("SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND reason = 'grant'", [a.me.id]);
  assert.equal(grants.n, 12, "1 da fatura + 11 mensais");
  assert.equal((await a.get("/api/v1/me")).json().credits.balance, 30);
});
