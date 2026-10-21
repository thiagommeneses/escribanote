import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, makePro, sampleMeeting, setup } from "./helpers.js";

let ctx, u;
before(async () => {
  ctx = await setup();
  u = await login(ctx);
  await makePro(ctx, u.me.id);
  const doc = sampleMeeting("mt-1", { title: 'Reunião <script>alert("x")</script>', summary: { text: "## Resumo\n- Aprovada a mídia de **180 mil**" } });
  await u.put("/api/v1/meetings/mt-1", { doc });
});
after(async () => ctx.close());

const tokenOf = (url) => url.split("/s/")[1];

test("link público mostra ata, destaques e transcrição, com o título escapado", async () => {
  const s = (await u.post("/api/v1/shares", { meetingId: "mt-1", days: 7 })).json();
  assert.match(s.url, /^https:\/\/escribanote\.test\/s\/[\w-]{20,}$/);
  const page = await ctx.app.inject(`/s/${tokenOf(s.url)}`);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["x-robots-tag"], /noindex/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.ok(page.body.includes("&lt;script&gt;"));
  assert.ok(!page.body.includes('<script>alert'));
  assert.match(page.body, /<b>180 mil<\/b>/);
  assert.match(page.body, /Eu aprovo a proposta de mídia/);
  assert.match(page.body, /Decisão/);
  const list = (await u.get("/api/v1/shares?meetingId=mt-1")).json();
  assert.equal(list.items[0].views, 1);
});

test("sem transcrição, revogado, vencido ou reunião apagada: 404", async () => {
  const noTx = (await u.post("/api/v1/shares", { meetingId: "mt-1", includeTranscript: false })).json();
  const p = await ctx.app.inject(`/s/${tokenOf(noTx.url)}`);
  assert.ok(!p.body.includes("<h2>Transcrição</h2>"), "sem a seção de transcrição");
  assert.ok(p.body.includes("<h2>Destaques</h2>"), "os destaques continuam");

  assert.equal((await u.del(`/api/v1/shares/${noTx.id}`)).statusCode, 200);
  assert.equal((await ctx.app.inject(`/s/${tokenOf(noTx.url)}`)).statusCode, 404);

  const old = (await u.post("/api/v1/shares", { meetingId: "mt-1" })).json();
  await ctx.db.query("UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1", [old.id]);
  assert.equal((await ctx.app.inject(`/s/${tokenOf(old.url)}`)).statusCode, 404);

  const live = (await u.post("/api/v1/shares", { meetingId: "mt-1" })).json();
  await u.del("/api/v1/meetings/mt-1");
  assert.equal((await ctx.app.inject(`/s/${tokenOf(live.url)}`)).statusCode, 404);
  assert.equal((await ctx.app.inject("/s/token-inventado")).statusCode, 404);
});

test("só compartilha reunião própria", async () => {
  const other = await login(ctx);
  await makePro(ctx, other.me.id);
  const r = await other.post("/api/v1/shares", { meetingId: "mt-1" });
  assert.equal(r.statusCode, 404);
});
