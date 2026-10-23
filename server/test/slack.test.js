import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { login, makePro, sampleMeeting, setup } from "./helpers.js";
import { mdToMrkdwn, verifySlackSignature } from "../src/slack.js";

// Slack simulado: registra as chamadas e responde como a API real responderia.
function fakeSlack() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.replace("https://slack.com/api/", "");
    const body = init.headers["content-type"].startsWith("application/json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, body, auth: init.headers.authorization || null });
    const answers = {
      "oauth.v2.access": { ok: true, access_token: "xoxb-teste-123", bot_user_id: "UBOT", team: { id: "T1", name: "Meu Time" } },
      "conversations.list": { ok: true, channels: [{ id: "C2", name: "geral", is_private: false, is_member: true }, { id: "C1", name: "diretoria", is_private: true, is_member: true }] },
      "chat.postMessage": { ok: true, channel: body.channel, ts: body.thread_ts ? "1700000000.000200" : "1700000000.000100" },
      "chat.getPermalink": { ok: true, permalink: "https://meutime.slack.com/archives/C2/p1700000000000100" },
      "auth.revoke": { ok: true },
    };
    const data = fetchImpl.fail?.[method] ? { ok: false, error: fetchImpl.fail[method] } : answers[method] || { ok: false, error: "unknown_method" };
    return { status: 200, json: async () => data };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

let ctx, u, slack;
const SIGNING = "segredo-de-assinatura";
before(async () => {
  slack = fakeSlack();
  ctx = await setup({ slack: { clientId: "cid", clientSecret: "csec", signingSecret: SIGNING } });
  // o app foi montado pelo setup sem o fetch simulado: remonta com ele
  await ctx.app.close();
  const { buildApp } = await import("../src/app.js");
  ctx.app = await buildApp({ config: ctx.config, db: ctx.db, mailer: ctx.mailer, anthropic: ctx.anthropic, stripe: ctx.stripe, fetchImpl: slack });
  u = await login(ctx);
  await makePro(ctx, u.me.id, { credits: 3 });
  await u.put("/api/v1/meetings/mt-1", { doc: sampleMeeting("mt-1", { summary: { text: "## Decisões\n- Aprovada a mídia de **180 mil**\n- [ ] Enviar o relatório" } }) });
  await u.put("/api/v1/meetings/mt-2", { doc: sampleMeeting("mt-2") });
});
after(async () => ctx.close());

function signed(body, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = "v0=" + createHmac("sha256", SIGNING).update(`v0:${ts}:${raw}`).digest("hex");
  return ctx.app.inject({ method: "POST", url: "/api/v1/slack/events", payload: raw, headers: { "content-type": "application/json", "x-slack-request-timestamp": String(ts), "x-slack-signature": sig } });
}

test("markdown da ata vira mrkdwn do Slack", () => {
  assert.equal(mdToMrkdwn("## Decisões\n- Aprovada a mídia de **180 mil**\n- [x] Feito\n- [ ] Enviar [o relatório](https://x.y/r) & co"), "*Decisões*\n• Aprovada a mídia de *180 mil*\n☑ Feito\n☐ Enviar <https://x.y/r|o relatório> &amp; co");
  assert.equal(mdToMrkdwn("a <b> c"), "a &lt;b> c");
});

test("assinatura do Slack: válida, vencida e adulterada", () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = "v0=" + createHmac("sha256", SIGNING).update(`v0:${ts}:{"a":1}`).digest("hex");
  assert.equal(verifySlackSignature(SIGNING, ts, '{"a":1}', sig), true);
  assert.equal(verifySlackSignature(SIGNING, ts - 1000, '{"a":1}', sig), false);
  assert.equal(verifySlackSignature(SIGNING, ts, '{"a":2}', sig), false);
});

test("conectar: redireciona ao Slack com state; a volta guarda o token cifrado", async () => {
  assert.deepEqual((await u.get("/api/v1/slack")).json(), { configured: true, connected: false, team: null, channel: null, auto: false });
  const r = await u.get("/api/v1/slack/install");
  assert.equal(r.statusCode, 302);
  const to = new URL(r.headers.location);
  assert.equal(to.host, "slack.com");
  assert.equal(to.searchParams.get("client_id"), "cid");
  assert.match(to.searchParams.get("scope"), /chat:write/);
  const state = to.searchParams.get("state");
  const back = await ctx.app.inject(`/api/v1/slack/oauth?code=abc&state=${state}`);
  assert.equal(back.statusCode, 302);
  assert.match(back.headers.location, /#\/conta\?slack=ok$/);
  assert.equal(slack.calls.at(-1).method, "oauth.v2.access");
  assert.equal(slack.calls.at(-1).body.code, "abc");
  const st = (await u.get("/api/v1/slack")).json();
  assert.equal(st.connected, true);
  assert.equal(st.team.name, "Meu Time");
  const row = await ctx.db.one("SELECT token FROM slack_installations WHERE user_id = $1", [u.me.id]);
  assert.ok(!Buffer.from(row.token).toString().includes("xoxb-"), "o token fica cifrado no banco");
  // o mesmo state não vale duas vezes
  assert.match((await ctx.app.inject(`/api/v1/slack/oauth?code=abc&state=${state}`)).headers.location, /slack=expirado/);
});

test("canais, canal padrão e publicação da ata (com blocos e link)", async () => {
  const ch = (await u.get("/api/v1/slack/channels")).json().items;
  assert.deepEqual(ch.map((c) => c.name), ["diretoria", "geral"]);
  const st = (await u.put("/api/v1/slack/settings", { channelId: "C2", channelName: "geral", auto: true })).json();
  assert.deepEqual(st.channel, { id: "C2", name: "geral" });
  assert.equal(st.auto, true);

  const r = await u.post("/api/v1/meetings/mt-1/slack", {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().channelId, "C2");
  assert.match(r.json().permalink, /archives/);
  const post = slack.calls.find((c) => c.method === "chat.postMessage");
  assert.equal(post.auth, "Bearer xoxb-teste-123");
  assert.equal(post.body.blocks[0].text.text, "Planejamento do orçamento");
  assert.match(post.body.blocks[1].elements[0].text, /Google Meet .* com Ana, Bruno/);
  assert.match(post.body.blocks[2].text.text, /\*Decisões\*\n• Aprovada a mídia de \*180 mil\*/);
  assert.match(post.body.blocks.at(-1).elements[0].text, /#\/r\/mt-1\|Abrir no Escribanote/);

  // sem ata: 409; ifAuto repetido: já publicada; canal que o app não integra: mensagem útil
  assert.equal((await u.post("/api/v1/meetings/mt-2/slack", {})).statusCode, 409);
  assert.equal((await u.post("/api/v1/meetings/mt-1/slack", { ifAuto: true })).json().skipped, "already-posted");
  slack.fail = { "chat.postMessage": "not_in_channel" };
  const bad = await u.post("/api/v1/meetings/mt-1/slack", { channelId: "C1" });
  assert.equal(bad.statusCode, 502);
  assert.match(bad.json().message, /Adicione o app/);
  slack.fail = null;
});

test("pergunta no thread da ata é respondida pela IA e custa 1 crédito; eventos repetidos são ignorados", async () => {
  const before = (await u.get("/api/v1/me")).json().credits.balance;
  const chal = await signed({ type: "url_verification", challenge: "xyz" });
  assert.deepEqual(chal.json(), { challenge: "xyz" });
  ctx.anthropic.reviewText = "A mídia aprovada foi de *180 mil*.";
  const ev = { type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "message", channel: "C2", ts: "1700000000.000150", thread_ts: "1700000000.000100", user: "UPESSOA", text: "qual foi o valor aprovado?" } };
  assert.equal((await signed(ev)).statusCode, 200);
  await ctx.app.slackPending();
  const reply = slack.calls.filter((c) => c.method === "chat.postMessage").at(-1);
  assert.equal(reply.body.thread_ts, "1700000000.000100");
  assert.match(reply.body.text, /180 mil/);
  const call = ctx.anthropic.calls.at(-1);
  assert.equal(call.kind, "create");
  assert.match(call.params.system, /Escribanote/);
  assert.equal(call.params.messages.at(-1).content, "qual foi o valor aprovado?");
  assert.equal((await u.get("/api/v1/me")).json().credits.balance, before - 1);

  const n = slack.calls.length;
  assert.equal((await signed(ev)).json().duplicate, true);
  await ctx.app.slackPending();
  assert.equal(slack.calls.length, n, "evento repetido não gera outra resposta");
  // mensagem do próprio bot ou fora de thread: nada acontece
  await signed({ ...ev, event_id: "Ev2", event: { ...ev.event, bot_id: "B1" } });
  await signed({ ...ev, event_id: "Ev3", event: { ...ev.event, thread_ts: undefined } });
  await ctx.app.slackPending();
  assert.equal(slack.calls.length, n);
  // assinatura errada: 401
  const bad = await ctx.app.inject({ method: "POST", url: "/api/v1/slack/events", payload: "{}", headers: { "content-type": "application/json", "x-slack-request-timestamp": "1", "x-slack-signature": "v0=00" } });
  assert.equal(bad.statusCode, 401);
});

test("desconectar revoga o token e apaga a conexão", async () => {
  assert.equal((await u.del("/api/v1/slack")).statusCode, 200);
  assert.equal(slack.calls.at(-1).method, "auth.revoke");
  assert.equal((await u.get("/api/v1/slack")).json().connected, false);
  assert.equal((await u.post("/api/v1/meetings/mt-1/slack", {})).statusCode, 404);
});
