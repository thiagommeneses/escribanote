// Infra dos testes: Postgres real (TEST_DATABASE_URL), e-mail, Claude e Stripe simulados.
import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, migrate } from "../src/db.js";

export const DB_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:teste@127.0.0.1:55432/reunilo_test";
export const WEBHOOK_SECRET = "whsec_teste";
const realStripe = new Stripe("sk_test_dummy");

export function fakeMailer() {
  const sent = [];
  return { sent, async send(m) { sent.push(m); } };
}

export function fakeAnthropic() {
  const fake = {
    calls: [],
    text: "## Resumo\nReunião sobre o orçamento do Q4.",
    reviewText: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    failWith: null,
    stopReason: "end_turn",
    messages: {
      stream(params) {
        fake.calls.push({ kind: "stream", params });
        const parts = fake.text.match(/.{1,12}/gs) || [];
        return {
          async *[Symbol.asyncIterator]() {
            if (fake.failWith) throw fake.failWith;
            for (const p of parts) yield { type: "content_block_delta", delta: { type: "text_delta", text: p } };
          },
          finalMessage: async () => ({ stop_reason: fake.stopReason, usage: fake.usage }),
          abort() {},
        };
      },
      async create(params) {
        fake.calls.push({ kind: "create", params });
        if (fake.failWith) throw fake.failWith;
        return { content: [{ type: "text", text: fake.reviewText ?? '{"fixes":[]}' }], stop_reason: fake.stopReason, usage: fake.usage };
      },
    },
  };
  return fake;
}

export function fakeStripe() {
  const s = {
    calls: [],
    subs: new Map(),
    customers: { create: async (p) => (s.calls.push(["customers.create", p]), { id: `cus_${randomBytes(4).toString("hex")}` }) },
    checkout: { sessions: { create: async (p) => (s.calls.push(["checkout.create", p]), { id: "cs_test", url: "https://checkout.stripe.test/cs_test" }) } },
    billingPortal: { sessions: { create: async (p) => (s.calls.push(["portal.create", p]), { url: "https://billing.stripe.test/p" }) } },
    subscriptions: {
      retrieve: async (id) => s.subs.get(id),
      cancel: async (id) => (s.calls.push(["subscriptions.cancel", id]), { id, status: "canceled" }),
    },
    webhooks: realStripe.webhooks,
  };
  return s;
}

export async function setup(overrides = {}) {
  const db = createDb(DB_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.query("DROP TEXT SEARCH CONFIGURATION IF EXISTS pt_unaccent");
  await migrate(db);
  const config = loadConfig({
    publicUrl: "https://reunilo.test",
    dataKey: randomBytes(32).toString("base64"),
    stripe: { secretKey: "sk_test", webhookSecret: WEBHOOK_SECRET, priceBrl: "price_brl", priceBrlYear: "price_brl_year", priceUsd: "price_usd", priceUsdYear: "price_usd_year", pixMandateMax: 18000 },
    ...overrides,
  });
  config.origin = "https://reunilo.test";
  const mailer = fakeMailer();
  const anthropic = fakeAnthropic();
  const stripe = fakeStripe();
  const app = await buildApp({ config, db, mailer, anthropic, stripe });
  return { app, db, config, mailer, anthropic, stripe, close: async () => (await app.close(), await db.close()) };
}

// Faz login pelo link mágico e devolve um cliente com o cookie da sessão.
export async function login(ctx, email = `pessoa${randomBytes(3).toString("hex")}@exemplo.com`) {
  const r = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/email", payload: { email } });
  if (r.statusCode !== 202) throw new Error(`login: ${r.statusCode} ${r.body}`);
  const token = ctx.mailer.sent.at(-1).text.match(/#\/entrar\/([\w-]+)/)[1];
  const v = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify", payload: { token } });
  const cookie = v.cookies.find((c) => c.name === "rs");
  const me = v.json();
  const req = (method, url, payload, headers = {}) =>
    ctx.app.inject({ method, url, payload, cookies: { rs: cookie.value }, headers: { "x-reunilo": "1", ...headers } });
  return { me, cookie: cookie.value, email, req, get: (u) => req("GET", u), post: (u, p) => req("POST", u, p), put: (u, p) => req("PUT", u, p), del: (u, p) => req("DELETE", u, p) };
}

export async function makePro(ctx, userId, { credits = 15 } = {}) {
  await ctx.db.query(
    `INSERT INTO subscriptions (user_id, status, currency, current_period_end) VALUES ($1, 'active', 'brl', now() + interval '30 days')
     ON CONFLICT (user_id) DO UPDATE SET status = 'active'`,
    [userId],
  );
  await ctx.db.query(
    `INSERT INTO credit_balances (user_id, balance, renews_at) VALUES ($1, $2, now() + interval '30 days')
     ON CONFLICT (user_id) DO UPDATE SET balance = $2`,
    [userId, credits],
  );
}

export function sampleMeeting(id = "mt-1", over = {}) {
  const t0 = Date.UTC(2026, 9, 17, 23, 34);
  return {
    id,
    title: "Planejamento do orçamento",
    platform: "meet",
    startedAt: t0,
    updatedAt: t0 + 120_000,
    endedAt: t0 + 120_000,
    speakers: { a: "Ana", b: "Bruno" },
    entries: [
      { id: "1", at: t0 + 1000, updatedAt: t0 + 3000, speakerId: "a", text: "Bom dia, vamos revisar o orçamento do quarto trimestre.", kind: "caption" },
      { id: "2", at: t0 + 5000, updatedAt: t0 + 8000, speakerId: "b", text: "Eu aprovo a proposta de mídia de 180 mil.", kind: "caption" },
    ],
    highlights: { 2: ["decisao"] },
    notes: { text: "", items: [] },
    ...over,
  };
}

// Lê um corpo SSE em eventos {event, data}.
export function parseSse(body) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const ev = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });
}

export function signedWebhook(event) {
  const payload = JSON.stringify(event);
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, headers: { "stripe-signature": header, "content-type": "application/json" } };
}
