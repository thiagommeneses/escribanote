// Prepara a conta Stripe para o Reunilo Pro: produto, preços (BRL e USD, mensal e anual), webhook e portal do cliente.
// Pode rodar mais de uma vez: reaproveita o que já existe (preços pelo lookup_key, webhook pela URL).
// Imprime as linhas para o pro.env (ou grava direto com --write caminho/pro.env).
//   STRIPE_SECRET_KEY=sk_... PUBLIC_URL=https://reunilo.meneseslabs.com.br node scripts/stripe-setup.js [--write /caminho/pro.env]
import { readFileSync, writeFileSync } from "node:fs";
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
const publicUrl = (process.env.PUBLIC_URL || "https://reunilo.meneseslabs.com.br").replace(/\/$/, "");
if (!key) throw new Error("Defina STRIPE_SECRET_KEY (no pro.env)");
const stripe = new Stripe(key);
const mode = key.startsWith("sk_live") ? "produção" : "teste";
const EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed", "mandate.updated"];

async function price(lookup, currency, amount, product, interval = "month") {
  const found = await stripe.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  if (found.data[0]) return found.data[0];
  return stripe.prices.create({
    product,
    currency,
    unit_amount: amount,
    recurring: { interval },
    lookup_key: lookup,
    nickname: `Reunilo Pro ${interval === "year" ? "anual" : "mensal"} (${currency.toUpperCase()})`,
    tax_behavior: "inclusive",
  });
}

const products = await stripe.products.search({ query: "metadata['app']:'reunilo-pro'" }).catch(() => ({ data: [] }));
const product =
  products.data[0] ||
  (await stripe.products.create({
    name: "Reunilo Pro",
    description: "Reuniões na conta, área web, links de compartilhamento e 15 créditos de IA por mês.",
    metadata: { app: "reunilo-pro" },
  }));
const brl = await price("reunilo_pro_brl_monthly", "brl", 1500, product.id);
const usd = await price("reunilo_pro_usd_monthly", "usd", 300, product.id);
// Anual: 12 meses pelo preço de 10 (R$ 150 e US$ 30).
const brlYear = await price("reunilo_pro_brl_yearly", "brl", 15000, product.id, "year");
const usdYear = await price("reunilo_pro_usd_yearly", "usd", 3000, product.id, "year");

const url = `${publicUrl}/api/v1/billing/webhook`;
const hooks = await stripe.webhookEndpoints.list({ limit: 100 });
let secret = null;
let hook = hooks.data.find((h) => h.url === url);
if (!hook) {
  hook = await stripe.webhookEndpoints.create({ url, enabled_events: EVENTS, description: "Reunilo Pro" });
  secret = hook.secret; // só aparece na criação
} else {
  await stripe.webhookEndpoints.update(hook.id, { enabled_events: EVENTS, disabled: false });
}

const portals = await stripe.billingPortal.configurations.list({ limit: 20 });
let portal = portals.data.find((p) => p.metadata?.app === "reunilo-pro");
if (!portal) {
  portal = await stripe.billingPortal.configurations.create({
    business_profile: { headline: "Reunilo Pro", privacy_policy_url: `${publicUrl}/privacidade.html` },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "tax_id"] },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
    },
    metadata: { app: "reunilo-pro" },
  });
}

const lines = {
  STRIPE_PRICE_BRL: brl.id,
  STRIPE_PRICE_BRL_YEAR: brlYear.id,
  STRIPE_PRICE_USD: usd.id,
  STRIPE_PRICE_USD_YEAR: usdYear.id,
  STRIPE_PORTAL_CONFIG: portal.id,
};
if (secret) lines.STRIPE_WEBHOOK_SECRET = secret;
console.log(`Stripe (${mode}): produto ${product.id}, preços ${brl.id}, ${brlYear.id}, ${usd.id} e ${usdYear.id}, webhook ${hook.id}, portal ${portal.id}`);
if (!secret) console.log("O webhook já existia: o segredo dele continua o mesmo do pro.env.");

const target = process.argv.indexOf("--write") > 0 ? process.argv[process.argv.indexOf("--write") + 1] : null;
if (target) {
  let env = readFileSync(target, "utf8");
  for (const [k, v] of Object.entries(lines)) {
    env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(target, env, { mode: 0o600 });
  console.log(`Gravado em ${target}: ${Object.keys(lines).join(", ")}`);
} else {
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${k.includes("SECRET") ? v : v}`);
}
