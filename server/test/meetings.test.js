import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { login, makePro, sampleMeeting, setup } from "./helpers.js";

let ctx, ana, bia;
before(async () => {
  ctx = await setup();
  ana = await login(ctx, "ana@exemplo.com");
  bia = await login(ctx, "bia@exemplo.com");
  await makePro(ctx, ana.me.id);
  await makePro(ctx, bia.me.id);
});
after(async () => ctx.close());

test("sincronizar exige o Pro", async () => {
  const free = await login(ctx);
  const r = await free.put("/api/v1/meetings/mt-free", { doc: sampleMeeting("mt-free") });
  assert.equal(r.statusCode, 402);
  assert.equal(r.json().error, "pro_required");
});

test("criar, ler, conflito de versão e atualização", async () => {
  const doc = sampleMeeting("mt-1");
  const c = await ana.put("/api/v1/meetings/mt-1", { doc, baseVersion: null });
  assert.equal(c.statusCode, 200);
  assert.equal(c.json().version, 1);

  const g = (await ana.get("/api/v1/meetings/mt-1")).json();
  assert.equal(g.version, 1);
  assert.equal(g.doc.title, doc.title);
  assert.deepEqual(g.doc.shots, [], "capturas de tela não sobem");

  const stale = await ana.put("/api/v1/meetings/mt-1", { doc: { ...doc, title: "A" }, baseVersion: 0 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().version, 1);

  const ok = await ana.put("/api/v1/meetings/mt-1", { doc: { ...doc, title: "Orçamento Q4" }, baseVersion: 1 });
  assert.equal(ok.json().version, 2);
  assert.equal((await ana.get("/api/v1/meetings/mt-1")).json().doc.title, "Orçamento Q4");
});

test("o id do caminho precisa bater com o documento", async () => {
  const r = await ana.put("/api/v1/meetings/outro", { doc: sampleMeeting("mt-x") });
  assert.equal(r.statusCode, 400);
});

test("o documento fica criptografado no banco", async () => {
  const row = await ctx.db.one("SELECT doc FROM meetings WHERE id = 'mt-1'");
  assert.ok(!row.doc.toString("latin1").includes("orçamento"));
  assert.ok(!row.doc.toString("latin1").includes("Bruno"));
});

test("lista com metadados e sincronização por changedSince", async () => {
  const since = new Date().toISOString();
  await ana.put("/api/v1/meetings/mt-2", { doc: sampleMeeting("mt-2", { startedAt: Date.UTC(2026, 9, 18), title: "Segunda reunião" }) });
  const list = (await ana.get("/api/v1/meetings")).json();
  assert.deepEqual(list.items.map((i) => i.id), ["mt-2", "mt-1"]);
  assert.deepEqual(list.items[1].participants, ["Ana", "Bruno"]);
  assert.equal(list.items[1].highlights, 1);
  const changed = (await ana.get(`/api/v1/meetings?changedSince=${encodeURIComponent(since)}`)).json();
  assert.deepEqual(changed.items.map((i) => i.id), ["mt-2"]);
});

test("busca sem acento encontra a fala e devolve o trecho", async () => {
  const r = (await ana.get("/api/v1/search?q=orcamento")).json();
  assert.ok(r.items.some((i) => i.id === "mt-1"));
  const hit = r.items.find((i) => i.id === "mt-1");
  assert.match(hit.snippet, /orçamento/);
  assert.equal(hit.speaker, "Ana");
  const none = (await ana.get("/api/v1/search?q=inexistentexyz")).json();
  assert.equal(none.items.length, 0);
});

test("uma pessoa não vê as reuniões da outra", async () => {
  assert.equal((await bia.get("/api/v1/meetings/mt-1")).statusCode, 404);
  assert.equal((await bia.get("/api/v1/meetings")).json().items.length, 0);
  assert.equal((await bia.get("/api/v1/search?q=orcamento")).json().items.length, 0);
  assert.equal((await bia.del("/api/v1/meetings/mt-1")).statusCode, 404);
  // o mesmo id em contas diferentes não colide
  assert.equal((await bia.put("/api/v1/meetings/mt-1", { doc: sampleMeeting("mt-1", { title: "Da Bia" }) })).statusCode, 200);
  assert.equal((await ana.get("/api/v1/meetings/mt-1")).json().doc.title, "Orçamento Q4");
});

test("lixeira: apagar, aparecer na sincronização, recusar escrita e restaurar", async () => {
  const since = new Date(Date.now() - 1000).toISOString();
  assert.equal((await ana.del("/api/v1/meetings/mt-2")).statusCode, 200);
  assert.equal((await ana.get("/api/v1/meetings/mt-2")).statusCode, 404);
  const changed = (await ana.get(`/api/v1/meetings?changedSince=${encodeURIComponent(since)}`)).json();
  assert.ok(changed.items.find((i) => i.id === "mt-2").deleted);
  const w = await ana.put("/api/v1/meetings/mt-2", { doc: sampleMeeting("mt-2"), baseVersion: 2 });
  assert.equal(w.statusCode, 410);
  assert.equal((await ana.get("/api/v1/meetings/trash")).json().items.length, 1);
  assert.equal((await ana.post("/api/v1/meetings/mt-2/restore")).statusCode, 200);
  assert.equal((await ana.get("/api/v1/meetings/mt-2")).statusCode, 200);
});

test("exportar tudo no formato do backup", async () => {
  const r = await ana.get("/api/v1/export");
  assert.equal(r.statusCode, 200);
  assert.match(r.headers["content-disposition"], /reunilo-backup-/);
  const data = r.json();
  assert.equal(data.app, "reunilo");
  assert.equal(data.sessions.length, 2);
});
