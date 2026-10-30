// Senha: cadastro/redefinição pelo link do e-mail, login com e-mail + senha, troca estando logado.
// Arquivo próprio: o limite de pedidos por IP é da instância, e o auth.test.js já gasta o dele.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, setup } from "./helpers.js";

let ctx;
before(async () => (ctx = await setup()));
after(async () => ctx.close());

test("senha: criar pelo link, entrar com e-mail + senha, erros não revelam a conta", async () => {
  const email = "senha@exemplo.com";
  const f = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email } });
  assert.equal(f.statusCode, 202);
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(mail.subject, "Defina a senha do Escribanote");
  const token = mail.text.match(/#\/senha\/([\w-]+)/)[1];

  // o link de senha não serve para o login sem senha, e vice-versa
  assert.equal((await ctx.app.inject({ method: "POST", url: "/api/v1/auth/verify", payload: { token } })).statusCode, 400);
  const weak = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "curta" } });
  assert.equal(weak.json().error, "weak_password");
  const r = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "uma senha boa" } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().email, email);
  assert.equal(r.json().hasPassword, true);
  assert.ok(r.cookies.find((c) => c.name === "rs"));

  const ok = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: " Senha@Exemplo.com", password: "uma senha boa" } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.cookies.find((c) => c.name === "rs"));
  const wrong = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "outra senha" } });
  const nobody = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "ninguem@exemplo.com", password: "outra senha" } });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json(), nobody.json(), "mesma resposta para senha errada e conta inexistente");

  // a senha nunca fica em texto puro
  const row = await ctx.db.one("SELECT password_hash FROM users WHERE email = $1", [email]);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes("uma senha boa"));
});

test("senha: redefinir encerra as outras sessões; trocar logado exige a atual", async () => {
  const u = await login(ctx);
  assert.equal(u.me.hasPassword, false);
  // sem senha ainda: define direto, sem a atual
  assert.equal((await u.put("/api/v1/auth/password", { password: "primeira senha" })).statusCode, 200);
  const bad = await u.put("/api/v1/auth/password", { current: "errada", password: "segunda senha" });
  assert.equal(bad.json().error, "wrong_password");
  assert.equal((await u.put("/api/v1/auth/password", { current: "primeira senha", password: "segunda senha" })).statusCode, 200);
  assert.equal((await u.get("/api/v1/me")).statusCode, 200, "a sessão atual continua");

  await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/forgot", payload: { email: u.email } });
  const mail = ctx.mailer.sent.at(-1);
  assert.equal(mail.subject, "Redefinir a senha do Escribanote");
  const token = mail.text.match(/#\/senha\/([\w-]+)/)[1];
  const r = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "terceira senha" } });
  assert.equal(r.statusCode, 200);
  assert.equal((await u.get("/api/v1/me")).statusCode, 401, "a sessão antiga do app foi encerrada");
  const again = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/password/reset", payload: { token, password: "quarta senha" } });
  assert.equal(again.statusCode, 400, "o link de senha só funciona uma vez");
  const ok = await ctx.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: u.email, password: "terceira senha" } });
  assert.equal(ok.statusCode, 200);
});
