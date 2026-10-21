import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, makePro, setup } from "./helpers.js";

let ctx;
before(async () => (ctx = await setup()));
after(async () => ctx.close());

test("saúde da API", async () => {
  const r = await ctx.app.inject("/api/v1/health");
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);
});

test("login por link mágico: e-mail, uso único e conta grátis", async () => {
  const r = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/email", payload: { email: "Ana@Exemplo.com " } });
  assert.equal(r.statusCode, 202);
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(mail.to, "ana@exemplo.com");
  assert.match(mail.text, /https:\/\/escribanote\.test\/app\/#\/entrar\/[\w-]{40,}/);
  const token = mail.text.match(/#\/entrar\/([\w-]+)/)[1];

  const v = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify", payload: { token } });
  assert.equal(v.statusCode, 200);
  assert.equal(v.json().email, "ana@exemplo.com");
  assert.equal(v.json().plan, "free");
  const c = v.cookies.find((x) => x.name === "rs");
  assert.ok(c.httpOnly && c.secure && c.sameSite === "Lax");

  const again = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify", payload: { token } });
  assert.equal(again.statusCode, 400, "o link só funciona uma vez");
  assert.equal(again.json().error, "invalid_token");

  // o token nunca é guardado em texto puro
  const raw = await ctx.db.one("SELECT encode(token_hash, 'hex') AS h FROM login_tokens LIMIT 1");
  assert.notEqual(raw.h, token);
});

test("e-mail inválido e limite de pedidos", async () => {
  const bad = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/email", payload: { email: "nao-e-email" } });
  assert.equal(bad.statusCode, 400);
  let last;
  for (let i = 0; i < 5; i++) last = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/email", payload: { email: "limite@exemplo.com" } });
  assert.equal(last.statusCode, 429);
});

test("sem sessão: 401; escrita pelo cookie exige o cabeçalho do app (CSRF)", async () => {
  assert.equal((await ctx.app.inject("/api/v1/me")).statusCode, 401);
  const u = await login(ctx);
  const noHeader = await ctx.app.inject({ method: "POST", url: "/api/v1/devices", cookies: { rs: u.cookie }, payload: {} });
  assert.equal(noHeader.statusCode, 403);
  const otherOrigin = await u.req("POST", "/api/v1/devices", {}, { origin: "https://malicioso.example" });
  assert.equal(otherOrigin.statusCode, 403);
  const ok = await u.post("/api/v1/devices", { name: "Chrome do escritório" });
  assert.equal(ok.statusCode, 200);
});

test("token da extensão: acessa a conta, não cria dispositivos, pode ser revogado", async () => {
  const u = await login(ctx);
  const dev = (await u.post("/api/v1/devices", { name: "Extensão" })).json();
  const bearer = { authorization: `Bearer ${dev.token}` };
  const me = await ctx.app.inject({ url: "/api/v1/me", headers: bearer });
  assert.equal(me.json().email, u.email);
  const nested = await ctx.app.inject({ method: "POST", url: "/api/v1/devices", headers: bearer, payload: {} });
  assert.equal(nested.statusCode, 403);
  const list = (await u.get("/api/v1/devices")).json();
  assert.equal(list.length, 1);
  assert.equal((await u.del(`/api/v1/devices/${dev.id}`)).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: "/api/v1/me", headers: bearer })).statusCode, 401);
});

test("CORS liberado só para a extensão", async () => {
  const ext = await ctx.app.inject({
    method: "OPTIONS",
    url: "/api/v1/meetings",
    headers: { origin: ctx.config.extensionOrigin, "access-control-request-method": "PUT" },
  });
  assert.equal(ext.statusCode, 204);
  assert.equal(ext.headers["access-control-allow-origin"], ctx.config.extensionOrigin);
  const other = await ctx.app.inject({ url: "/api/v1/health", headers: { origin: "https://outro.example" } });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});

test("apagar a conta: confirma pelo e-mail, cancela a assinatura e remove tudo", async () => {
  const u = await login(ctx);
  await makePro(ctx, u.me.id);
  await ctx.db.query("UPDATE subscriptions SET stripe_subscription_id = 'sub_x' WHERE user_id = $1", [u.me.id]);
  assert.equal((await u.del("/api/v1/me", { confirm: "outro@exemplo.com" })).statusCode, 400);
  const r = await u.del("/api/v1/me", { confirm: u.email });
  assert.equal(r.statusCode, 202);
  assert.deepEqual(ctx.stripe.calls.at(-1), ["subscriptions.cancel", "sub_x"]);
  assert.equal(await ctx.db.one("SELECT 1 FROM users WHERE id = $1", [u.me.id]), null);
  assert.equal((await u.get("/api/v1/me")).statusCode, 401);
});
