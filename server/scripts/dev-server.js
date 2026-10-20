// Servidor de desenvolvimento e de testes ponta a ponta: API + site + app no mesmo endereço,
// com Postgres local e IA, Stripe e e-mail simulados. Não é usado em produção.
//   TEST_DATABASE_URL=... node scripts/dev-server.js [porta]
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize as normPath } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { fakeAnthropic, fakeMailer, fakeStripe, setup } from "../test/helpers.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const SITE = join(root, "site");
const LIB = join(root, "extension/src/lib");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain" };

export async function startDevServer({ port = 8787 } = {}) {
  const publicUrl = `http://127.0.0.1:${port}`;
  const ctx = await setup({ publicUrl });
  await ctx.app.close();
  ctx.config.origin = publicUrl;
  const mailer = fakeMailer();
  const anthropic = fakeAnthropic();
  const stripe = fakeStripe();
  const app = await buildApp({ config: ctx.config, db: ctx.db, mailer, anthropic, stripe });

  // Arquivos estáticos (o Caddy faz isso em produção): /app/lib -> extension/src/lib; o resto -> site/.
  app.addHook("onRequest", async (req, reply) => {
    const path = decodeURIComponent(req.url.split("?")[0]);
    if (path.startsWith("/api/") || path.startsWith("/s/") || path.startsWith("/__test/")) return;
    let file = path.startsWith("/app/lib/") ? join(LIB, path.slice(9)) : join(SITE, path);
    file = normPath(file);
    if (!file.startsWith(SITE) && !file.startsWith(LIB)) return reply.code(403).send("proibido");
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) return reply.code(404).type("text/plain").send("não encontrado");
    return reply.type(MIME[extname(file)] || "application/octet-stream").send(createReadStream(file));
  });

  // Ganchos só de teste: último e-mail, tornar Pro, IA simulada.
  app.get("/__test/mail", async () => mailer.sent.at(-1) || null);
  app.post("/__test/pro", async (req) => {
    const u = await ctx.db.one("SELECT id FROM users WHERE email = $1", [String(req.body.email).toLowerCase()]);
    await ctx.db.query(
      `INSERT INTO subscriptions (user_id, status, currency, current_period_end) VALUES ($1, 'active', 'brl', now() + interval '30 days')
       ON CONFLICT (user_id) DO UPDATE SET status = 'active', currency = 'brl', current_period_end = now() + interval '30 days'`,
      [u.id],
    );
    await ctx.db.query(
      `INSERT INTO credit_balances (user_id, balance, renews_at) VALUES ($1, 15, now() + interval '30 days')
       ON CONFLICT (user_id) DO UPDATE SET balance = 15`,
      [u.id],
    );
    return { ok: true, id: u.id };
  });
  app.get("/__test/stripe", async () => stripe.calls);

  await app.listen({ host: "127.0.0.1", port });
  return { app, db: ctx.db, mailer, anthropic, stripe, url: publicUrl, close: async () => (await app.close(), await ctx.db.close()) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await startDevServer({ port: Number(process.argv[2]) || 8787 });
  console.log(`Reunilo (dev) em ${s.url}/app/`);
}
