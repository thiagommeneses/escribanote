// Contas: login por link mágico, sessões do app (cookie), tokens da extensão, conta e exclusão (LGPD).
import { hashToken, newToken } from "./crypto.js";
import { clientIp, fail, iso } from "./http.js";
import { loginEmail } from "./mail.js";

const COOKIE = "rs";
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]+\.[a-z]{2,}$/i;
const ACTIVE = new Set(["active", "trialing", "past_due"]);

export const isPro = (sub) => !!sub && ACTIVE.has(sub.status);

export async function audit(db, userId, action, detail = {}, ip = "") {
  await db.query("INSERT INTO audit_log (user_id, action, detail, ip) VALUES ($1, $2, $3, $4)", [userId, action, detail, ip]);
}

export async function account(db, userId, config) {
  const u = await db.one("SELECT id, email, name, created_at FROM users WHERE id = $1", [userId]);
  if (!u) return null;
  const sub = await db.one("SELECT * FROM subscriptions WHERE user_id = $1", [userId]);
  const cr = await db.one("SELECT balance, renews_at FROM credit_balances WHERE user_id = $1", [userId]);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: iso(u.created_at),
    plan: isPro(sub) ? "pro" : "free",
    subscription: sub && sub.status !== "none"
      ? {
          status: sub.status,
          currency: sub.currency,
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
      if (req.headers["x-reunilo"] !== "1" || (origin && origin !== config.origin)) fail(403, "csrf", "Requisição recusada.");
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
    if (req.session.kind !== "web") fail(403, "web_only", "Faça isso pelo app do Reunilo no navegador.");
  };

  app.post("/api/v1/auth/email", async (req, reply) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) fail(400, "invalid_email", "Confira o e-mail digitado.");
    const ip = clientIp(req);
    if (!limiter.take(`login-ip:${ip}`, 10, 15 * 60_000) || !limiter.take(`login-email:${email}`, 4, 15 * 60_000)) {
      fail(429, "rate_limited", "Muitos pedidos de acesso. Espere alguns minutos e tente de novo.");
    }
    const token = newToken();
    await db.query(
      `INSERT INTO login_tokens (token_hash, email, expires_at, ip) VALUES ($1, $2, now() + interval '${config.loginTokenMinutes} minutes', $3)`,
      [hashToken(token), email, ip],
    );
    // O token vai no fragmento (#): não aparece em logs nem no Referer.
    const link = `${config.publicUrl}/app/#/entrar/${token}`;
    await mailer.send({ to: email, ...loginEmail(link, config.loginTokenMinutes) });
    reply.code(202);
    return { ok: true };
  });

  app.post("/api/v1/auth/verify", async (req, reply) => {
    const token = String(req.body?.token || "");
    if (!limiter.take(`verify-ip:${clientIp(req)}`, 20, 15 * 60_000)) fail(429, "rate_limited", "Muitas tentativas. Espere alguns minutos.");
    const row = await db.one(
      "UPDATE login_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email",
      [hashToken(token)],
    );
    if (!row) fail(400, "invalid_token", "Este link expirou ou já foi usado. Peça um novo.");
    const user = await db.one(
      "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id, (xmax = 0) AS created",
      [row.email],
    );
    const s = await createSession(db, user.id, "web", req.headers["user-agent"]?.slice(0, 200) || "Navegador", config.sessionDays);
    setCookie(reply, s.token);
    await audit(db, user.id, user.created ? "signup" : "login", {}, clientIp(req));
    return account(db, user.id, config);
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
    const name = String(req.body?.name || "Extensão Reunilo").slice(0, 120);
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
