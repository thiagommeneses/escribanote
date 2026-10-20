// Monta a API. As dependências externas (banco, e-mail, Claude, Stripe) entram por parâmetro para os testes.
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { registerAi } from "./ai.js";
import { registerAuth } from "./auth.js";
import { registerBilling } from "./billing.js";
import { createSealer } from "./crypto.js";
import { HttpError } from "./http.js";
import { registerMeetings } from "./meetings.js";
import { createLimiter } from "./ratelimit.js";
import { registerShares } from "./shares.js";

export const VERSION = "1.0.0";

export async function buildApp({ config, db, mailer, anthropic = null, stripe = null, logger = false }) {
  const app = Fastify({
    logger: logger && {
      level: "info",
      redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const deps = { db, config, mailer, anthropic, stripe, limiter: createLimiter(), sealer: createSealer(config.dataKey) };

  await app.register(cookie);

  // CORS só para a extensão (ID fixo); o app web roda no mesmo endereço da API.
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.origin === config.extensionOrigin) {
      reply.header("access-control-allow-origin", config.extensionOrigin);
      reply.header("vary", "Origin");
      if (req.method === "OPTIONS") {
        reply.header("access-control-allow-methods", "GET, POST, PUT, DELETE");
        reply.header("access-control-allow-headers", "authorization, content-type");
        reply.header("access-control-max-age", "600");
        return reply.code(204).send();
      }
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    if (err.validation || err.statusCode === 400) {
      reply.code(400).send({ error: "bad_request", message: "Requisição inválida." });
      return;
    }
    if (err.statusCode === 413) {
      reply.code(413).send({ error: "too_large", message: "Conteúdo grande demais." });
      return;
    }
    req.log.error({ err }, "erro interno");
    reply.code(500).send({ error: "internal", message: "Algo deu errado do nosso lado. Tente de novo em instantes." });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found", message: "Não encontrado." }));

  app.get("/api/v1/health", async () => {
    await db.query("SELECT 1");
    return { ok: true, version: VERSION };
  });

  registerAuth(app, deps);
  registerMeetings(app, deps);
  registerAi(app, deps);
  registerBilling(app, deps);
  registerShares(app, deps);
  return app;
}
