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

test("checkout em reais oferece cartão e Pix Automático", async () => {
  const r = await u.post("/api/v1/billing/checkout", { currency: "brl" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().url, "https://checkout.stripe.test/cs_test");
  const p = ctx.stripe.calls.find((c) => c[0] === "checkout.create")[1];
  assert.equal(p.mode, "subscription");
  assert.deepEqual(p.payment_method_types, ["card", "pix"]);
  assert.deepEqual(p.payment_method_options.pix.mandate_options, {
    amount: 2000, amount_type: "maximum", payment_schedule: "monthly", reference: "Reunilo Pro",
  });
  assert.equal(p.line_items[0].price, "price_brl");
  assert.equal(p.client_reference_id, u.me.id);
  assert.match(p.success_url, /\/app\/#\/conta\?assinatura=ok$/);
});

test("checkout em dólar: só cartão", async () => {
  await u.post("/api/v1/billing/checkout", { currency: "usd" });
  const p = ctx.stripe.calls.filter((c) => c[0] === "checkout.create").at(-1)[1];
  assert.deepEqual(p.payment_method_types, ["card"]);
  assert.equal(p.line_items[0].price, "price_usd");
  assert.equal(p.payment_method_options, undefined);
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
