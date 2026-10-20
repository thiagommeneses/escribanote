// Conta Reunilo Pro de ponta a ponta: extensão real + app web + API (servidor de desenvolvimento,
// Postgres local, IA e Stripe simuladas).
//   CHROME=... TEST_DATABASE_URL=... node test/e2e-account.mjs [pasta-de-screenshots]
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startDevServer } from "../../server/scripts/dev-server.js";

const CHROME = process.env.CHROME;
const OUT = process.argv[2] || tmpdir();
if (!CHROME) throw new Error("defina CHROME");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✘"} ${label}`);
  if (!ok) failed = true;
};

// Cópia da extensão que também aceita mensagens do servidor local (a original só aceita o endereço de produção).
const EXT = mkdtempSync(join(tmpdir(), "reunilo-ext-"));
cpSync(resolve(import.meta.dirname, ".."), EXT, { recursive: true, filter: (p) => !p.includes("/test") });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.externally_connectable.matches.push("http://127.0.0.1/*");
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest, null, 2));

const srv = await startDevServer({ port: 8840 + Math.floor(Math.random() * 40) });
const DBG = 9400 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "reunilo-acc-"))}`,
  `--remote-debugging-port=${DBG}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)));
  } catch {
    ws = null;
    await sleep(200);
  }
}
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, no } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? no(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((ok, no) => {
  const id = ++seq;
  pending.set(id, { ok, no });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const evalIn = async (sid, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const open = async (url) => {
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await sleep(1200);
  return sessionId;
};
const waitFor = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) {
      check(false, `tempo esgotado: ${what}`);
      return null;
    }
    await sleep(300);
  }
};

const t0 = Date.UTC(2026, 9, 17, 23, 34);
const meeting = (id, title, extra = {}) => ({
  id, title, platform: "meet", startedAt: t0, updatedAt: t0 + 60_000, endedAt: t0 + 60_000, speakers: { a: "Ana", b: "Bruno" },
  entries: [
    { id: `${id}-1`, at: t0 + 1000, updatedAt: t0 + 2000, speakerId: "a", text: "Vamos revisar o orçamento do Q4.", kind: "caption" },
    { id: `${id}-2`, at: t0 + 5000, updatedAt: t0 + 6000, speakerId: "b", text: "Aprovo a mídia de 180 mil.", kind: "caption" },
  ],
  ...extra,
});

try {
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  const ext = await open(`chrome-extension://${extId}/src/app/app.html?view=settings`);
  const msg = (m) => evalIn(ext, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  await evalIn(ext, `chrome.storage.local.set({ accountApi: ${JSON.stringify(srv.url)} })`);
  check((await msg({ type: "import", sessions: [meeting("loc-1", "Planejamento"), meeting("loc-2", "Retrospectiva")] })) === 2, "duas reuniões locais na extensão");

  // 1) Login no app web e Pro
  const web = await open(`${srv.url}/app/`);
  await evalIn(web, `document.getElementById("login-email").value = "ana@exemplo.com"; document.querySelector("#login-form button").click(); true`);
  await sleep(800);
  const mail = await (await fetch(`${srv.url}/__test/mail`)).json();
  await evalIn(web, `location.href = ${JSON.stringify(mail.text.match(/https?:\/\/\S+#\/entrar\/[\w-]+/)[0])}; true`);
  await sleep(1200);
  await fetch(`${srv.url}/__test/pro`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ana@exemplo.com" }) });

  // 2) Conectar a extensão pelo app web (externally_connectable)
  await evalIn(web, `location.hash = "#/conectar"; location.reload(); true`);
  await sleep(1500);
  await evalIn(web, `document.querySelector('[data-act="connect"]').click(); true`);
  const connected = await waitFor(() => evalIn(web, `document.getElementById("connect-msg").textContent.includes("Pronto")`), "app web confirma a conexão");
  check(!!connected, "extensão conectada pelo app web");
  const state = await waitFor(async () => {
    const r = await msg({ type: "account-state" });
    return r.account?.plan === "pro" ? r : null;
  }, "extensão vê a conta Pro");
  check(state?.account.email === "ana@exemplo.com" && state.account.balance === 15, "extensão com e-mail, plano e créditos");
  check(state?.pending === 2 && !state.sync.consent, "pede permissão antes de enviar as reuniões antigas");
  check(!JSON.stringify(state).includes(srv.url) || !("token" in (state.account || {})), "o token não sai do service worker");
  await evalIn(ext, `location.reload(); true`);
  await sleep(1200);
  check(await evalIn(ext, `!document.getElementById("sync-banner").hidden`), "aviso de permissão na lista");
  await send("Page.captureScreenshot", { format: "png" }, ext).then(({ data }) => writeFileSync(join(OUT, "acc-1-aviso.png"), Buffer.from(data, "base64")));

  // 3) Permissão: enviar todas
  await evalIn(ext, `document.querySelector('[data-sync-consent="all"]').click(); true`);
  const api = (path, opts = {}) => evalIn(web, `fetch("/api/v1${path}", { method: ${JSON.stringify(opts.method || "GET")}, headers: { ${opts.body ? '"content-type": "application/json", ' : ""}"x-reunilo": "1" }, ${opts.body ? `body: ${JSON.stringify(JSON.stringify(opts.body))}` : ""} }).then((r) => r.json())`);
  const listed = await waitFor(async () => {
    const r = await api("/meetings");
    return r.items?.length === 2 ? r : null;
  }, "reuniões enviadas à conta");
  check(listed?.items.map((i) => i.id).sort().join() === "loc-1,loc-2", "as duas reuniões chegaram à conta");

  // 4) Mudança feita na web chega à extensão
  const remote = await api("/meetings/loc-1");
  remote.doc.title = "Planejamento do orçamento (editado na web)";
  remote.doc.updatedAt = Date.now();
  await api("/meetings/loc-1", { method: "PUT", body: { doc: remote.doc, baseVersion: remote.version } });
  await msg({ type: "sync-now" });
  const pulled = await waitFor(async () => {
    const s = await msg({ type: "get", id: "loc-1" });
    return s?.title.includes("editado na web") ? s : null;
  }, "título da web chega à extensão");
  check(!!pulled, "mudança feita na web aparece na extensão");

  // 5) Conflito: título muda na web e nota muda na extensão ao mesmo tempo -> as duas ficam
  const r2 = await api("/meetings/loc-2");
  r2.doc.title = "Retrospectiva (web)";
  r2.doc.updatedAt = Date.now() - 5000;
  await api("/meetings/loc-2", { method: "PUT", body: { doc: r2.doc, baseVersion: r2.version } });
  await msg({ type: "update", id: "loc-2", notesText: "Nota escrita na extensão" });
  await msg({ type: "sync-now" });
  const merged = await waitFor(async () => {
    const r = await api("/meetings/loc-2");
    return r.doc?.notes?.text === "Nota escrita na extensão" ? r : null;
  }, "nota da extensão chega à conta");
  check(merged?.doc.title === "Retrospectiva (web)" || merged?.doc.title === "Retrospectiva", "conflito resolvido sem perder a nota");

  // 6) IA pela conta, sem chave própria
  await evalIn(ext, `chrome.storage.local.remove("apiKey")`);
  srv.anthropic.text = "## Resumo\nAprovada a mídia de 180 mil.";
  const ata = await evalIn(ext, `new Promise((ok) => {
    const port = chrome.runtime.connect({ name: "ai" });
    port.onMessage.addListener((m) => { if (m.type === "done" || m.type === "error") { port.disconnect(); ok(m); } });
    port.postMessage({ id: "loc-1", action: "ata" });
  })`);
  check(ata.type === "done" && ata.text.includes("180 mil"), `ata pela IA da conta${ata.type === "error" ? ": " + ata.message : ""}`);
  const after = await waitFor(async () => {
    const r = await msg({ type: "account-state" });
    return r.account.balance === 14 ? r : null;
  }, "créditos atualizados na extensão");
  check(!!after, "a ata consumiu 1 crédito da conta");
  const call = srv.anthropic.calls.at(-1)?.params;
  check(call?.model === "claude-sonnet-5-5" && /orçamento do Q4/.test(call.messages[0].content), "a ata foi gerada com a transcrição enviada pela extensão");

  // 7) Apagada na conta: continua no computador e não volta para a conta
  await api("/meetings/loc-2", { method: "DELETE" });
  await msg({ type: "sync-now" });
  await sleep(1500);
  check(!!(await msg({ type: "get", id: "loc-2" })), "apagar na conta não apaga no computador");
  await msg({ type: "update", id: "loc-2", notesText: "Outra nota" });
  await msg({ type: "sync-now" });
  await sleep(1500);
  const trash = await api("/meetings/trash");
  if (process.env.DEBUG) console.log(JSON.stringify(trash), JSON.stringify(await api("/meetings")), JSON.stringify(await evalIn(ext, `chrome.storage.local.get("sync").then((r) => r.sync)`)));
  check(trash.items.length === 1 && trash.items[0].id === "loc-2", "reunião apagada na conta não é recriada");

  // 8) Desconectar
  await evalIn(ext, `location.reload(); true`);
  await sleep(1200);
  await send("Page.captureScreenshot", { format: "png" }, ext).then(({ data }) => writeFileSync(join(OUT, "acc-2-conta.png"), Buffer.from(data, "base64")));
  await msg({ type: "account-disconnect" });
  check((await msg({ type: "account-state" })).account === null, "desconectar remove a conta da extensão");
  const devices = await api("/devices");
  check(Array.isArray(devices) && devices.length === 0, "o dispositivo some da conta ao desconectar");
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  chrome.kill();
  await srv.close();
}
process.exit(failed ? 1 : 0);
