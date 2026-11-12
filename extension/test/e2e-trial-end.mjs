// Fim do teste grátis do Pro na extensão: com o prazo vencido a sincronização para sozinha (sem esperar a conta
// recusar), e se a conta recusar com 402 isso não vira erro: as reuniões ficam na fila para quando o Pro voltar.
//   CHROME=... node test/e2e-trial-end.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "escribanote-trial-end-"));
const puts = [];
let refuse = false;
const api = createServer((req, res) => {
  const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE", "content-type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  req.resume();
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const reply = (code, obj) => { res.writeHead(code, cors); res.end(JSON.stringify(obj)); };
    if (url.pathname === "/api/v1/meetings" && req.method === "GET") return reply(200, { items: [] });
    if (url.pathname.startsWith("/api/v1/meetings/") && req.method === "PUT") {
      puts.push(decodeURIComponent(url.pathname.split("/").pop()));
      return refuse ? reply(402, { error: "pro_required", message: "Este recurso faz parte do Escribanote Pro." }) : reply(200, { version: 1 });
    }
    reply(404, { error: "not_found", message: "não" });
  });
}).listen(0);
const API = `http://127.0.0.1:${api.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" });
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail))); } catch { ws = null; await sleep(200); }
}
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result); } };
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
try {
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1000);
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
  const msg = (m) => ev(`chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const meeting = (id) => ({ id, title: "Reunião " + id, platform: "meet", startedAt: Date.now() - 60_000, endedAt: Date.now(), entries: [{ id: "e1", speaker: "Ana", text: "Bom dia a todos.", start: Date.now() - 50_000, end: Date.now() - 48_000 }], asr: [] });
  const setAcct = (trialEndsAt) => ev(`chrome.storage.local.set({ accountApi: ${JSON.stringify(API)}, account: { token: "tok-teste-com-mais-de-20-letras", plan: "pro", balance: 5, email: "a@b.c", trialEndsAt: ${JSON.stringify(trialEndsAt)}, checkedAt: Date.now() } })`);
  const syncMeta = () => ev(`chrome.storage.local.get("sync").then((r) => r.sync)`);
  const settle = async (n) => { for (let i = 0; i < 40 && puts.length < n; i++) await sleep(250); await sleep(800); };

  // 1. No teste: sincroniza.
  await setAcct(new Date(Date.now() + 3600_000).toISOString());
  assert.equal(await msg({ type: "import", sessions: [meeting("m-a")] }), 1);
  await msg({ type: "sync-consent", mode: "all" });
  await settle(1);
  assert.deepEqual(puts, ["m-a"], "no teste, a reunião vai para a conta");
  assert.equal((await syncMeta()).versions["m-a"], 1);

  // 2. Prazo vencido no computador: não tenta enviar, sem erro, e a reunião fica na fila.
  await setAcct(new Date(Date.now() - 60_000).toISOString());
  await msg({ type: "import", sessions: [meeting("m-b")] });
  await msg({ type: "sync-now" });
  await settle(2);
  assert.deepEqual(puts, ["m-a"], "teste vencido: nada é enviado");
  let meta = await syncMeta();
  assert.equal(meta.error, null, "sem erro de sincronização");
  assert.ok(meta.pending.includes("m-b"), "m-b espera o Pro voltar");
  const lib = await ev(`chrome.runtime.sendMessage({ type: "account-state" })`);
  assert.equal(lib.account?.plan === "pro" && !lib.account?.trialEndsAt, false);

  // 3. Prazo ainda válido aqui, mas a conta já recusa (402): vira grátis sem mostrar erro.
  await setAcct(new Date(Date.now() + 3600_000).toISOString());
  refuse = true;
  await msg({ type: "sync-now" });
  await settle(3);
  assert.ok(puts.includes("m-b"), "tentou enviar m-b");
  meta = await syncMeta();
  assert.equal(meta.error, null, "402 não é erro");
  assert.ok(meta.pending.includes("m-b"), "m-b continua na fila");
  const acct = await ev(`chrome.storage.local.get("account").then((r) => r.account)`);
  assert.equal(acct.plan, "free");
  assert.equal(acct.trialEndsAt, null);
  const n = puts.length;
  await msg({ type: "sync-now" });
  await sleep(1500);
  assert.equal(puts.length, n, "depois do 402 não insiste");
  console.log("E2E FIM DO TESTE OK");
} finally {
  ws.close(); chrome.kill(); api.close(); await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
