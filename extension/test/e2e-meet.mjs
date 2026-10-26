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
const EXT = mkdtempSync(join(tmpdir(), "escribanote-ext-"));
for (const d of ["manifest.json", "icons", "src", "vendor"]) cpSync(join(SRC, d), join(EXT, d), { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
manifest.host_permissions = ["https://api.anthropic.com/*"];
writeFileSync(join(EXT, "manifest.json"), JSON.stringify(manifest));
const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "escribanote-e2e-"));
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
    if (n.nodeName === "ESCRIBANOTE-WIDGET") return n;
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
// Entrada "de verdade" pelo CDP (mousedown/mouseup/click e teclas), para pegar bugs de ordem de eventos.
async function mouseClick(sid, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sid);
}
async function typeText(sid, text) {
  await send("Input.insertText", { text }, sid);
}
async function pressKey(sid, key) {
  const vk = { Enter: 13, Escape: 27 }[key];
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sid);
}
const rectOf = (sid, sel) => widgetCall(sid, sel, "function(){ const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }");

const MEET_HTML = (title, extra = "") => `<!doctype html><html><head><title>Meet - ${title}</title></head><body style="background:#202124;margin:0;height:100vh">
<div style="color:#fff;font:20px sans-serif;padding:40px">Reunião simulada</div>
<div data-participant-id="spaces/abc/devices/1" data-self-name="Thiago Teste" style="color:#fff"><span>Você</span></div>
<div data-participant-id="spaces/abc/devices/9" style="color:#fff"><span>Carla Bloco</span></div>
<div role="region" aria-label="Legendas" style="position:fixed;bottom:80px;left:40px;color:#fff">legenda nativa</div>
<button aria-label="Sair da chamada" style="position:fixed;bottom:16px;left:50%">sair</button>${extra}</body></html>`;

// Abre uma "reunião" e devolve a sessão CDP.
async function openMeet(code, title, extra = "") {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://meet.google.com/*" }] }, sessionId);
  listeners.push((msg) => {
    if (msg.method === "Fetch.requestPaused" && msg.sessionId === sessionId) {
      send("Fetch.fulfillRequest", {
        requestId: msg.params.requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(MEET_HTML(title, extra)).toString("base64"),
      }, sessionId);
    }
  });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `https://meet.google.com/${code}` }, sessionId);
  await waitFor(() => evaluate(sessionId, "!!window.__escribanoteMeetHooked && document.readyState === 'complete'"), "coletor injetado");
  // Par WebRTC local: pc1 envia, pc2 recebe pelo evento "datachannel" (como no Meet).
  await evaluate(sessionId, `(async () => {
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    window.__pcs = [pc1, pc2];
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
    const enc = window.EscribanoteProto.encode;
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

  // Primeira execução: a janela de boas-vindas abre sozinha; escolhe a área interna para o backup automático
  assert.equal(await evaluate(app, "document.getElementById('welcome').open"), true, "janela de primeira execução aberta");
  await screenshot(app, "0-boas-vindas.png");
  await evaluate(app, `document.querySelector('#welcome [name="w-backup"][value="opfs"]').click(); document.getElementById('w-next').click(); true`);
  await sleep(100);
  await evaluate(app, `document.querySelector('#welcome [name="w-mode"][value="always"]').click(); document.getElementById('w-next').click(); true`);
  await sleep(100);
  await evaluate(app, `document.getElementById('w-next').click(); true`);
  await waitFor(async () => (await evaluate(app, `(async () => (await chrome.storage.local.get(["welcomeDone", "settings"])))()`)).settings.backupAuto === "opfs", "escolhas da primeira execução salvas");
  assert.equal(await evaluate(app, "document.getElementById('welcome').open"), false);
  step("primeira execução: janela de boas-vindas salva backup automático (área interna) e modo de gravação");

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
  await waitFor(async () => {
    const sp = (await sw({ type: "get", id })).speakers;
    return sp["spaces/abc/devices/1"] === "Thiago Teste" && sp["spaces/abc/devices/9"] === "Carla Bloco";
  }, "nomes lidos dos blocos de participante (data-participant-id)");
  step("próprio usuário e participantes nomeados pelos blocos de vídeo");
  // Idioma da interface lido do botão "Sair da chamada" (pt) e estágio "na reunião"
  await waitFor(async () => (await sw({ type: "get", id })).uiLang === "pt", "idioma da interface do Meet");
  assert.equal((await sw({ type: "list" }))[0].part, 1);
  step("idioma da interface (pt) lido do botão 'Sair da chamada'");

  // 3) Widget dentro da reunião
  const body = await waitFor(() => widgetCall(meet, "#body"), "widget visível");
  await waitFor(async () => /vamos revisar o orçamento/.test(await widgetCall(meet, "#body")), "widget com a transcrição");
  assert.ok(await evaluate(meet, "!!document.getElementById('escribanote-hide-captions')"), "legendas nativas deveriam estar ocultas");
  step("widget mostra a transcrição ao vivo e oculta as legendas nativas");
  void body;

  // Renomear falante no widget, ao vivo: clique no nome → campo inline → Enter
  const nameAt = await rectOf(meet, `.blk .who b[data-speaker="${BRUNO}"]`);
  await mouseClick(meet, nameAt.x, nameAt.y);
  await waitFor(() => widgetCall(meet, ".rn input", "function(){ return true }"), "campo inline no widget");
  await widgetCall(meet, ".rn input", "function(){ this.select(); return true }");
  await typeText(meet, "Bruno Teste");
  await pressKey(meet, "Enter");
  await waitFor(async () => (await sw({ type: "get", id })).speakers[BRUNO] === "Bruno Teste", "nome alterado pelo widget");
  await waitFor(async () => /Bruno Teste/.test(await widgetCall(meet, "#body")), "widget redesenhado com o novo nome");
  step("nome do falante alterado ao vivo pelo widget");

  // Nome igual ao de outro participante: o widget pergunta antes de mesclar ("Manter separados" só renomeia)
  const nameAt2 = await rectOf(meet, `.blk .who b[data-speaker="${BRUNO}"]`);
  await mouseClick(meet, nameAt2.x, nameAt2.y);
  await waitFor(() => widgetCall(meet, ".rn input", "function(){ return true }"), "campo inline no widget (2)");
  await widgetCall(meet, ".rn input", "function(){ this.select(); return true }");
  await typeText(meet, "ana teste");
  await pressKey(meet, "Enter");
  await waitFor(() => widgetCall(meet, "[data-rn-merge]", "function(){ return true }"), "pergunta de mesclagem no widget");
  assert.match(await widgetCall(meet, ".rn"), /Mesclar Bruno Teste em Ana Teste\?/);
  await click(meet, "[data-rn-keep]");
  await waitFor(async () => (await sw({ type: "get", id })).speakers[BRUNO] === "ana teste", "manter separados só renomeia");
  await sw({ type: "update", id, speakers: { [BRUNO]: "Bruno Teste" } });
  step("widget pergunta antes de mesclar dois participantes com o mesmo nome");

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
  // Renomear no app (editor flutuante, sem prompt): volta "Bruno Teste" para "Bruno Lima"
  const whoAt = await evaluate(app, `(() => { const r = document.querySelector('#timeline .who b[data-speaker="${BRUNO}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`);
  await mouseClick(app, whoAt.x, whoAt.y);
  await waitFor(() => evaluate(app, "!!document.querySelector('.ask input')"), "editor flutuante no app");
  assert.equal(await evaluate(app, "document.activeElement === document.querySelector('.ask input')"), true, "campo do editor com foco");
  await typeText(app, "Bruno Lima");
  const okAt = await evaluate(app, `(() => { const r = document.querySelector('.ask [data-ok]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`);
  await mouseClick(app, okAt.x, okAt.y);
  await waitFor(async () => (await sw({ type: "get", id })).speakers[BRUNO] === "Bruno Lima", "nome alterado pelo app");
  await sleep(300);
  step("nome do falante alterado pelo editor do app");

  // Mesclagem pelo app: um terceiro falante sem nome vira "Ana Teste" → confirma → vira a Ana
  const TERCEIRO = "spaces/e2e/devices/10";
  await evaluate(meet, `__say(601, 1, "Eu concordo com a Ana sobre o orçamento.", ${JSON.stringify(TERCEIRO)})`);
  await waitFor(async () => (await sw({ type: "get", id })).entries.some((e) => e.speakerId === TERCEIRO), "fala do terceiro falante");
  await waitFor(() => evaluate(app, `!!document.querySelector('#timeline .who b[data-speaker="${TERCEIRO}"]')`), "app mostra o terceiro falante");
  const who9 = await evaluate(app, `(() => { const el = document.querySelector('#timeline .who b[data-speaker="${TERCEIRO}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: el.textContent } })()`);
  assert.ok(who9 && who9.name.startsWith("Participante"), "terceiro falante sem nome: " + JSON.stringify(who9));
  await mouseClick(app, who9.x, who9.y);
  await waitFor(() => evaluate(app, "document.activeElement === document.querySelector('.ask input')"), "editor para o terceiro falante");
  await typeText(app, "Ana Teste");
  await pressKey(app, "Enter");
  await waitFor(() => evaluate(app, "!!document.querySelector('.ask [data-choice=\"merge\"]')"), "pergunta de mesclagem no app");
  assert.match(await evaluate(app, "document.querySelector('.ask').innerText"), /Mesclar com Ana Teste\?/);
  const mergeAt = await evaluate(app, `(() => { const r = document.querySelector('.ask [data-choice="merge"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`);
  await mouseClick(app, mergeAt.x, mergeAt.y);
  const mergedS = await waitFor(async () => { const x = await sw({ type: "get", id }); return x.merged[TERCEIRO] === ANA ? x : null; }, "mesclagem salva");
  assert.ok(mergedS.entries.every((e) => e.speakerId !== TERCEIRO), "falas do terceiro passaram para a Ana");
  assert.ok(!(TERCEIRO in mergedS.speakers));
  await waitFor(() => evaluate(app, `!document.querySelector('#timeline .who b[data-speaker="${TERCEIRO}"]')`), "app sem o terceiro falante");
  // fala nova com o id antigo já cai na Ana
  await evaluate(meet, `__say(602, 1, "E fecho com isso.", ${JSON.stringify(TERCEIRO)})`);
  await waitFor(async () => (await sw({ type: "get", id })).entries.find((e) => e.id.includes("602"))?.speakerId === ANA, "fala nova do id mesclado vai para a Ana");
  step("app pergunta e mescla dois participantes; falas novas do id antigo seguem para o destino");
  const tl = await evaluate(app, "document.getElementById('timeline').innerText");
  assert.match(tl, /Ana Teste/);
  assert.match(tl, /Bruno Lima/);
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
  assert.match(await pane("ata"), /Nenhuma ata ainda/);
  step("app mostra transcrição, destaques, análise, IA e a aba Ata vazia");

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
    } else if (/Extraia o modelo/.test(JSON.stringify(body.messages))) text = "# Registro de Reunião {{numero_do_registro}}\n**Data:** {{data}}\n**Participantes:**\n{{participantes}}\n## Conclusão\n{{conclusao}}";
    else if (/<modelo>/.test(JSON.stringify(body.messages))) text = "# Registro de Reunião [preencher]\n**Data:** hoje\n**Participantes:**\n- Ana Teste\n- Bruno Lima\n## Conclusão\nAprovado o orçamento do Q4.";
    else if (/decidido/.test(JSON.stringify(body.messages))) text = "- Aprovado o orçamento do **Q4**.";
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
    await waitFor(async () => (await sw({ type: "get", id })).entries.length === 7, "nova fala");
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

    // Modelos de ata: importa de um "PDF" (API simulada), salva, escolhe para a reunião e gera a ata no formato
    const imported = await sw({ type: "ata-template-import", pdfBase64: Buffer.from("%PDF-1.4 teste").toString("base64") });
    assert.match(imported.text, /\{\{data\}\}/, "modelo extraído do PDF");
    assert.equal(apiCalls.at(-1).body.messages[0].content[0].type, "document", "o PDF vai como documento para a IA");
    const tpls = await sw({ type: "ata-template-save", name: "Registro (Atena)", text: imported.text });
    assert.equal(tpls.length, 1);
    await sw({ type: "update", id, ataTemplateId: tpls[0].id });
    await evaluate(app, "location.reload(); true");
    await sleep(1200);
    await evaluate(app, `document.querySelector('[data-tab="ata"]').click()`);
    await sleep(300);
    // instruções extras digitadas na aba Ata são salvas na reunião
    await evaluate(app, `(() => { const t = document.getElementById("ata-prompt"); t.value = "Conclusão em um parágrafo só."; t.dispatchEvent(new Event("blur")); })()`);
    await waitFor(async () => (await sw({ type: "get", id })).ataPrompt === "Conclusão em um parágrafo só.", "instruções salvas");
    assert.equal(await evaluate(app, "document.getElementById('ata-prompt-on').hidden"), false, "selo 'ativas'");
    // estrela torna o modelo escolhido o padrão dos Ajustes
    await evaluate(app, "document.getElementById('ata-default').click()");
    await waitFor(async () => (await evaluate(app, `(async () => (await chrome.storage.local.get("settings")).settings.ataTemplate)()`)) === tpls[0].id, "modelo padrão salvo");
    await waitFor(async () => (await evaluate(app, "document.getElementById('ata-default').getAttribute('aria-pressed')")) === "true", "estrela marcada");
    await evaluate(app, "location.reload(); true");
    await sleep(1200);
    await evaluate(app, `document.querySelector('[data-tab="ata"]').click()`);
    await sleep(300);
    assert.match(await evaluate(app, "document.getElementById('ata-template').selectedOptions[0].textContent"), /Padrão: Registro \(Atena\)/, "seletor mostra o modelo padrão");
    await evaluate(app, "document.getElementById('ata-gen').click()");
    await waitFor(async () => /Registro de Reunião/.test((await sw({ type: "get", id })).summary?.text || ""), "ata no formato do modelo");
    assert.match(JSON.stringify(apiCalls.at(-1).body.messages), /<modelo>[\s\S]*Registro de Reunião[\s\S]*<\/modelo>/, "o modelo foi para a IA");
    assert.match(JSON.stringify(apiCalls.at(-1).body.system), /<instrucoes>\\nConclusão em um parágrafo só\.\\n<\/instrucoes>/, "as instruções extras foram para a IA");
    assert.match((await sw({ type: "get", id })).summaryHistory.at(-1).label, /com instruções extras/);
    await sleep(400);
    assert.equal(await evaluate(app, "document.getElementById('ata-dl').hidden"), false, "botão Baixar visível com ata");
    assert.deepEqual(await evaluate(app, "[...document.querySelectorAll('#ata-dl-menu [data-ata]')].map(b => b.dataset.ata)"), ["txt", "md", "html", "pdf"]);
    assert.deepEqual(await evaluate(app, "[...document.querySelectorAll('#ata-copy-menu [data-copy]')].map(b => b.dataset.copy)"), ["rich", "editor", "html", "plain"]);
    step("modelo de ata importado de PDF, escolhido na reunião e usado na geração; download em txt/md/pdf");

    // Versões da ata: a geração virou v1; uma edição à mão vira v2; o comparador mostra o diff; restaurar vira v3
    let sv = await sw({ type: "get", id });
    assert.equal(sv.summaryHistory.length, 1, "a geração vira a primeira versão");
    assert.match(sv.summaryHistory[0].label, /Gerada pela IA · modelo Registro/);
    sv = await sw({ type: "ata-save", id, text: sv.summary.text.replace("Aprovado o orçamento do Q4.", "Aprovado o orçamento do Q4 e o cronograma."), label: "acrescentei o cronograma" });
    assert.equal(sv.summaryHistory.length, 2);
    assert.equal(sv.summaryHistory[1].source, "edit");
    await evaluate(app, "location.reload(); true");
    await sleep(1200);
    await evaluate(app, `document.querySelector('[data-tab="ata"]').click()`);
    await sleep(300);
    assert.equal(await evaluate(app, "document.getElementById('ata-versions-label').textContent"), "Versões (2)");
    assert.match(await evaluate(app, "document.getElementById('ata-meta').innerText"), /v2[\s\S]*Editada à mão/, "faixa da ata mostra a versão atual");
    assert.equal(await evaluate(app, "document.getElementById('c-ata').textContent"), "v2", "aba Ata mostra a versão");
    await evaluate(app, "document.getElementById('ata-versions-btn').click()");
    await sleep(200);
    assert.match(await evaluate(app, "document.getElementById('diff-stats').innerText"), /v1 → v2: \+3 palavras adicionadas, −0 removidas/);
    assert.match(await evaluate(app, "document.getElementById('diff-view').innerHTML"), /<ins>[^<]*cronograma/);
    assert.equal(await evaluate(app, "document.querySelectorAll('#versions-list .ver').length"), 2);
    // "Ver" uma versão antiga mostra o texto dela no documento, com faixa e botão de voltar
    await evaluate(app, "document.querySelector('#versions-list .ver:not(.current) [data-vact=view]').click()");
    await sleep(200);
    assert.match(await evaluate(app, "document.getElementById('ata-viewing').innerText"), /Você está vendo a v1/);
    assert.doesNotMatch(await evaluate(app, "document.getElementById('ata-body').innerText"), /cronograma/);
    await screenshot(app, "11-ata-versoes.png");
    await evaluate(app, "document.getElementById('ata-back').click()");
    await sleep(200);
    assert.equal(await evaluate(app, "document.getElementById('ata-viewing').hidden"), true);
    assert.match(await evaluate(app, "document.getElementById('ata-body').innerText"), /cronograma/);
    // restaurar v1 pelo serviço (o botão abre uma confirmação)
    sv = await sw({ type: "ata-restore", id, versionId: sv.summaryHistory[0].id });
    assert.equal(sv.summaryHistory.length, 3);
    assert.equal(sv.summaryHistory[2].label, "Restaurada da v1");
    assert.equal(sv.summary.text, sv.summaryHistory[0].text);
    step("versões da ata: geração, edição à mão, comparador com diff e restauração");
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

  // Falante sem nome no protocolo: o nome vem da legenda na tela, casada pelo texto
  const CARLA = "spaces/e2e/devices/9";
  await evaluate(meet, `(() => {
    const region = document.querySelector('[role="region"][aria-label="Legendas"]');
    const block = document.createElement("div");
    block.innerHTML = "<div>Carla Dias</div><div>vou mandar o relatório final amanhã cedo</div>";
    region.append(block);
    __say(701, 1, "vou mandar o relatório final amanhã cedo", ${JSON.stringify(CARLA)});
  })()`);
  await waitFor(async () => (await sw({ type: "get", id })).speakers[CARLA] === "Carla Dias", "nome da Carla pela tela", 8000);
  step("falante sem nome no protocolo recebe o nome da legenda na tela");

  // Legenda em idioma errado
  const meet3 = await openMeet("lng-test-abc", "Reunião em inglês");
  await evaluate(meet3, `(async () => { for (let i = 0; i < 4; i++) { __caps.send(window.EscribanoteProto.encode([[1, "message", [[1, "varint", 900 + i], [2, "varint", 1], [3, "message", [[3, "string", "we should close this today " + i], [4, "string", "en-US"], [6, "string", ${JSON.stringify(ANA)}]]]]]])); await new Promise((r) => setTimeout(r, 150)); } })()`);
  await waitFor(async () => /legendas estão em inglês/.test((await widgetCall(meet3, "#body")) || ""), "aviso de idioma");
  await screenshot(meet3, "11-aviso-idioma.png");
  step("widget avisa quando as legendas estão no idioma errado");

  // Backup automático: a reunião está na área interna; no modo Downloads, o arquivo é gravado sem diálogo
  {
    const r = await sw({ type: "auto-backup-flush", all: true });
    assert.equal(r.error, null, "backup interno sem erro");
    const rest = await sw({ type: "auto-backup-restore" });
    assert.ok(rest.total >= 1, "a área interna tem a reunião");
    await evaluate(app, `(async () => { const { settings } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, backupAuto: "downloads", _at: Date.now() } }); })()`);
    const d = await sw({ type: "auto-backup-flush", all: true });
    assert.equal(d.mode, "downloads");
    assert.equal(d.error, null, "download sem erro: " + d.error);
    assert.ok(d.at, "backup em Downloads feito");
    step("backup automático: área interna e pasta Downloads, sem escolher pasta");
  }

  // 9) Layout estreito (largura do painel lateral) e Ajustes
  await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 820, deviceScaleFactor: 1, mobile: false }, app);
  await send("Page.navigate", { url: `chrome-extension://${extId}/src/app/app.html?id=${id}` }, app);
  await sleep(1200);
  assert.ok(await evaluate(app, "!document.body.classList.contains('wide')"));
  await screenshot(app, "8-painel-estreito.png");
  await evaluate(app, `document.querySelector('[data-nav="settings"]').click()`);
  await sleep(600);
  assert.match(await evaluate(app, "document.getElementById('view-settings').innerText"), /Tags de destaque[\s\S]*Inteligência artificial/);
  assert.match(await evaluate(app, "document.getElementById('bk-auto-status').innerText"), /Ligado em Downloads/);
  await screenshot(app, "9-ajustes.png");
  step("layout de painel lateral e Ajustes");

  // 10) Sair da chamada: o Meet fecha as conexões WebRTC e tira o botão de sair; a página continua.
  //     A sessão termina sozinha em poucos segundos, a última fala (cortada pelo protocolo) é
  //     completada pela legenda que ainda estava na tela, o selo REC some e, com o ajuste
  //     "Ao sair da reunião: abrir no Escribanote", a tela pós-reunião abre numa aba.
  await evaluate(app, `(async () => { const { settings = {} } = await chrome.storage.local.get("settings"); await chrome.storage.local.set({ settings: { ...settings, afterCall: "app" } }); })()`);
  assert.equal(await evaluate(app, `chrome.action.getBadgeText({ tabId: ${meetTabId} })`), "REC", "selo REC durante a reunião");
  await evaluate(meet, `(() => {
    __say(777, 1, "então ficamos combinados assim e a gente se fala", ${JSON.stringify(ANA)});
    const region = document.querySelector('[role="region"][aria-label="Legendas"]');
    region.innerHTML = '<div><div>Ana Teste</div><div>então ficamos combinados assim e a gente se fala na próxima semana, obrigada</div></div>';
  })()`);
  await waitFor(async () => (await sw({ type: "get", id })).entries.some((e) => e.id === "777/" + ANA), "última fala pelo protocolo");
  await sleep(1800); // um tique do leitor de tela, para a legenda inteira ser vista
  const t0 = Date.now();
  await evaluate(meet, `(() => { document.querySelector('button[aria-label="Sair da chamada"]').remove(); for (const pc of __pcs) pc.close(); })()`);
  await waitFor(async () => !!(await sw({ type: "get", id })).endedAt, "sessão encerrada ao sair da chamada", 15_000);
  const leaveMs = Date.now() - t0;
  assert.ok(leaveMs < 12_000, "encerrou rápido após fechar as conexões: " + leaveMs + " ms");
  const sEnd = await sw({ type: "get", id });
  assert.equal(sEnd.entries.find((e) => e.id === "777/" + ANA).text, "então ficamos combinados assim e a gente se fala na próxima semana, obrigada", "última fala completada pela tela");
  await waitFor(async () => (await evaluate(app, `chrome.action.getBadgeText({ tabId: ${meetTabId} })`)) === "", "selo REC apagado");
  await waitFor(async () => /Transcrição encerrada/.test((await widgetCall(meet, "#body")) || ""), "widget mostra encerrada ao sair");
  step(`sair da chamada encerra a sessão em ${(leaveMs / 1000).toFixed(1)} s, completa a última fala e apaga o selo REC`);
  // A aba criada por chrome.tabs.create não aparece no Target.getTargets do Chrome headless;
  // confere pela API de abas e, para o aviso, abre a mesma URL no alvo do app.
  const afterTab = await waitFor(async () => {
    const { afterCallDiag: d } = await evaluate(app, `chrome.storage.local.get("afterCallDiag")`);
    if (!d || d.id !== id || d.tabId == null) return null;
    // sem a permissão "tabs" a URL não vem no objeto da aba: basta a aba existir; a URL está no registro
    return evaluate(app, `chrome.tabs.get(${d.tabId}).then(() => ${JSON.stringify(d.url)}, () => null)`);
  }, "aba pós-reunião", 15_000).catch(async (err) => {
    console.log("afterCallDiag:", JSON.stringify(await evaluate(app, `chrome.storage.local.get("afterCallDiag")`)));
    console.log("abas:", JSON.stringify(await evaluate(app, `chrome.tabs.query({}).then((ts) => ts.map((t) => [t.id, t.windowId, t.url || t.pendingUrl]))`)));
    console.log("janelas:", JSON.stringify(await evaluate(app, `chrome.windows.getAll().then((ws) => ws.map((w) => [w.id, w.type, w.state]))`)));
    throw err;
  });
  assert.ok(afterTab.includes(`app.html?id=${id}&fim=1`), "aba pós-reunião com a URL da reunião: " + afterTab);
  await send("Page.navigate", { url: afterTab }, app);
  await sleep(1500);
  assert.match(await evaluate(app, "document.getElementById('t-banner').innerText"), /A chamada terminou/);
  await screenshot(app, "12-pos-reuniao.png");
  step("tela pós-reunião abre sozinha com o aviso de encerramento");

  // 11) Botão "Encerrar transcrição" do widget: fecha a sessão na hora e para de captar
  const meet4 = await openMeet("end-test-xyz", "Encerrar pelo widget");
  await evaluate(meet4, `(() => { __device(${JSON.stringify(ANA)}, "Ana Teste"); __say(801, 1, "vamos encerrar por aqui, obrigada a todos", ${JSON.stringify(ANA)}); })()`);
  const id4 = (await waitFor(async () => (await sw({ type: "list" })).find((m) => m.meetingKey === "meet:end-test-xyz" && m.count === 1), "sessão 4")).id;
  await waitFor(() => widgetCall(meet4, "#end", "function(){ return !this.disabled }"), "botão encerrar");
  await click(meet4, "#end");
  await waitFor(async () => !!(await sw({ type: "get", id: id4 })).endedAt, "sessão 4 encerrada pelo widget", 8000);
  await waitFor(async () => /Transcrição encerrada/.test((await widgetCall(meet4, "#body")) || ""), "widget mostra encerrada");
  await evaluate(meet4, `__say(802, 1, "isto não deve entrar", ${JSON.stringify(ANA)})`);
  await sleep(2500);
  const s4 = await sw({ type: "get", id: id4 });
  assert.equal(s4.entries.length, 1, "nada entra depois de encerrar");
  assert.ok(s4.endedAt, "continua encerrada");
  step("botão Encerrar do widget fecha a sessão e ignora o que vem depois");

  // 12) Legendas que não ligam: o Escribanote clica em "Ativar legendas" sozinho (sem depender do botão
  //     de sair); se mesmo assim nada vem, o widget pede para ligar à mão. Depois, a tela
  //     "Você saiu da chamada" encerra a sessão na hora.
  const meet5 = await openMeet("ccx-stuk-xyz", "Legendas travadas", `<button aria-label="Ativar legendas" onclick="window.__cc=(window.__cc||0)+1">cc</button>`);
  await waitFor(() => evaluate(meet5, "(window.__cc || 0) >= 1"), "clique automático em Ativar legendas", 8000);
  await waitFor(async () => /Legendas desligadas/.test((await widgetCall(meet5, "#body")) || ""), "widget pede para ligar as legendas à mão", 20_000);
  assert.ok((await evaluate(meet5, "window.__cc")) <= 3, "no máximo 3 cliques automáticos");
  step("legendas ligadas sozinhas sem depender do botão de sair; aviso quando não ligam");
  await evaluate(meet5, `(() => { __device(${JSON.stringify(ANA)}, "Ana Teste"); __say(901, 1, "agora sim, as legendas ligaram", ${JSON.stringify(ANA)}); })()`);
  const id5 = (await waitFor(async () => (await sw({ type: "list" })).find((m) => m.meetingKey === "meet:ccx-stuk-xyz" && m.count === 1), "sessão 5", 12_000).catch(async (err) => {
    console.log("lista:", JSON.stringify((await sw({ type: "list" })).map((m) => [m.meetingKey, m.count, m.endedAt])));
    console.log("página:", await evaluate(meet5, "JSON.stringify({ cc: window.__cc, caps: __caps.readyState, pcs: __pcs.map((p) => p.connectionState), url: location.href })"));
    throw err;
  })).id;
  const t5 = Date.now();
  await evaluate(meet5, `(() => { document.body.innerHTML = '<div>Você saiu da chamada</div><button>Voltar a participar</button><button>Voltar à tela inicial</button>'; for (const pc of __pcs) pc.close(); })()`);
  await waitFor(async () => !!(await sw({ type: "get", id: id5 })).endedAt, "sessão 5 encerrada pela tela pós-chamada", 8000);
  step(`tela "Você saiu da chamada" encerra a sessão em ${((Date.now() - t5) / 1000).toFixed(1)} s`);

  console.log("\nE2E OK");
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(EXT, { recursive: true, force: true });
}
