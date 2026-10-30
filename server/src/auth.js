// Contas: login por e-mail + senha ou link mágico, redefinição de senha, sessões do app (cookie), tokens da extensão, conta e exclusão (LGPD).
import { hashPassword, hashToken, newToken, verifyPassword } from "./crypto.js";
import { clientIp, fail, iso } from "./http.js";
import { loginEmail, passwordEmail } from "./mail.js";

const COOKIE = "rs";
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const ACTIVE = new Set(["active", "trialing", "past_due"]);

export const isPro = (sub) => !!sub && ACTIVE.has(sub.status);

export async function audit(db, userId, action, detail = {}, ip = "") {
  await db.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)", [userId, action, detail, ip]);
}

export async function account(db, userId, config) {
  const u = await db.one("SELECT id, email, name, created_at, password_hash IS NOT NULL AS has_password FROM users WHERE id = $1", [userId]);
  if (!u) return null;
  const sub = await db.one("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
  const cr = await db.one("SELECT balance, renews_at FROM credit_balances WHERE user_id = $1", [userId]);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: iso(u.created_at),
    hasPassword: u.has_password,
    plan: isPro(sub) ? "pro" : "free",
    subscription: sub && sub.status !== "none"
      ? {
          status: sub.status,
          currency: sub.currency,
          interval: sub.billing_interval || "month",
          periodEnd: iso(sub.current_period_end),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          paymentMethod: sub.payment_method,
        }
      : null,
    credits: { balance: cr?.balance ?? 0, renewsAt: iso(cr?.renews_at), perCycle: config.credits.perCycle, max: config.credits.max },
  };
}

async function createSession(db, userId, kind, name, days) {
  const token = newToken();
  const row = await db.one(
    `INSERT INTO auth_sessions (user_id, kind, token_hash, name, expires_at)
     VALUES ($1, $2, $3, $4, ${days ? `now() + interval '${Number(days)} days'` : "NULL"}) RETURNING id`,
    [userId, kind, hashToken(token), name],
  );
  return { token, id: row.id };
}

const PASSWORD_MIN = 8;
function checkPassword(password, email) {
  const pw = String(password ?? "");
  if (pw.length < PASSWORD_MIN) fail(400, "weak_password", `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`);
  if (pw.length > 200) fail(400, "weak_password", "A senha pode ter no máximo 200 caracteres.");
  if (email && pw.trim().toLowerCase() === email) fail(400, "weak_password", "A senha não pode ser o seu e-mail.");
  return pw;
}
// Comparação com um hash qualquer quando a conta não existe ou não tem senha: o tempo de resposta
// não revela se o e-mail tem conta.
const DUMMY_HASH = hashPassword("escribanote-sem-senha");

export function registerAuth(app, { db, config, mailer, limiter, stripe }) {
  const secure = config.publicUrl.startsWith("https://");
  const setCookie = (reply, token) =>
    reply.setCookie(COOKIE, token, { path: "/", httpOnly: true, secure, sameSite: "lax", maxAge: config.sessionDays * 86400 });

  // Autenticação: cookie do app ou "Authorization: Bearer" da extensão.
  app.decorateRequest("user", null);
  app.decorateRequest("session", null);
  app.decorate("authenticate", async (req) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    const token = bearer || req.cookies?.[COOKIE];
    if (!token) fail(401, "unauthenticated", "Entre na sua conta para continuar.");
    const s = await db.one(
      `SELECT s.id, s.kind, s.last_used_at, u.id AS user_id, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())`,
      [hashToken(token)],
    );
    if (!s) fail(401, "unauthenticated", "Sua sessão expirou. Entre de novo.");
    // Escrita pelo cookie exige o cabeçalho próprio do app e a origem certa (proteção contra CSRF).
    if (!bearer && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (req.headers["x-escribanote"] !== "1" || (origin && !config.origins.has(origin))) fail(403, "csrf", "Requisição recusada.");
    }
    if (bearer && s.kind !== "device") fail(401, "unauthenticated", "Token inválido.");
    if (Date.now() - new Date(s.last_used_at).getTime() > 5 * 60_000) {
      db.query("UPDATE auth_sessions SET last_used_at = now() WHERE id = $1", [s.id]).catch(() => {});
    }
    req.user = { id: s.user_id, email: s.email };
    req.session = { id: s.id, kind: s.kind };
  });
  const auth = { preHandler: app.authenticate };
  const webOnly = (req) => {
    if (req.session.kind !== "web") fail(403, "web_only", "Faça isso pelo app do Escribanote no navegador.");
  };

  // Link por e-mail: para entrar sem senha (purpose "login") ou para definir/redefinir a senha
  // ("password"; também é o cadastro com senha, já que confirma o e-mail). Limites compartilhados.
  async function emailToken(req, purpose) {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) fail(400, "invalid_email", "Confira o e-mail digitado.");
    const ip = clientIp(req);
    if (!limiter.take(`login-ip:${ip}`, 10, 15 * 60_000) || !limiter.take(`login-email:${email}`, 4, 15 * 60_000)) {
      fail(429, "rate_limited", "Muitos pedidos de acesso. Espere alguns minutos e tente de novo.");
    }
    const token = newToken();
    await db.query(
      `INSERT INTO login_tokens (token_hash, email, expires_at, ip, purpose) VALUES ($1, $2, now() + interval '${config.loginTokenMinutes} minutes', $3, $4)`,
      [hashToken(token), email, ip, purpose],
    );
    return { email, token };
  }
  async function useToken(req, purpose) {
    const token = String(req.body?.token || "");
    if (!limiter.take(`verify-ip:${clientIp(req)}`, 20, 15 * 60_000)) fail(429, "rate_limited", "Muitas tentativas. Espere alguns minutos.");
    const row = await db.one(
      "UPDATE login_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING email",
      [hashToken(token), purpose],
    );
    if (!row) fail(400, "invalid_token", "Este link expirou ou já foi usado. Peça um novo.");
    return db.one(
      "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id, email, (xmax = 0) AS created",
      [row.email],
    );
  }
  async function startWebSession(req, reply, userId) {
    const s = await createSession(db, userId, "web", req.headers["user-agent"]?.slice(0, 200) || "Navegador", config.sessionDays);
    setCookie(reply, s.token);
    return s;
  }

  app.post("/api/v1/auth/email", async (req, reply) => {
    const { email, token } = await emailToken(req, "login");
    // O token vai no fragmento (#): não aparece em logs nem no Referer.
    const link = `${config.publicUrl}/app/#/entrar/${token}`;
    await mailer.send({ to: email, ...loginEmail(link, config.loginTokenMinutes) });
    reply.code(202);
    return { ok: true };
  });

  app.post("/api/v1/auth/verify", async (req, reply) => {
    const user = await useToken(req, "login");
    await startWebSession(req, reply, user.id);
    await audit(db, user.id, user.created ? "signup" : "login", {}, clientIp(req));
    return account(db, user.id, config);
  });

  // E-mail + senha. A mesma resposta para conta inexistente, sem senha ou senha errada.
  app.post("/api/v1/auth/login", async (req, reply) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const ip = clientIp(req);
    if (!limiter.take(`pw-ip:${ip}`, 20, 15 * 60_000) || !limiter.take(`pw-email:${email}`, 8, 15 * 60_000)) {
      fail(429, "rate_limited", "Muitas tentativas. Espere alguns minutos ou entre pelo link no e-mail.");
    }
    const u = EMAIL_RE.test(email) && password ? await db.one("SELECT id, password_hash FROM users WHERE email = $1", [email]) : null;
    const ok = await verifyPassword(password, u?.password_hash || (await DUMMY_HASH));
    if (!u?.password_hash || !ok) fail(401, "invalid_credentials", "E-mail ou senha incorretos.");
    await startWebSession(req, reply, u.id);
    await audit(db, u.id, "login_password", {}, ip);
    return account(db, u.id, config);
  });

  // Esqueci a senha / criar senha: sempre 202, exista ou não a conta (não revela quem tem conta).
  app.post("/api/v1/auth/password/forgot", async (req, reply) => {
    const { email, token } = await emailToken(req, "password");
    const u = await db.one("SELECT password_hash IS NOT NULL AS has FROM users WHERE email = $1", [email]);
    const link = `${config.publicUrl}/app/#/senha/${token}`;
    await mailer.send({ to: email, ...passwordEmail(link, config.loginTokenMinutes, !!u?.has) });
    reply.code(202);
    return { ok: true };
  });

  // Link do e-mail + senha nova: grava, encerra as outras sessões do app e entra.
  app.post("/api/v1/auth/password/reset", async (req, reply) => {
    const password = checkPassword(req.body?.password);
    const user = await useToken(req, "password");
    checkPassword(password, user.email);
    await db.query("UPDATE users SET password_hash = $2, password_set_at = now(), updated_at = now() WHERE id = $1", [user.id, await hashPassword(password)]);
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'web' AND revoked_at IS NULL", [user.id]);
    await startWebSession(req, reply, user.id);
    await audit(db, user.id, user.created ? "signup" : "password_reset", {}, clientIp(req));
    return account(db, user.id, config);
  });

  // Definir ou trocar a senha estando logado. Trocar exige a senha atual.
  app.put("/api/v1/auth/password", auth, async (req) => {
    webOnly(req);
    const u = await db.one("SELECT email, password_hash FROM users WHERE id = $1", [req.user.id]);
    if (u.password_hash) {
      if (!limiter.take(`pw-change:${req.user.id}`, 8, 15 * 60_000)) fail(429, "rate_limited", "Muitas tentativas. Espere alguns minutos.");
      if (!(await verifyPassword(String(req.body?.current ?? ""), u.password_hash))) fail(400, "wrong_password", "A senha atual não confere.");
    }
    const password = checkPassword(req.body?.password, u.email);
    await db.query("UPDATE users SET password_hash = $2, password_set_at = now(), updated_at = now() WHERE id = $1", [req.user.id, await hashPassword(password)]);
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND kind = 'web' AND revoked_at IS NULL AND id <> $2", [req.user.id, req.session.id]);
    await audit(db, req.user.id, u.password_hash ? "password_change" : "password_set", {}, clientIp(req));
    return { ok: true };
  });

  app.post("/api/v1/auth/logout", auth, async (req, reply) => {
    await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1", [req.session.id]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/v1/me", auth, async (req) => account(db, req.user.id, config));

  // Extensão: o app (logado) cria um token e o entrega à extensão pelo externally_connectable.
  app.post("/api/v1/devices", auth, async (req) => {
    webOnly(req);
    const name = String(req.body?.name || "Extensão Escribanote").slice(0, 120);
    const s = await createSession(db, req.user.id, "device", name, null);
    await audit(db, req.user.id, "device_add", { name }, clientIp(req));
    return { id: s.id, token: s.token, name };
  });

  app.get("/api/v1/devices", auth, async (req) => {
    const rows = await db.many(
      "SELECT id, name, created_at, last_used_at FROM auth_sessions WHERE user_id = $1 AND kind = 'device' AND revoked_at IS NULL ORDER BY created_at DESC",
      [req.user.id],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at), current: r.id === req.session.id }));
  });

  app.delete("/api/v1/devices/:id", auth, async (req) => {
    const r = await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND kind = 'device' AND revoked_at IS NULL", [
      req.params.id,
      req.user.id,
    ]);
    if (!r.rowCount) fail(404, "not_found", "Dispositivo não encontrado.");
    await audit(db, req.user.id, "device_remove", { id: req.params.id }, clientIp(req));
    return { ok: true };
  });

  // Apaga a conta e tudo dela. A assinatura é cancelada na hora.
  app.delete("/api/v1/me", auth, async (req, reply) => {
    webOnly(req);
    if (String(req.body?.confirm || "").trim().toLowerCase() !== req.user.email) {
      fail(400, "confirm_required", "Digite o seu e-mail para confirmar.");
    }
    const sub = await db.one("SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id = $1", [req.user.id]);
    if (sub?.stripe_subscription_id && stripe && !["canceled", "incomplete_expired"].includes(sub.status)) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id).catch((err) => req.log.error({ err }, "cancelar assinatura"));
    }
    await db.query("DELETE FROM users WHERE id = $1", [req.user.id]);
    await audit(db, null, "account_deleted", { user: req.user.id }, clientIp(req));
    reply.clearCookie(COOKIE, { path: "/" });
    reply.code(202);
    return { ok: true };
  });
}
