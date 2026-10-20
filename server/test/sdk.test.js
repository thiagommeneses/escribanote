// Os SDKs reais (Anthropic e Stripe) contra servidores locais que imitam as APIs:
// confere o que vai pela rede (parâmetros, streaming) sem chave nem custo.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import { buildApp } from "../src/app.js";
import { login, makePro, parseSse, sampleMeeting, setup } from "./helpers.js";

const seen = [];
let server, port, ctx, app, u;

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/v1/messages") {
        const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } };
        return sse(res, [
          { type: "message_start", message: msg },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bruno aprovou " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a mídia." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 900, output_tokens: 12, cache_read_input_tokens: 800 } },
          { type: "message_stop" },
        ]);
      }
      if (req.url.startsWith("/v1/customers")) return json(res, { id: "cus_real", object: "customer" });
      if (req.url.startsWith("/v1/checkout/sessions")) return json(res, { id: "cs_real", object: "checkout.session", url: "https://checkout.stripe.com/c/cs_real" });
      json(res, { error: { message: "não simulado" } }, 404);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  ctx = await setup();
  await ctx.app.close();
  app = await buildApp({
    config: ctx.config,
    db: ctx.db,
    mailer: ctx.mailer,
    anthropic: new Anthropic({ apiKey: "sk-ant-teste", baseURL: `http://127.0.0.1:${port}` }),
    stripe: new Stripe("sk_test_123", { host: "127.0.0.1", port, protocol: "http" }),
  });
  ctx.app = app;
  u = await login(ctx);
  await makePro(ctx, u.me.id);
});
after(async () => {
  await app.close();
  await ctx.db.close();
  server.close();
});

const json = (res, data, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
};

test("SDK da Anthropic: streaming, cache, esforço e custo", async () => {
  const r = await u.post("/api/v1/ai/ask", { meeting: sampleMeeting("mt-sdk"), history: [{ role: "user", text: "Quem aprovou a mídia?" }] });
  const events = parseSse(r.body);
  const done = events.find((e) => e.event === "done");
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.data.text, "Bruno aprovou a mídia.");
  const call = seen.find((s) => s.url === "/v1/messages");
  assert.equal(call.headers["x-api-key"], "sk-ant-teste");
  const body = JSON.parse(call.body);
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.stream, true);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  const row = await ctx.db.one("SELECT input_tokens, cache_read_tokens, cost_usd::float AS cost FROM ai_requests WHERE meeting_id = 'mt-sdk'");
  assert.equal(row.input_tokens, 900);
  assert.equal(row.cache_read_tokens, 800);
  assert.ok(row.cost > 0);
});

test("SDK da Stripe: Checkout anual com Pix Automático codificado como a API espera", async () => {
  const novo = await login(ctx);
  const r = await novo.post("/api/v1/billing/checkout", { currency: "brl", interval: "year" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().url, "https://checkout.stripe.com/c/cs_real");
  const call = seen.find((s) => s.url === "/v1/checkout/sessions");
  const form = new URLSearchParams(call.body);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("payment_method_types[0]"), "card");
  assert.equal(form.get("payment_method_types[1]"), "pix");
  assert.equal(form.get("payment_method_options[pix][mandate_options][amount]"), "18000");
  assert.equal(form.get("payment_method_options[pix][mandate_options][amount_type]"), "maximum");
  assert.equal(form.get("payment_method_options[pix][mandate_options][payment_schedule]"), "yearly");
  assert.equal(form.get("payment_method_options[pix][mandate_options][reference]"), "Reunilo Pro anual");
  assert.equal(form.get("line_items[0][price]"), "price_brl_year");
  assert.match(call.headers["stripe-version"] || "", /^\d{4}-\d{2}-\d{2}/);
});
