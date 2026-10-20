// Teste ponta a ponta: carrega a extensão num Chrome real, serve páginas falsas
// em https://meet.google.com (via CDP Fetch), envia pacotes captions_v2 e collections
// por um par WebRTC local e confere widget, sessão salva e app.
//
//   CHROME=/caminho/para/chrome node test/e2e-meet.mjs [pasta-para-screenshots]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) {
  console.error("Defina CHROME com o caminho do executável do Chrome/Chromium.");
  process.exit(2);
}
const SHOTS = process.argv[2] || null;
// Cópia da extensão só para o teste: com a API do Claude já autorizada, porque o
// Chrome headless não mostra o pedido de permissão opcional.
const SRC = resolve(import.meta.dirname, "..");
const EXT = mkdtempSync(join(tmpdir(), "reunilo-ext-"));
for (const d of ["manifest.json", "icons", "src", "vendor"]) cpSync(join(SRC, d), join(EXT, d), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions = ["https://api.anthropic.com/*"];
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest));
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "reunilo-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (t) => console.log("✓", t);

const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--window-size=1400,900",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "about:blank",
], { stdio: "ignore" });

// ---------- CDP mínimo ----------
async function cdpConnect() {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
      return ws;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("Chrome não abriu a porta de depuração");
}
const ws = await cdpConnect();
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else for (const l of listeners) l(msg);
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, fail) => {
    const id = ++seq;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
const evaluate = async (sid, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function screenshot(sid, name) {
  if (!SHOTS) return;
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sid);
  writeFileSync(join(SHOTS, name), Buffer.from(data, "base64"));
}
async function waitFor(fn, what, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("tempo esgotado: " + what);
    await sleep(200);
  }
}

// Shadow DOM fechado do widget: acessado via DOM.getDocument({pierce}).
async function widgetCall(sid, selector, fn = "function(){ return this.innerText }", arg) {
  const { root } = await send("DOM.getDocument", { depth: -1, pierce: true }, sid);
  const find = (n) => {
    if (n.nodeName === "REUNILO-WIDGET") return n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) {
      const f = find(c);
      if (f) return f;
    }
    return null;
  };
  const host = find(root);
  if (!host) return null;
  const shadow = host.shadowRoots[0];
  const { nodeId } = await send("DOM.querySelector", { nodeId: shadow.nodeId, selector }, sid);
  if (!nodeId) return null;
  const { object } = await send("DOM.resolveNode", { nodeId }, sid);
  const r = await send("Runtime.callFunctionOn", {
    objectId: object.objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true,
    arguments: arg === undefined ? [] : [{ value: arg }],
  }, sid);
  return r.result.value;
}
const click = (sid, sel) => widgetCall(sid, sel, "function(){ this.click(); return true }");

const MEET_HTML = (title) => `<!doctype html><html><head><title>Meet - ${title}</title></head><body style="background:#202124;margin:0;height:100vh">
<div style="color:#fff;font:20px sans-serif;padding:40px">Reunião simulada</div>
<div role="region" aria-label="Legendas" style="position:fixed;bottom:80px;left:40px;color:#fff">legenda nativa</div>
<button aria-label="Sair da chamada" style="position:fixed;bottom:16px;left:50%">sair</button></body></html>`;

// Abre uma "reunião" e devolve a sessão CDP.
async function openMeet(code, title) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://meet.google.com/*" }] }, sessionId);
  listeners.push((msg) => {
    if (msg.method === "Fetch.requestPaused" && msg.sessionId === sessionId) {
      send("Fetch.fulfillRequest", {
        requestId: msg.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(MEET_HTML(title)).toString("base64"),
      }, sessionId);
    }
  });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `https://meet.google.com/${code}` }, sessionId);
  await waitFor(() => evaluate(sessionId, "!!window.__reuniloMeetHooked && document.readyState === 'complete'"), "coletor injetado");
  // Par WebRTC local: pc1 envia, pc2 recebe pelo evento "datachannel" (como no Meet).
  await evaluate(sessionId, `(async () => {
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    window.__caps = pc1.createDataChannel("captions_v2");
    window.__coll = pc1.createDataChannel("collections");
    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);
    await Promise.all([__caps, __coll].map((c) => new Promise((ok) => c.readyState === "open" ? ok() : (c.onopen = ok))));
    await new Promise((r) => setTimeout(r, 300));
    const enc = window.ReuniloProto.encode;
    window.__device = (dev, name) => __coll.send(enc([[1, "message", [[2, "message", [[13, "message", [[1, "message", [[2, "message", [[1, "string", dev], [2, "string", name]]]]]]]]]]]]));
    window.__say = (id, v, text, dev) => __caps.send(enc([[1, "message", [[1, "varint", id], [2, "varint", v], [3, "message", [[3, "string", text], [4, "string", "pt-BR"], [6, "string", dev]]]]]]));
  })()`);
  return sessionId;
}

const ANA = "spaces/e2e/devices/7";
const BRUNO = "spaces/e2e/devices/8";

try {
  // 1) Extensão carregada
  let extId = null;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  assert.ok(extId, "service worker da extensão não iniciou");
  step(`extensão carregada (${extId})`);

  // Página da extensão usada para consultar o service worker.
  const { targetId: appTarget } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId: app } = await send("Target.attachToTarget", { targetId: appTarget, flatten: true });
  await send("Page.enable", {}, app);
  await sleep(800);
  const sw = (msg) => evaluate(app, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

  // 2) Reunião com legendas e nomes
  const meet = await openMeet("abc-defg-hij", "Planejamento Q4");
  await evaluate(meet, `(async () => {
    __device(${JSON.stringify(ANA)}, "Ana Teste"); __device(${JSON.stringify(BRUNO)}, "Bruno Lima");
    __say(501, 1, "Bom dia", ${JSON.stringify(ANA)});
    __say(501, 2, "Bom dia a todos, vamos revisar o orçamento?", ${JSON.stringify(ANA)});
    await new Promise((r) => setTimeout(r, 200));
    __say(601, 1, "Pode ser. Eu aprovo a proposta de marketing.", ${JSON.stringify(BRUNO)});
    await new Promise((r) => setTimeout(r, 200));
    __say(502, 1, "Combinado, eu envio o documento até sexta.", ${JSON.stringify(ANA)});
  })()`);
  const index = await waitFor(async () => {
    const i = await sw({ type: "list" });
    return i.length && i[0].count === 3 ? i : null;
  }, "sessão salva");
  const id = index[0].id;
  let s = await sw({ type: "get", id });
  assert.equal(s.title, "Planejamento Q4");
  assert.equal(s.speakers[ANA], "Ana Teste");
  assert.deepEqual(index[0].participants, ["Ana Teste", "Bruno Lima"]);
  step("legendas e nomes captados e salvos");

  // 3) Widget dentro da reunião
  const body = await waitFor(() => widgetCall(meet, "#body"), "widget visível");
  await waitFor(async () => /vamos revisar o orçamento/.test(await widgetCall(meet, "#body")), "widget com a transcrição");
  assert.ok(await evaluate(meet, "!!document.getElementById('reunilo-hide-captions')"), "legendas nativas deveriam estar ocultas");
  step("widget mostra a transcrição ao vivo e oculta as legendas nativas");
  void body;

  await click(meet, "#hl");
  await waitFor(async () => Object.values((await sw({ type: "get", id })).highlights).flat().includes("importante"), "destaque salvo");
  step("botão ⭐ do widget destaca o último bloco");

  await click(meet, "#note");
  await widgetCall(meet, "#note-input", "function(v){ this.value = v; return true }", "Confirmar verba com o financeiro");
  await click(meet, "#note-send");
  await waitFor(async () => (await sw({ type: "get", id })).notes.items.length === 1, "nota salva");
  step("nota com horário salva pelo widget");
  await screenshot(meet, "1-widget.png");

  await click(meet, "#pause");
  await waitFor(async () => (await sw({ type: "get", id })).paused, "pausa");
  await evaluate(meet, `__say(503, 1, "Isto não deveria ser gravado.", ${JSON.stringify(ANA)})`);
  await sleep(1500);
  assert.equal((await sw({ type: "get", id })).entries.length, 3);
  await click(meet, "#pause");
  await waitFor(async () => !(await sw({ type: "get", id })).paused, "retomar");
  await evaluate(meet, `__say(504, 1, "Retomando a gravação.", ${JSON.stringify(BRUNO)})`);
  await waitFor(async () => (await sw({ type: "get", id })).entries.length === 4, "fala após retomar");
  step("pausar descarta falas; retomar volta a gravar");

  // 4) App em aba cheia
  await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html?id=${id}` }, app);
  await sleep(1200);
  const tl = await evaluate(app, "document.getElementById('timeline').innerText");
  assert.match(tl, /Ana Teste/);
  assert.match(tl, /Confirmar verba com o financeiro/);
  assert.match(tl, /Importante/);
  await screenshot(app, "2-app-transcricao.png");
  const pane = async (tab) => {
    await evaluate(app, `document.querySelector('[data-tab="${tab}"]').click()`);
    await sleep(400);
    return evaluate(app, `document.getElementById('pane-${tab}').innerText`);
  };
  assert.match(await pane("highlights"), /Importante[\s\S]*Retomando|Importante[\s\S]*documento/);
  await screenshot(app, "3-app-destaques.png");
  const stats = await pane("stats");
  assert.match(stats, /Parcela de fala/);
  assert.match(stats, /Ana Teste/);
  await screenshot(app, "4-app-analise.png");
  assert.match(await pane("ai"), /Pergunte à IA[\s\S]*Itens de ação/);
  await screenshot(app, "5-app-ia.png");
  step("app mostra transcrição, destaques, análise e IA");

  const hits = await sw({ type: "search", q: "marketing" });
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /marketing/);
  step("busca em todas as transcrições");

  // 5) Modo "perguntar antes de transcrever"
  await evaluate(app, `(async () => { const { settings } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, mode: "ask" } }); })()`);
  const meet2 = await openMeet("xyz-abcd-efg", "Reunião sigilosa");
  await waitFor(async () => /Transcrever esta reunião\?/.test((await widgetCall(meet2, "#body")) || ""), "pergunta de consentimento");
  await evaluate(meet2, `__say(701, 1, "Fala antes de decidir.", ${JSON.stringify(ANA)})`);
  await sleep(1500);
  assert.equal((await sw({ type: "list" })).length, 1, "não deveria salvar antes do consentimento");
  await screenshot(meet2, "6-consentimento.png");
  await click(meet2, '[data-consent="once"]');
  await waitFor(async () => (await sw({ type: "list" })).length === 2, "salva depois do sim");
  step("modo 'perguntar' só grava depois do consentimento (e não perde o que já foi dito)");

  // 6) Lista de reuniões no app
  await evaluate(app, `document.querySelector('[data-nav="meeting"]').click()`);
  await sleep(600);
  const list = await evaluate(app, "document.getElementById('list').innerText");
  assert.match(list, /Planejamento Q4/);
  assert.match(list, /Reunião sigilosa/);
  await screenshot(app, "7-app-lista.png");
  step("lista de reuniões");

  // 7) Exportações a partir do app
  const md = await evaluate(app, `(async () => {
    const { toMarkdown } = await import("../lib/format.js");
    const { normalize } = await import("../lib/transcript.js");
    return toMarkdown(normalize(await chrome.runtime.sendMessage({ type: "get", id: ${JSON.stringify(id)} })));
  })()`);
  assert.match(md, /## Destaques/);
  assert.match(md, /📝 `\d\d:\d\d:\d\d` Confirmar verba/);
  step("exportação em Markdown com destaques e notas");

  // 8) Reconhecimento: idioma, Whisper e revisão por IA (API simulada)
  const { targetInfos } = await send("Target.getTargets");
  const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
  const { sessionId: swSid } = await send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://api.anthropic.com/*" }] }, swSid);
  const apiCalls = [];
  const sse = (text) => [
    { type: "message_start", message: { id: "msg_test", role: "assistant", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.match(/.{1,40}/gs).map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  listeners.push((msg) => {
    if (msg.method !== "Fetch.requestPaused" || msg.sessionId !== swSid) return;
    const body = JSON.parse(msg.params.request.postData || "{}");
    apiCalls.push({ headers: msg.params.request.headers, body });
    let text = "Resposta de teste.";
    if (body.output_config?.format) {
      // revisão: corrige "quiu quatro" -> "Q4" em qualquer fala pedida
      const items = [...body.messages[0].content.matchAll(/\{"id":"([^"]+)","falante":"[^"]*","texto":"([^"]*)"\}/g)];
      const fixes = items.filter((m) => /quiu quatro/.test(m[2])).map((m) => ({ id: m[1], text: m[2].replace("quiu quatro", "Q4") }));
      text = JSON.stringify({ fixes });
    } else if (/decidido/.test(JSON.stringify(body.messages))) text = "- Aprovado o orçamento do **Q4**.";
    send("Fetch.fulfillRequest", {
      requestId: msg.params.requestId, responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "text/event-stream" }],
      body: Buffer.from(sse(text)).toString("base64"),
    }, swSid);
  });
  await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html?id=${id}` }, app);
  await sleep(1000);
  const granted = await send("Runtime.evaluate", {
    expression: `Promise.race([chrome.permissions.request({ origins: ["https://api.anthropic.com/*"] }), new Promise((r) => setTimeout(() => r(false), 3000))])`, awaitPromise: true, returnByValue: true, userGesture: true,
  }, app);
  if (!granted.result.value) {
    console.log("⚠ permissão opcional não concedida no Chrome headless; etapas de IA puladas");
  } else {
    await evaluate(app, `(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ apiKey: "sk-ant-teste", settings: { ...settings, mode: "always", glossary: "Q4\\nOKR" } });
    })()`);
    await evaluate(meet, `__say(505, 1, "Então fechamos o orçamento do quiu quatro hoje.", ${JSON.stringify(ANA)})`);
    await waitFor(async () => (await sw({ type: "get", id })).entries.length === 5, "nova fala");
    await evaluate(app, `document.querySelector('[data-tab="ai"]').click()`);
    await sleep(400);
    await evaluate(app, `document.getElementById("review-run").click()`);
    await waitFor(async () => Object.values((await sw({ type: "get", id })).fixes).some((t) => /Q4 hoje/.test(t)), "correção salva");
    const reviewCall = apiCalls.find((c) => c.body.output_config?.format);
    assert.equal(reviewCall.headers["anthropic-dangerous-direct-browser-access"], "true");
    assert.equal(reviewCall.body.model, "claude-opus-5-5");
    assert.match(reviewCall.body.messages[0].content, /<glossario>\nQ4\nOKR/);
    await evaluate(app, `document.querySelector('[data-tab="transcript"]').click()`);
    await sleep(500);
    const html = await evaluate(app, "document.getElementById('timeline').innerHTML");
    assert.match(html, /✓ revisado/);
    assert.match(html, /<ins>Q4<\/ins>/);
    await screenshot(app, "10-revisao.png");
    step("revisão por IA corrige 'quiu quatro' → 'Q4' usando o glossário (API simulada)");

    await evaluate(app, `document.querySelector('[data-tab="ai"]').click()`);
    await sleep(300);
    await evaluate(app, `[...document.querySelectorAll("#quick .chip")].find((b) => /decidido/.test(b.textContent)).click()`);
    await waitFor(async () => (await sw({ type: "get", id })).chats.at(-1)?.messages.length === 2, "resposta do chat");
    assert.match(await evaluate(app, "document.getElementById('chat-log').innerText"), /Aprovado o orçamento do Q4/);
    step("Pergunte à IA responde em streaming e salva a conversa");
  }

  // Segmento do Whisper (simulando o documento offscreen) substitui a legenda
  const meetTabId = await evaluate(app, `(async () => {
    for (const t of await chrome.tabs.query({})) {
      if ((await chrome.runtime.sendMessage({ type: "active-for-tab", tabId: t.id })) === ${JSON.stringify(id)}) return t.id;
    }
  })()`);
  await evaluate(meet, `__say(506, 1, "o ó que erre do time de vendas", ${JSON.stringify(BRUNO)})`);
  await waitFor(async () => (await sw({ type: "get", id })).entries.some((e) => e.id.startsWith("506/")), "legenda 506");
  const cap = (await sw({ type: "get", id })).entries.find((e) => e.id.startsWith("506/"));
  await sw({ type: "asr-result", tabId: meetTabId, seg: { start: cap.at - 1200, end: cap.at + 1500, text: "O OKR do time de vendas.", source: "tab" } });
  await waitFor(async () => /OKR do time de vendas/.test((await widgetCall(meet, "#body")) || ""), "widget com texto do Whisper");
  const s2 = await sw({ type: "get", id });
  assert.equal(s2.asr[0].speakerId, BRUNO);
  step("segmento do Whisper ganha o falante pelas legendas e aparece no widget");

  // Legenda em idioma errado
  const meet3 = await openMeet("lng-test-abc", "Reunião em inglês");
  await evaluate(meet3, `(async () => { for (let i = 0; i < 4; i++) { __caps.send(window.ReuniloProto.encode([[1, "message", [[1, "varint", 900 + i], [2, "varint", 1], [3, "message", [[3, "string", "we should close this today " + i], [4, "string", "en-US"], [6, "string", ${JSON.stringify(ANA)}]]]]]])); await new Promise((r) => setTimeout(r, 150)); } })()`);
  await waitFor(async () => /legendas estão em inglês/.test((await widgetCall(meet3, "#body")) || ""), "aviso de idioma");
  await screenshot(meet3, "11-aviso-idioma.png");
  step("widget avisa quando as legendas estão no idioma errado");

  // 9) Layout estreito (largura do painel lateral) e Ajustes
  await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 820, deviceScaleFactor: 1, mobile: false }, app);
  await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html?id=${id}` }, app);
  await sleep(1200);
  assert.ok(await evaluate(app, "!document.body.classList.contains('wide')"));
  await screenshot(app, "8-painel-estreito.png");
  await evaluate(app, `document.querySelector('[data-nav="settings"]').click()`);
  await sleep(600);
  assert.match(await evaluate(app, "document.getElementById('view-settings').innerText"), /Tags de destaque[\s\S]*Inteligência artificial/);
  await screenshot(app, "9-ajustes.png");
  step("layout de painel lateral e Ajustes");

  console.log("\nE2E OK");
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
}
