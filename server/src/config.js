// Configuração vinda do ambiente. Em produção, os segredos ficam em /opt/reunilo/pro.env (fora do repositório).

const env = process.env;
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

export function loadConfig(overrides = {}) {
  const config = {
    port: num(env.PORT, 8080),
    publicUrl: (env.PUBLIC_URL || "https://reunilo.meneseslabs.com.br").replace(/\/$/, ""),
    databaseUrl: env.DATABASE_URL || "",
    dataKey: env.DATA_KEY || "", // base64 de 32 bytes (AES-256)
    extensionId: env.EXTENSION_ID || "ohbnmfogdcbgegnpcaphidkjinplednd",
    smtp: {
      host: env.SMTP_HOST || "",
      port: num(env.SMTP_PORT, 465),
      user: env.SMTP_USER || "",
      pass: env.SMTP_SENHA || env.SMTP_PASS || "",
    },
    mailFrom: env.MAIL_FROM || "",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    models: {
      strong: env.MODEL_STRONG || "claude-sonnet-5-5",
      fast: env.MODEL_FAST || "claude-haiku-5-5",
    },
    aiDailyBudgetUsd: num(env.AI_DAILY_BUDGET_USD, 20),
    credits: { perCycle: num(env.CREDITS_PER_CYCLE, 15), max: num(env.CREDITS_MAX, 30) },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      // Mensal só no cartão; anual no cartão ou Pix Automático (BRL) com 2 meses grátis.
      priceBrl: env.STRIPE_PRICE_BRL || "",
      priceBrlYear: env.STRIPE_PRICE_BRL_YEAR || "",
      priceUsd: env.STRIPE_PRICE_USD || "",
      priceUsdYear: env.STRIPE_PRICE_USD_YEAR || "",
      portalConfig: env.STRIPE_PORTAL_CONFIG || "",
      pixMandateMax: num(env.PIX_MANDATE_MAX_CENTS, 18000), // teto do débito anual automático (R$ 180; o plano custa R$ 150)
    },
    sessionDays: 30,
    loginTokenMinutes: 15,
    ...overrides,
  };
  config.origin = new URL(config.publicUrl).origin;
  config.extensionOrigin = `chrome-extension://${config.extensionId}`;
  return config;
}
