// Link colado: "Abrir e transcrever" abre o vídeo numa aba nova e espera o clique no ícone (o Chrome não
// deixa capturar uma aba que a extensão abriu sozinha). Duas rodadas:
//   1. sem liberação: a aba abre, o painel avisa que falta um clique e nada começa; fechar a aba desiste;
//   2. com a extensão liberada (--allowlisted-extension-id, como depois do clique): a transcrição começa sozinha.
//   CHROME=... node test/e2e-link.mjs   (PROFILE=<pasta> opcional; o áudio toca uma vez só, porque um vídeo em loop
//   encerra a transcrição sozinho desde a 0.9.78)
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9600 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE ? resolve(process.env.PROFILE) : mkdtempSync(join(tmpdir(), "escribanote-webtab-"));
import { createServer } from "node:http";
const PAGE = `<!doctype html><title>Aula de geografia - YouTube</title><audio id="a" autoplay></audio><script>
fetch("/fala.pcm").then((r) => r.arrayBuffer()).then((b) => {
  const pcm = new Uint8Array(b), gap = 16000 * 2 * 2, total = pcm.length + gap;
  const h = new DataView(new ArrayBuffer(44)); const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); h.setUint32(4, 36 + total, true); w(8, "WAVE"); w(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 16000, true); h.setUint32(28, 32000, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, "data"); h.setUint32(40, total, true);
  const a = document.getElementById("a"); a.src = URL.createObjectURL(new Blob([h, pcm, new Uint8Array(gap)], { type: "audio/wav" })); a.play();
});
</script>`;
const { readFileSync } = await import("node:fs");
const server = createServer((req, res) => {
  if (req.url === "/fala.pcm") { res.writeHead(200); return res.end(readFileSync(resolve(import.meta.dirname, "../src/asr/fala-teste.pcm"))); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(PAGE);
}).listen(0);
const PAGE_URL = `http://127.0.0.1:${server.address().port}/aula`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function launch(allow) { return spawn(CHROME, [...(process.env.HEADED ? [] : ["--headless=new"]), "--no-sandbox", "--no-first-run", ...(allow ? ["--allowlisted-extension-id=ohbnmfogdcbgegnpcaphidkjinplednd"] : []), "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank"], { stdio: "ignore" }); }
let ws, chrome, seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => { const id = ++seq; pending.set(id, { ok, fail }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
async function waitFor(fn, what, ms = 60000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("tempo esgotado: " + what); await sleep(300); } }
async function open(allow) {
  chrome = launch(allow); ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail))); } catch { ws = null; await sleep(200); }
  }
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { ok, fail } = pending.get(msg.id); pending.delete(msg.id); msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result); } };
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  // o app como painel (sem ?tab=1): segue a aba ativa, como o painel lateral
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1200);
  const ev = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 600000 }, sessionId).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
  return ev;
}
const close = async () => { ws.close(); chrome.kill(); await sleep(800); };
const submit = (ev, url) => ev(`(() => { document.querySelector("#link-url").value = ${JSON.stringify(url)}; document.querySelector("#link-form").requestSubmit(); return true; })()`);
// sem a permissão "tabs" a extensão não vê a URL da aba nova: confere pelo CDP e pega a aba mais nova
const linkTab = async (ev) => {
  const { targetInfos } = await send("Target.getTargets");
  if (!targetInfos.some((t) => t.type === "page" && t.url.startsWith("http://127.0.0.1"))) return null;
  return ev(`(async () => { const me = await chrome.tabs.getCurrent(); const all = await chrome.tabs.query({}); return Math.max(...all.filter((t) => t.id !== me.id).map((t) => t.id)); })()`);
};
const webSessions = (ev) => ev(`chrome.runtime.sendMessage({ type: "list" }).then((l) => l.filter((x) => x.platform === "web").map((x) => x.id))`);
try {
  // 1. sem liberação
  let ev = await open(false);
  assert.ok(await ev(`!document.querySelector("#link-form").closest("[hidden]")`), "campo do link visível sem reunião");
  await submit(ev, "javascript:alert(1)");
  await sleep(500);
  assert.equal(await linkTab(ev), null, "link inválido não abre aba");
  await submit(ev, PAGE_URL);
  const tabId = await waitFor(() => linkTab(ev), "aba do link aberta", 10000).catch(async (err) => {
    throw new Error(`${err.message} (aviso na tela: ${await ev(`[...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | ")`)}; link-open direto: ${JSON.stringify(await ev(`chrome.runtime.sendMessage({ type: "link-open", url: ${JSON.stringify(PAGE_URL)} }).catch((e) => "erro " + e.message)`))})`);
  });
  assert.equal(await ev(`chrome.runtime.sendMessage({ type: "link-pending", tabId: ${tabId} })`), "link");
  await waitFor(() => ev(`document.querySelector("#link-form").classList.contains("waiting") && /falta um clique/.test(document.querySelector("#link-title").textContent) && document.querySelector("#web-cta").hidden`), "aviso de falta um clique", 10000);
  await sleep(4000);
  assert.deepEqual(await webSessions(ev), [], "sem o clique nada começa");
  console.log("✓ sem o clique: aba aberta, painel avisa que falta um clique e nada começa");
  await ev(`chrome.tabs.remove(${tabId})`);
  await sleep(500);
  assert.equal(await ev(`chrome.runtime.sendMessage({ type: "link-pending", tabId: ${tabId} })`), false, "aba fechada desiste");
  console.log("✓ fechar a aba desiste da espera");
  // "Transcrever esta aba" sem o clique no ícone: espera em vez de erro, e nenhuma sessão vazia fica na lista
  const t3 = (await ev(`chrome.tabs.create({ url: ${JSON.stringify(PAGE_URL)}, active: false })`)).id;
  await sleep(1500);
  const r3 = await ev(`chrome.runtime.sendMessage({ type: "web-start", tabId: ${t3} })`);
  assert.deepEqual(r3, { waiting: true }, "web-start sem o clique espera: " + JSON.stringify(r3));
  assert.equal(await ev(`chrome.runtime.sendMessage({ type: "link-pending", tabId: ${t3} })`), "web");
  await sleep(2000);
  assert.deepEqual(await webSessions(ev), [], "sem sessão vazia");
  await ev(`chrome.tabs.remove(${t3})`);
  console.log("✓ Transcrever esta aba sem o clique: fica esperando, sem erro e sem sessão vazia");
  await close();

  // 2. liberada (equivale ao clique no ícone): começa sozinha
  ev = await open(true);
  await submit(ev, PAGE_URL);
  const tab2 = await waitFor(() => linkTab(ev), "aba do link aberta", 10000);
  const id = await waitFor(async () => (await webSessions(ev))[0], "sessão começa sozinha", 30000);
  await waitFor(() => ev(`chrome.runtime.sendMessage({ type: "hq-get", tabId: ${tab2} }).then((h) => h && h.state === "running")`), "captura da aba ligada", 120000).catch(async (err) => { console.log("hq:", JSON.stringify(await ev(`chrome.runtime.sendMessage({ type: "hq-get", tabId: ${tab2} })`)), "sessão:", JSON.stringify((await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })`))?.report?.events?.slice(-4))); throw err; });
  let s = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })`);
  assert.ok(s.web && !s.endedAt && s.url.startsWith(PAGE_URL), "sessão web ao vivo com a URL: " + s.url);
  assert.ok(s.report.events.some((e) => e.kind === "web-start" && e.detail?.link === true), "evento do link");
  await waitFor(() => ev(`!document.querySelector("#m").hidden && ["Aula de geografia", "127.0.0.1"].includes(document.querySelector("#m-title").value)`), "painel mostra a sessão", 20000);
  // (o título do vídeo só aparece com o clique de verdade: a liberação do teste não dá acesso ao título da aba)
  assert.equal(await ev(`chrome.runtime.sendMessage({ type: "link-pending", tabId: ${tab2} })`), false);
  s = await ev(`chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })`);
  console.log("✓ com o clique: a transcrição começa sozinha e o painel mostra a sessão (" + s.title + ")");
  await ev(`chrome.runtime.sendMessage({ type: "end-live", id: ${JSON.stringify(id)} })`);
  console.log("E2E LINK OK");
} finally {
  try { await close(); } catch {}
  server.close();
  if (!process.env.PROFILE) rmSync(profile, { recursive: true, force: true });
}
