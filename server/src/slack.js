// Integração com o Slack (Pro): conecta um workspace (OAuth), publica a ata no canal escolhido e
// responde perguntas sobre a reunião no thread da ata, com 1 crédito por resposta.
// O app do Slack é criado uma vez em api.slack.com (ver ../slack-app-manifest.json); o id, o segredo
// e o signing secret ficam em pro.env.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { refund, reserve } from "./credits.js";
import { newToken } from "./crypto.js";
import { fail } from "./http.js";
import { chatRequest, DEFAULT_TAGS, dateLabel, participantNames, PLATFORM } from "./lib.js";
import { loadDoc, requirePro } from "./meetings.js";

const SCOPES = ["chat:write", "chat:write.public", "channels:read", "groups:read", "channels:history", "groups:history", "app_mentions:read"];
const SECTION_MAX = 2900; // limite de um bloco de texto do Slack é 3000
const MAX_SECTIONS = 8;

// Markdown da ata → mrkdwn do Slack (negrito com *, listas com •, links <url|texto>).
export function mdToMrkdwn(md) {
  return String(md || "")
    .replace(/\r/g, "")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^\s*[-*]\s+\[x\]\s+/gim, "☑ ")
    .replace(/^\s*[-*]\s+\[ \]\s+/gm, "☐ ")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/&/g, "&amp;")
    .replace(/</g, (m, off, s) => (/^<(https?:\/\/[^|>]+\|[^>]*|https?:\/\/[^>]+)>/.test(s.slice(off)) ? "<" : "&lt;"))
    .trim();
}

// Quebra o texto em pedaços de até `max` caracteres, de preferência em quebras de linha.
function chunks(text, max = SECTION_MAX) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

// Blocos da mensagem da ata.
export function ataBlocks(doc, { url }) {
  const when = dateLabel(doc.startedAt);
  const who = participantNames(doc).slice(0, 8).join(", ");
  const meta = [PLATFORM[doc.platform] || doc.platform || "Reunião", when, who ? `com ${who}` : ""].filter(Boolean).join(" · ");
  const parts = chunks(mdToMrkdwn(doc.summary?.text || ""));
  const blocks = [
    { type: "header", text: { type: "plain_text", text: String(doc.title || "Reunião").slice(0, 150), emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: meta.slice(0, 2000) }] },
    ...parts.slice(0, MAX_SECTIONS).map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } })),
  ];
  if (parts.length > MAX_SECTIONS) blocks.push({ type: "section", text: { type: "mrkdwn", text: `_A ata continua no Escribanote._` } });
  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${url}|Abrir no Escribanote> · Responda neste thread para perguntar à IA sobre a reunião (1 crédito por resposta).` }],
  });
  return blocks;
}

export function verifySlackSignature(signingSecret, ts, body, signature, now = Date.now()) {
  if (!signingSecret || !ts || !signature) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const mac = "v0=" + createHmac("sha256", signingSecret).update(`v0:${ts}:${body}`).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(String(signature));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerSlack(app, { db, config, sealer, anthropic, fetchImpl = globalThis.fetch }) {
  const auth = { preHandler: app.authenticate };
  const slack = config.slack || {};
  const configured = () => !!(slack.clientId && slack.clientSecret && slack.signingSecret);
  const need = () => {
    if (!configured()) fail(503, "slack_unavailable", "A integração com o Slack não está configurada neste servidor.");
  };

  async function api(token, method, params = {}, { form = false } = {}) {
    const res = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : { "content-type": "application/json; charset=utf-8", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: form ? new URLSearchParams(params).toString() : JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "resposta inválida" }));
    if (!data.ok) throw Object.assign(new Error(`Slack ${method}: ${data.error || res.status}`), { slackError: data.error || String(res.status) });
    return data;
  }

  async function installOf(userId) {
    const r = await db.one("SELECT * FROM slack_installations WHERE user_id = $1", [userId]);
    return r ? { ...r, token: sealer.open(r.token).token } : null;
  }
  const status = (i) => ({
    configured: configured(),
    connected: !!i,
    team: i ? { id: i.team_id, name: i.team_name } : null,
    channel: i?.channel_id ? { id: i.channel_id, name: i.channel_name } : null,
    auto: !!i?.auto,
  });

  app.get("/api/v1/slack", auth, async (req) => status(await installOf(req.user.id)));

  // 1) Começa o OAuth: guarda um "state" ligado ao usuário e manda para o Slack autorizar.
  app.get("/api/v1/slack/install", auth, async (req, reply) => {
    need();
    await requirePro(db, req.user.id);
    const state = newToken(24);
    await db.query("INSERT INTO slack_oauth_states (state, user_id) VALUES ($1, $2)", [state, req.user.id]);
    const u = new URL("https://slack.com/oauth/v2/authorize");
    u.searchParams.set("client_id", slack.clientId);
    u.searchParams.set("scope", SCOPES.join(","));
    u.searchParams.set("redirect_uri", `${config.publicUrl}/api/v1/slack/oauth`);
    u.searchParams.set("state", state);
    return reply.redirect(u.toString(), 302);
  });

  // 2) Volta do Slack: troca o código pelo token do bot e guarda cifrado.
  app.get("/api/v1/slack/oauth", async (req, reply) => {
    need();
    const back = (q) => reply.redirect(`${config.publicUrl}/app/#/conta?slack=${q}`, 302);
    const { code, state, error } = req.query || {};
    if (error || !code || !state) return back("cancelado");
    const st = await db.one("DELETE FROM slack_oauth_states WHERE state = $1 AND created_at > now() - interval '15 minutes' RETURNING user_id", [String(state)]);
    if (!st) return back("expirado");
    let data;
    try {
      data = await api(null, "oauth.v2.access", { client_id: slack.clientId, client_secret: slack.clientSecret, code: String(code), redirect_uri: `${config.publicUrl}/api/v1/slack/oauth` }, { form: true });
    } catch (err) {
      req.log.warn({ err: err.message }, "oauth do Slack");
      return back("erro");
    }
    const sealed = sealer.seal({ token: data.access_token });
    await db.query(
      `INSERT INTO slack_installations (user_id, team_id, team_name, bot_user_id, token, key_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET team_id = $2, team_name = $3, bot_user_id = $4, token = $5, key_version = $6, updated_at = now()`,
      [st.user_id, data.team?.id || "", data.team?.name || "", data.bot_user_id || "", sealed.data, sealer.keyVersion],
    );
    return back("ok");
  });

  app.delete("/api/v1/slack", auth, async (req) => {
    const i = await installOf(req.user.id);
    if (i) {
      await api(i.token, "auth.revoke").catch(() => {});
      await db.query("DELETE FROM slack_installations WHERE user_id = $1", [req.user.id]);
    }
    return { ok: true };
  });

  app.get("/api/v1/slack/channels", auth, async (req) => {
    const i = await installOf(req.user.id);
    if (!i) fail(404, "slack_not_connected", "Conecte o Slack primeiro.");
    const items = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const r = await api(i.token, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
      for (const c of r.channels || []) items.push({ id: c.id, name: c.name, private: !!c.is_private, member: !!c.is_member });
      cursor = r.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items };
  });

  app.put("/api/v1/slack/settings", auth, async (req) => {
    const i = await installOf(req.user.id);
    if (!i) fail(404, "slack_not_connected", "Conecte o Slack primeiro.");
    const b = req.body || {};
    const channelId = b.channelId === undefined ? i.channel_id : String(b.channelId || "").slice(0, 40) || null;
    const channelName = b.channelName === undefined ? i.channel_name : String(b.channelName || "").slice(0, 100) || null;
    const auto = b.auto === undefined ? i.auto : !!b.auto;
    if (auto && !channelId) fail(400, "bad_request", "Escolha um canal para publicar as atas.");
    await db.query("UPDATE slack_installations SET channel_id = $2, channel_name = $3, auto = $4, updated_at = now() WHERE user_id = $1", [req.user.id, channelId, channelName, auto]);
    return status(await installOf(req.user.id));
  });

  // Publica a ata da reunião no canal (o escolhido, ou o padrão). ifAuto: só se "auto" estiver ligado.
  app.post("/api/v1/meetings/:id/slack", auth, async (req) => {
    await requirePro(db, req.user.id);
    const i = await installOf(req.user.id);
    if (!i) fail(404, "slack_not_connected", "Conecte o Slack em Conta para publicar atas.");
    const b = req.body || {};
    if (b.ifAuto && !i.auto) return { ok: true, skipped: "auto-off" };
    const channel = String(b.channelId || i.channel_id || "");
    if (!channel) fail(400, "bad_request", "Escolha um canal para publicar.");
    const { doc } = await loadDoc(db, sealer, req.user.id, String(req.params.id));
    if (!doc.summary?.text) fail(409, "no_summary", "Gere a ata antes de publicar no Slack.");
    const url = `${config.publicUrl}/app/#/r/${encodeURIComponent(doc.id)}`;
    const dup = b.ifAuto ? await db.one("SELECT ts FROM slack_posts WHERE user_id = $1 AND meeting_id = $2 AND channel_id = $3", [req.user.id, doc.id, channel]) : null;
    if (dup) return { ok: true, skipped: "already-posted", ts: dup.ts };
    let r;
    try {
      r = await api(i.token, "chat.postMessage", { channel, text: `Ata: ${doc.title}`, blocks: ataBlocks(doc, { url }), unfurl_links: false, unfurl_media: false });
    } catch (err) {
      const why = { not_in_channel: "Adicione o app Escribanote ao canal (ou escolha um canal público).", channel_not_found: "Canal não encontrado no Slack.", token_revoked: "A conexão com o Slack foi revogada. Conecte de novo em Conta.", invalid_auth: "A conexão com o Slack expirou. Conecte de novo em Conta." }[err.slackError];
      fail(502, "slack_failed", why || `O Slack recusou a publicação (${err.slackError}).`);
    }
    await db.query("INSERT INTO slack_posts (team_id, channel_id, ts, user_id, meeting_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [i.team_id, r.channel, r.ts, req.user.id, doc.id]);
    const link = await api(i.token, "chat.getPermalink", { channel: r.channel, message_ts: r.ts }).catch(() => null);
    return { ok: true, channelId: r.channel, ts: r.ts, permalink: link?.permalink || null };
  });

  // Perguntas no thread da ata: a resposta vem da IA com a reunião como contexto (1 crédito).
  async function answerInThread(ev, teamId, log) {
    const post = await db.one("SELECT user_id, meeting_id, channel_id FROM slack_posts WHERE team_id = $1 AND channel_id = $2 AND ts = $3", [teamId, ev.channel, ev.thread_ts]);
    if (!post) return;
    const i = await installOf(post.user_id);
    if (!i || ev.user === i.bot_user_id) return;
    const question = String(ev.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!question) return;
    const reply = (text) => api(i.token, "chat.postMessage", { channel: ev.channel, thread_ts: ev.thread_ts, text }).catch((err) => log.warn({ err: err.message }, "responder no Slack"));
    if (!anthropic) return reply("A IA do Escribanote está indisponível agora.");
    try {
      await requirePro(db, post.user_id);
    } catch {
      return reply("Para perguntar à IA pelo Slack, a conta precisa do Escribanote Pro ativo.");
    }
    let doc;
    try {
      doc = (await loadDoc(db, sealer, post.user_id, post.meeting_id)).doc;
    } catch {
      return reply("Esta reunião não está mais na conta.");
    }
    const id = randomUUID();
    const model = config.models.fast;
    try {
      await reserve(db, post.user_id, 1, id);
    } catch (err) {
      return reply(err.message || "Os créditos de IA acabaram.");
    }
    await db.query("INSERT INTO ai_requests (id, user_id, meeting_id, kind, model, credits) VALUES ($1, $2, $3, 'slack_ask', $4, 1)", [id, post.user_id, doc.id, model]);
    try {
      const r = chatRequest(doc, [{ role: "user", text: question.slice(0, 4000) }], { tags: DEFAULT_TAGS, glossary: "" });
      const msg = await anthropic.messages.create({ model, max_tokens: 1500, system: r.system, messages: r.messages, output_config: { effort: "low" } });
      const text = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
      if (!text) throw new Error("resposta vazia");
      await db.query("UPDATE ai_requests SET status = 'done', finished_at = now(), input_tokens = $2, output_tokens = $3 WHERE id = $1", [id, msg.usage?.input_tokens || 0, msg.usage?.output_tokens || 0]);
      await reply(mdToMrkdwn(text));
    } catch (err) {
      log.error({ err: err.message }, "IA no Slack");
      await db.query("UPDATE ai_requests SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [id, String(err.message).slice(0, 500)]);
      await refund(db, post.user_id, 1, id).catch(() => {});
      await reply("Não consegui responder agora. Tente de novo em instantes; o crédito foi devolvido.");
    }
  }

  // Eventos do Slack (Events API). Precisa do corpo original para conferir a assinatura.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => done(null, body));
    scope.post("/api/v1/slack/events", { bodyLimit: 512 * 1024 }, async (req, reply) => {
      need();
      const raw = typeof req.body === "string" ? req.body : "";
      if (!verifySlackSignature(slack.signingSecret, req.headers["x-slack-request-timestamp"], raw, req.headers["x-slack-signature"])) {
        fail(401, "bad_signature", "Assinatura inválida.");
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        fail(400, "bad_request", "JSON inválido.");
      }
      if (body.type === "url_verification") return { challenge: body.challenge };
      if (body.type !== "event_callback" || !body.event) return { ok: true };
      const fresh = await db.one("INSERT INTO slack_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING RETURNING event_id", [String(body.event_id || randomUUID())]);
      if (!fresh) return { ok: true, duplicate: true };
      const ev = body.event;
      const isReply = (ev.type === "message" || ev.type === "app_mention") && ev.thread_ts && ev.thread_ts !== ev.ts && !ev.bot_id && !ev.subtype;
      if (isReply) {
        // responde depois de devolver 200 (o Slack reenvia se demorar mais de 3 s)
        const run = answerInThread(ev, String(body.team_id || ""), req.log).catch((err) => req.log.error({ err }, "evento do Slack"));
        pendingAnswers.add(run);
        run.finally(() => pendingAnswers.delete(run));
      }
      reply.header("x-slack-no-retry", "1");
      return { ok: true };
    });
  });
  const pendingAnswers = new Set();
  app.decorate("slackPending", () => Promise.all([...pendingAnswers]));
}
