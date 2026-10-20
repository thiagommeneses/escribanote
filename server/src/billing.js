// Assinatura pela Stripe: Checkout (BRL com cartão e Pix Automático; USD com cartão), Portal e webhooks.
import { audit } from "./auth.js";
import { grantCycle } from "./credits.js";
import { clientIp, fail } from "./http.js";

const toDate = (sec) => (sec ? new Date(sec * 1000) : null);

// Campos que mudaram de lugar entre versões da API da Stripe.
const periodEnd = (sub) => sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? null;
const invoiceSubscription = (inv) => inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
const idOf = (v) => (typeof v === "string" ? v : v?.id ?? null);

export function registerBilling(app, { db, config, stripe }) {
  const auth = { preHandler: app.authenticate };
  const need = () => {
    if (!stripe) fail(503, "billing_unavailable", "A assinatura ainda não está disponível. Tente mais tarde.");
  };

  async function customerFor(user) {
    const row = await db.one("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [user.id]);
    if (row?.stripe_customer_id) return row.stripe_customer_id;
    const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } });
    await db.query(
      `INSERT INTO subscriptions (user_id, stripe_customer_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, updated_at = now()`,
      [user.id, c.id],
    );
    return c.id;
  }

  app.post("/api/v1/billing/checkout", auth, async (req) => {
    need();
    if (req.session.kind !== "web") fail(403, "web_only", "Assine pelo app do Reunilo no navegador.");
    const currency = req.body?.currency === "usd" ? "usd" : "brl";
    const price = currency === "usd" ? config.stripe.priceUsd : config.stripe.priceBrl;
    if (!price) fail(503, "billing_unavailable", "Este plano ainda não está disponível nesta moeda.");
    const current = await db.one("SELECT status FROM subscriptions WHERE user_id = $1", [req.user.id]);
    if (["active", "trialing", "past_due"].includes(current?.status)) fail(409, "already_pro", "Você já assina o Reunilo Pro.");
    const customer = await customerFor(req.user);
    const params = {
      mode: "subscription",
      customer,
      client_reference_id: req.user.id,
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: req.user.id } },
      success_url: `${config.publicUrl}/app/#/conta?assinatura=ok`,
      cancel_url: `${config.publicUrl}/app/#/conta`,
      allow_promotion_codes: true,
      locale: currency === "brl" ? "pt-BR" : "auto",
    };
    if (currency === "brl") {
      params.payment_method_types = ["card", "pix"];
      // Pix Automático: o cliente autoriza no app do banco um débito mensal de até R$ 20 (o plano custa R$ 15).
      params.payment_method_options = {
        pix: { mandate_options: { amount: config.stripe.pixMandateMax, amount_type: "maximum", payment_schedule: "monthly", reference: "Reunilo Pro" } },
      };
    } else {
      params.payment_method_types = ["card"];
    }
    const session = await stripe.checkout.sessions.create(params);
    await audit(db, req.user.id, "checkout", { currency }, clientIp(req));
    return { url: session.url };
  });

  app.post("/api/v1/billing/portal", auth, async (req) => {
    need();
    const row = await db.one("SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1", [req.user.id]);
    if (!row?.stripe_customer_id) fail(404, "no_customer", "Você ainda não tem uma assinatura.");
    const s = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${config.publicUrl}/app/#/conta` });
    return { url: s.url };
  });

  async function userForCustomer(customerId, metadataUser) {
    const row = customerId ? await db.one("SELECT user_id FROM subscriptions WHERE stripe_customer_id = $1", [customerId]) : null;
    if (row) return row.user_id;
    if (metadataUser && (await db.one("SELECT 1 FROM users WHERE id = $1", [metadataUser]))) return metadataUser;
    return null;
  }

  async function saveSubscription(sub) {
    const userId = await userForCustomer(idOf(sub.customer), sub.metadata?.user_id);
    if (!userId) return null;
    const item = sub.items?.data?.[0];
    await db.query(
      `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, currency, price_id, current_period_end, cancel_at_period_end, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status, currency = EXCLUDED.currency, price_id = EXCLUDED.price_id, current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end, updated_at = now()`,
      [userId, idOf(sub.customer), sub.id, sub.status, sub.currency, item?.price?.id ?? null, toDate(periodEnd(sub)), !!sub.cancel_at_period_end],
    );
    return userId;
  }

  async function handle(event) {
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": {
        if (o.mode !== "subscription" || !o.subscription) return;
        if (o.client_reference_id && o.customer) {
          await db.query(
            `INSERT INTO subscriptions (user_id, stripe_customer_id) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
            [o.client_reference_id, idOf(o.customer)],
          );
        }
        await saveSubscription(await stripe.subscriptions.retrieve(idOf(o.subscription)));
        return;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await saveSubscription(o);
        return;
      case "invoice.paid": {
        // Cada fatura paga de criação ou renovação concede os créditos do ciclo (uma vez por fatura).
        if (!["subscription_create", "subscription_cycle"].includes(o.billing_reason)) return;
        const userId = await userForCustomer(idOf(o.customer));
        if (!userId) return;
        const line = o.lines?.data?.[0];
        const renews = toDate(line?.period?.end) || (await db.one("SELECT current_period_end FROM subscriptions WHERE user_id = $1", [userId]))?.current_period_end;
        await grantCycle(db, userId, `invoice:${o.id}`, renews, config.credits);
        const subId = idOf(invoiceSubscription(o));
        if (subId) await saveSubscription(await stripe.subscriptions.retrieve(subId));
        return;
      }
      case "mandate.updated": {
        // Pix Automático revogado no app do banco: a próxima cobrança vai falhar; registra para avisar o usuário.
        if (o.status === "inactive") {
          const userId = await userForCustomer(idOf(o.customer) || null);
          await db.query("INSERT INTO audit_log (user_id, action, detail) VALUES ($1, 'pix_mandate_revoked', $2)", [userId, { mandate: o.id }]);
        }
        return;
      }
      default:
    }
  }

  // O webhook precisa do corpo original para conferir a assinatura da Stripe.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => done(null, body));
    scope.post("/api/v1/billing/webhook", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      need();
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], config.stripe.webhookSecret);
      } catch (err) {
        req.log.warn({ err: err.message }, "webhook com assinatura inválida");
        fail(400, "bad_signature", "Assinatura inválida.");
      }
      const fresh = await db.one("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [event.id, event.type]);
      if (!fresh) return { ok: true, duplicate: true };
      try {
        await handle(event);
      } catch (err) {
        // Apaga a marca para a Stripe reenviar o evento mais tarde.
        await db.query("DELETE FROM stripe_events WHERE id = $1", [event.id]);
        throw err;
      }
      return { ok: true };
    });
  });
}
