// IA em paralelo e Parar: no Free, uma tarefa por vez (a pergunta espera a ata); no Pro, a pergunta roda
// enquanto a ata é gerada. Parar interrompe a resposta e guarda o que já foi escrito, com a nota.
// Também confere as datas (Hoje, Ontem, dia da semana) dentro das pastas da lista.
//   CHROME=... node test/e2e-ai-jobs.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "escribanote-aijobs-"));
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
async function waitFor(fn, what, ms = 10000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("tempo esgotado: " + what); await sleep(100); } }
const evIn = (sid) => (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });

const DAY = 86400_000;
const now = Date.now();
const meeting = (id, title, at, extra = {}) => ({ id, title, platform: "meet", meetingKey: "meet:" + id, startedAt: at, updatedAt: at + 60_000, endedAt: at + 60_000,
  speakers: { a: "Ana" }, entries: [{ id: "1", at: at + 1000, speakerId: "a", text: "Bom dia, vamos aprovar o orçamento.", kind: "caption", source: "protocol" }], asr: [], notes: { text: "", items: [] }, highlights: {}, chats: [], ...extra });
const today = new Date(); today.setHours(10, 0, 0, 0);
const sessions = [
  meeting("j-hoje", "Reunião de hoje", today.getTime(), { folderId: "f1" }),
  meeting("j-ontem", "Reunião de ontem", today.getTime() - DAY, { folderId: "f1" }),
  meeting("j-antes", "Reunião de semana passada", today.getTime() - 5 * DAY, { folderId: "f1" }),
  meeting("j-solta", "Reunião solta", today.getTime() - 2 * DAY),
];

try {
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  const { targetInfos } = await send("Target.getTargets");
  const swT = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
  const { sessionId: swSid } = await send("Target.attachToTarget", { targetId: swT.targetId, flatten: true });
  const sw = evIn(swSid);
  // IA simulada: cada resposta chega devagar (6 pedaços; 1,5 s cada na ata, 600 ms na pergunta); a ata começa com "# Ata".
  await sw(`(() => {
    globalThis.__realFetch ||= globalThis.fetch;
    if (chrome.permissions) chrome.permissions.contains = async () => true;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.anthropic.com/")) return globalThis.__realFetch(url, init);
      const body = JSON.parse(init.body);
      const isAta = JSON.stringify(body.system || "").includes("ata") && !JSON.stringify(body.messages).includes("Pergunta de teste");
      const parts = isAta ? ["# Ata\\n\\n", "Orçamento ", "aprovado ", "por ", "todos. ", "Fim da ata."] : ["Primeira ", "parte ", "da ", "resposta ", "longa ", "final."];
      const ev = (e) => "data: " + JSON.stringify(e) + "\\n\\n";
      const enc = new TextEncoder();
      const signal = init.signal;
      return new Response(new ReadableStream({ async start(c) {
        c.enqueue(enc.encode(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
        for (const t of parts) {
          await new Promise((r) => setTimeout(r, isAta ? 1500 : 600));
          if (signal?.aborted) return c.error(new DOMException("Aborted", "AbortError"));
          c.enqueue(enc.encode(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })));
        }
        c.enqueue(enc.encode(ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })));
        c.close();
      } }), { status: 200 });
    };
  })()`);

  const boot = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const b = await send("Target.attachToTarget", { targetId: boot.targetId, flatten: true });
  await sleep(800);
  await evIn(b.sessionId)(`(async () => {
    await chrome.runtime.sendMessage({ type: "import", sessions: ${JSON.stringify(sessions)} });
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ welcomeDone: Date.now(), apiKey: "sk-ant-teste", accountApi: "http://127.0.0.1:1", settings: { ...settings, folders: [{ id: "f1", name: "Projeto Alfa", collapsed: false }] } });
  })()`);

  // 1. Datas dentro da pasta
  {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1&view=list` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const ev = evIn(sessionId);
    await sleep(1200);
    await ev(`document.querySelector('button[data-nav="list"]').click()`);
    await waitFor(() => ev(`!!document.querySelector('[data-folder="f1"] .mcard')`), "pasta com reuniões").catch(async (e) => { console.log(await ev(`document.querySelector('#list')?.innerHTML.slice(0, 600) + " | hidden=" + document.querySelector('#view-list')?.hidden`), JSON.stringify(await ev(`chrome.runtime.sendMessage({ type: "list" }).then((l) => l.map((x) => [x.id, x.folderId]))`))); throw e; });
    const days = await ev(`[...document.querySelectorAll('[data-folder="f1"] .day')].map((d) => d.textContent)`);
    const ontem = new Date(today.getTime() - 5 * DAY).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    assert.deepEqual(days, ["Hoje", "Ontem", ontem], "datas na pasta: " + JSON.stringify(days));
    const loose = await ev(`[...document.querySelectorAll('[data-group="loose"] .day')].map((d) => d.textContent)`);
    assert.equal(loose.length, 1, "lista solta continua com a data");
    console.log("✓ pasta mostra as datas:", days.join(" / "));
    await send("Target.closeTarget", { targetId });
  }

  const openMeeting = async () => {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1&id=j-hoje` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const ev = evIn(sessionId);
    await waitFor(() => ev(`document.querySelector('#m-title')?.value === "Reunião de hoje"`), "reunião aberta");
    await ev(`chrome.permissions.contains = async () => true`);
    await ev(`(() => { window.__toasts = []; const o = new MutationObserver(() => document.querySelectorAll('.toast').forEach((t) => window.__toasts.push(t.textContent))); o.observe(document.body, { childList: true, subtree: true }); })()`);
    return { ev, targetId };
  };
  const startAta = async (ev) => {
    await ev(`document.querySelector('[data-tab="ata"]').click()`);
    await waitFor(() => ev(`!document.querySelector('#ata-gen').disabled`), "botão da ata");
    await ev(`document.querySelector('#ata-gen').click()`);
    await waitFor(() => ev(`document.querySelector('#ata-gen').textContent === "Cancelar"`), "ata em andamento");
    await ev(`document.querySelector('[data-tab="ai"]').click()`);
    await sleep(300);
  };
  const askQ = (ev) => ev(`(() => { const i = document.querySelector('#chat-input'); i.value = 'Pergunta de teste'; document.querySelector('#chat-send').click(); })()`);

  // 2. Free (só a chave): a pergunta espera a ata
  {
    const { ev, targetId } = await openMeeting();
    await startAta(ev);
    assert.equal(await ev(`document.querySelector('#chat-send').disabled`), true, "Enviar bloqueado no Free enquanto a ata roda");
    await askQ(ev);
    await sleep(500);
    assert.equal(await ev(`document.querySelectorAll('#chat-log .msg.user').length`), 0, "pergunta não sai no Free");
    await waitFor(async () => (await sw(`(async () => (await chrome.storage.local.get("session:j-hoje"))["session:j-hoje"].summary?.text || "")()`)).includes("Fim da ata"), "ata pronta", 15000);
    await waitFor(() => ev(`!document.querySelector('#chat-send').disabled`), "Enviar liberado depois da ata");
    console.log("✓ Free: uma tarefa por vez (Enviar bloqueado enquanto a ata é gerada)");
    await send("Target.closeTarget", { targetId });
  }

  // 3. Pro: ata e pergunta juntas; Parar guarda o parcial
  {
    await sw(`chrome.storage.local.set({ account: { token: "tok", plan: "pro", balance: 50, email: "a@b.c" } })`);
    const { ev } = await openMeeting();
    await ev(`document.querySelector('[data-tab="ai"]').click()`);
    await sleep(400);
    await startAta(ev);
    assert.equal(await ev(`document.querySelector('#chat-send').disabled`), false, "Enviar livre no Pro");
    await askQ(ev);
    await waitFor(() => ev(`document.querySelector('#chat-send').textContent === "Parar"`), "botão Parar");
    await waitFor(() => ev(`document.querySelector('#chat-log').textContent.includes('Primeira parte da')`), "resposta chegando", 8000);
    await ev(`document.querySelector('[data-tab="ata"]').click()`);
    assert.equal(await ev(`document.querySelector('#ata-gen').textContent`), "Cancelar", "ata segue rodando junto com a pergunta");
    await ev(`document.querySelector('[data-tab="ai"]').click()`);
    await ev(`document.querySelector('#chat-send').click()`); // Parar
    await waitFor(() => ev(`document.querySelector('#chat-send').textContent === "Enviar"`), "volta para Enviar");
    const saved = await waitFor(async () => {
      const s = await sw(`(async () => (await chrome.storage.local.get("session:j-hoje"))["session:j-hoje"])()`);
      const m = s.chats.at(-1)?.messages || [];
      return m.length === 2 && m[1].stopped ? m : null;
    }, "parcial guardado", 8000);
    assert.match(saved[1].text, /^Primeira parte da/);
    assert.match(saved[1].text, /interrompida por você/);
    assert.doesNotMatch(saved[1].text, /final\./);
    await waitFor(() => ev(`document.querySelector('#chat-log').textContent.includes('interrompida por você')`), "parcial na conversa").catch(async (e) => { console.log("LOG", await ev(`document.querySelector('#chat-log').textContent.replace(/\\s+/g, " ").slice(0, 300) + " | sel=" + document.querySelector('#chat-select')?.value + " | opts=" + [...document.querySelector('#chat-select').options].map((o) => o.value).join(",")`), JSON.stringify(await ev(`chrome.runtime.sendMessage({ type: "get", id: "j-hoje" }).then((s) => s.chats.map((c) => [c.id, c.messages.length]))`))); throw e; });
    await ev(`document.querySelector('[data-tab="ata"]').click()`);
    await waitFor(() => ev(`document.querySelector('#ata-gen').textContent === "Gerar de novo" && document.querySelector('#ata-body').textContent.includes("Fim da ata")`), "ata termina mesmo com a pergunta parada", 15000);
    console.log("✓ Pro: pergunta roda enquanto a ata é gerada; Parar guarda o parcial com a nota; a ata termina");
  }
  console.log("E2E IA EM PARALELO OK");
} finally {
  ws.close(); chrome.kill(); await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
