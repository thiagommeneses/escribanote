// Ponto de entrada: aplica as migrações, sobe a API e roda a limpeza periódica.
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import { buildApp } from "./app.js";
import { groqTranscriber } from "./asr.js";
import { loadConfig } from "./config.js";
import { grantMonthly } from "./credits.js";
import { createDb, migrate } from "./db.js";
import { createMailer } from "./mail.js";
import { trialReminders } from "./reminders.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const applied = await migrate(db);

const mailer = createMailer(config, { info: (obj, msg) => console.log(JSON.stringify({ level: 30, msg, ...obj })) });
const app = await buildApp({
  config,
  db,
  mailer,
  anthropic: config.anthropicKey ? new Anthropic({ apiKey: config.anthropicKey }) : null,
  stripe: config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null,
  transcribe: config.groqKey ? groqTranscriber(config.groqKey) : null,
  logger: true,
});
if (applied.length) app.log.info({ applied }, "migrações aplicadas");

// Lixeira (30 dias), links de login vencidos e sessões expiradas.
async function purge() {
  try {
    const m = await db.query("DELETE FROM meetings WHERE deleted_at < now() - interval '30 days'");
    await db.query("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'");
    await db.query("DELETE FROM auth_sessions WHERE (expires_at < now() - interval '1 day') OR (revoked_at < now() - interval '30 days')");
    if (m.rowCount) app.log.info({ meetings: m.rowCount }, "lixeira esvaziada");
  } catch (err) {
    app.log.error({ err }, "limpeza");
  }
}
setInterval(purge, 3600_000).unref();
purge();

// Créditos mensais de quem paga o plano anual.
async function monthly() {
  try {
    const n = await grantMonthly(db, config.credits);
    if (n) app.log.info({ granted: n }, "créditos mensais do plano anual");
  } catch (err) {
    app.log.error({ err }, "créditos mensais");
  }
}
setInterval(monthly, 3600_000).unref();
monthly();

// Aviso por e-mail algumas horas antes do fim do teste grátis.
async function reminders() {
  try {
    const n = await trialReminders(db, mailer, config, { log: app.log });
    if (n) app.log.info({ sent: n }, "avisos de fim do teste");
  } catch (err) {
    app.log.error({ err }, "avisos de fim do teste");
  }
}
setInterval(reminders, 15 * 60_000).unref();
reminders();

const stop = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await app.listen({ host: "0.0.0.0", port: config.port });
