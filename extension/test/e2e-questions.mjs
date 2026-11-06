// Modelos de perguntas da aba IA: alfinete, novo modelo (rascunho), ordem, apagar com desfazer
// e limpeza dos "Nova pergunta" que versões antigas salvavam.
//   CHROME=... node test/e2e-questions.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "escribanote-questions-"));
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
async function waitFor(fn, what, ms = 8000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("tempo esgotado: " + what); await sleep(100); } }

const t0 = Date.now() - 3600_000;
const sample = { id: "teste-q-1", title: "Reunião de teste das perguntas", platform: "meet", meetingKey: "meet:abc-defg-hij", startedAt: t0, updatedAt: t0 + 60_000, endedAt: t0 + 60_000,
  speakers: { a: "Ana" }, entries: [{ id: "1", at: t0 + 1000, speakerId: "a", text: "Bom dia, vamos começar.", kind: "caption", source: "protocol" }], asr: [], notes: { text: "", items: [] }, highlights: {},
  chats: [{ id: "c1", messages: [{ role: "user", text: "# Roteiro de análise\n" + "Detalhe cada operação com horário, entrada, alvo e stop. ".repeat(160), at: t0 }, { role: "assistant", text: "Resposta.", at: t0 }] }] };
const ROTEIRO = "# Análise detalhada do pregão\n" + "Para cada operação, detalhe horário, direção, gatilho, alvo, stop e resultado. ".repeat(115).trim(); // ~9 mil caracteres

try {
  let extId;
  for (let i = 0; i < 100 && !extId; i++) { const { targetInfos } = await send("Target.getTargets"); const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js")); if (sw) extId = new URL(sw.url).host; else await sleep(200); }
  const boot = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const b = await send("Target.attachToTarget", { targetId: boot.targetId, flatten: true });
  const evIn = (sid) => (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
  await sleep(800);
  // Configuração como a do bug: dois "Nova pergunta" salvos pela versão antiga do "+ Novo modelo".
  await evIn(b.sessionId)(`(async () => {
    await chrome.runtime.sendMessage({ type: "import", sessions: [${JSON.stringify(sample)}] });
    const { settings = {} } = await chrome.storage.local.get("settings");
    const questions = [
      { id: "pontos", label: "Pontos principais", text: "Quais são os pontos principais?", auto: false },
      { id: "acoes", label: "Itens de ação", text: "Liste os itens de ação.", auto: false },
      { id: "x1", label: "Nova pergunta", text: "Escreva aqui a pergunta", auto: false },
      { id: "x2", label: "Nova pergunta", text: "Escreva aqui a pergunta", auto: false },
    ];
    await chrome.storage.local.set({ welcomeDone: Date.now(), settings: { ...settings, questions } });
  })()`);
  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1&id=${sample.id}` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = evIn(sessionId);
  await waitFor(() => ev("!!document.querySelector('[data-tab=\"ai\"]') && document.querySelector('#m-title')?.value === " + JSON.stringify(sample.title)), "reunião aberta");
  await ev("document.querySelector('[data-tab=\"ai\"]').click(); document.querySelector('#q-manage').open = true");
  await waitFor(() => ev("document.querySelectorAll('#q-list .q-row').length === 2"), "lista sem os 'Nova pergunta'");
  const chips = () => ev("[...document.querySelectorAll('#quick .chip')].map((c) => c.textContent.trim())");
  assert.deepEqual(await chips(), ["Pontos principais", "Itens de ação"]);
  console.log("✓ 'Nova pergunta' antigos somem da lista e dos atalhos");

  // Alfinete: clicar (o foco fica no botão) muda o estado na hora e tira dos atalhos.
  const pinOn = () => ev("document.querySelector('[data-act=\"pin\"][data-id=\"pontos\"]').classList.contains('on')");
  assert.equal(await pinOn(), true);
  await ev("(() => { const b = document.querySelector('[data-act=\"pin\"][data-id=\"pontos\"]'); b.focus(); b.click(); })()");
  assert.equal(await pinOn(), false, "o alfinete muda na hora");
  await waitFor(async () => !(await chips()).includes("Pontos principais"), "atalho some ao desafixar");
  assert.equal(await pinOn(), false, "continua desafixado depois de redesenhar");
  assert.equal(await ev("document.activeElement?.dataset.act === 'pin'"), true, "foco volta ao alfinete");
  await ev("document.querySelector('[data-act=\"pin\"][data-id=\"pontos\"]').click()");
  await waitFor(async () => (await chips()).includes("Pontos principais") && (await pinOn()), "fixar de novo");
  console.log("✓ alfinete fixa e desafixa, com o atalho acompanhando");

  // Novo modelo: rascunho no topo, nada salvo nem nos atalhos até ter nome e pergunta.
  await ev("document.querySelector('#q-add').click()");
  assert.equal(await ev("!!document.querySelector('#q-list [data-draft]') && document.activeElement?.dataset.k === 'label'"), true, "rascunho aberto com foco no nome");
  assert.equal(await ev("document.querySelector('#q-add').disabled"), true);
  assert.equal((await chips()).length, 2, "rascunho não vira atalho");
  await ev("document.querySelector('[data-draft-save]').click()");
  assert.equal(await ev("!!document.querySelector('#q-list [data-draft]')"), true, "sem nome não salva");
  await ev(`(() => { const set = (k, v) => { const el = document.querySelector('[data-draft] [data-k="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('label', 'Riscos'); set('text', 'Quais riscos foram levantados?'); document.querySelector('[data-draft-save]').click(); })()`);
  await waitFor(async () => (await chips())[0] === "Riscos", "novo modelo salvo e fixado no topo");
  assert.equal(await ev("document.querySelectorAll('#q-list .q-row').length"), 3);
  console.log("✓ novo modelo: rascunho, validação e atalho");

  // Ordem
  await ev("document.querySelector('[data-act=\"down\"][data-id]').click()");
  await waitFor(async () => (await chips())[1] === "Riscos", "descer o modelo");
  console.log("✓ subir/descer reordena os atalhos");

  // Editar o nome e logo clicar no alfinete não desfaz a edição.
  await ev(`(() => { const el = document.querySelector('.q-row[data-id="acoes"] [data-k="label"]'); el.focus(); el.value = 'Próximos passos'; el.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-act="pin"][data-id="acoes"]').click(); })()`);
  await waitFor(() => ev("(async () => { const { settings } = await chrome.storage.local.get('settings'); const q = settings.questions.find((x) => x.id === 'acoes'); return q.label === 'Próximos passos' && q.pinned === false; })()"), "edição + alfinete salvos juntos");
  console.log("✓ edição seguida de alfinete não se perde");

  // Apagar com desfazer
  await ev("(() => { const b = document.querySelector('[data-act=\"rm\"][data-id=\"pontos\"]'); b.focus(); b.click(); })()");
  await waitFor(() => ev("!document.querySelector('.q-row[data-id=\"pontos\"]') && !!document.querySelector('#toast button')"), "apagado com Desfazer");
  await ev("document.querySelector('#toast button').click()");
  await waitFor(() => ev("!!document.querySelector('.q-row[data-id=\"pontos\"]')"), "desfazer restaura");
  console.log("✓ apagar e desfazer");
  // Contagem de caracteres: fixa nos modelos, flutuante no título da reunião.
  assert.equal(await ev("document.querySelector('.q-row[data-id=\"pontos\"] [data-k=\"label\"] + .count').textContent"), "17/60");
  await ev(`(() => { const el = document.querySelector('.q-row[data-id="pontos"] [data-k="text"]'); el.focus(); el.value = 'x'.repeat(10000); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.deepEqual(await ev("(() => { const c = document.querySelector('.q-row[data-id=\"pontos\"] [data-k=\"text\"] + .count'); return [c.textContent, c.classList.contains('full')]; })()"), ["10.000/10.000", true]);
  await ev(`(() => { const el = document.querySelector('.q-row[data-id="pontos"] [data-k="text"]'); el.value = 'Quais são os pontos principais?'; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()`);
  await ev("document.querySelector('#m-title').focus()");
  assert.deepEqual(await ev("(() => { const f = document.querySelector('#count-float'); return [f.hidden, f.textContent]; })()"), [false, `${sample.title.length}/200`]);
  await ev("document.querySelector('#m-title').blur()");
  assert.equal(await ev("document.querySelector('#count-float').hidden"), true);
  console.log("✓ contagem de caracteres nos modelos e no título");

  // Pergunta longa (até 10 mil): modelo novo com um roteiro de ~9 mil caracteres.
  assert.ok(ROTEIRO.length > 8500 && ROTEIRO.length < 10000);
  await ev("document.querySelector('#q-add').click()");
  await ev(`(() => { const set = (k, v) => { const el = document.querySelector('[data-draft] [data-k="' + k + '"]'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('label', 'Análise do pregão'); set('text', ${JSON.stringify(ROTEIRO)}); })()`);
  assert.equal(await ev("document.querySelector('[data-draft] [data-k=\"text\"] + .count').textContent"), `${ROTEIRO.length.toLocaleString("pt-BR")}/10.000`);
  await ev("document.querySelector('[data-draft-save]').click()");
  await waitFor(() => ev(`(async () => { const { settings } = await chrome.storage.local.get('settings'); return settings.questions.some((q) => q.label === 'Análise do pregão' && q.text === ${JSON.stringify(ROTEIRO)}); })()`), "roteiro salvo inteiro").catch(async (err) => {
    console.log("diag:", JSON.stringify(await ev(`(async () => { const { settings } = await chrome.storage.local.get('settings'); return { toast: document.querySelector('#toast').textContent, draft: !!document.querySelector('[data-draft]'), qs: settings.questions.map((q) => [q.label, q.text.length]) }; })()`)));
    throw err;
  });
  assert.equal(await ev("document.querySelector('#chat-input').maxLength"), 10000);
  console.log("✓ pergunta de", ROTEIRO.length, "caracteres salva inteira (limite 10.000)");

  // Contagem nos campos sem limite e na caixa de pergunta.
  await ev("(() => { const el = document.querySelector('#chat-input'); el.focus(); el.value = 'abc'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
  assert.equal(await ev("document.querySelector('#count-float').textContent"), "3/10.000");
  await ev("document.querySelector('#chat-input').value = ''; document.querySelector('#chat-input').blur()");
  console.log("✓ contagem na caixa de pergunta");

  // Pergunta longa aparece recolhida na conversa.
  await ev("(() => { const s = document.querySelector('#chat-select'); s.value = 'c1'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
  await waitFor(() => ev("!!document.querySelector('#chat-log .long-q')"), "pergunta longa recolhida");
  assert.match(await ev("document.querySelector('#chat-log .long-q summary').textContent"), /ver a pergunta inteira \(9\.\d{3} caracteres\)/);
  console.log("✓ pergunta longa recolhida na conversa");

  // Copiar a resposta, a pergunta com a resposta, e exportar com as perguntas à IA.
  await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: `chrome-extension://${extId}` });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  const clip = () => ev("navigator.clipboard.readText()");
  await ev("document.querySelector('#chat-log [data-copy=\"a\"]').click()");
  await waitFor(async () => (await clip()) === "Resposta.", "resposta copiada");
  await ev("document.querySelector('#chat-log [data-copy=\"qa\"]').click()");
  await waitFor(async () => /^Pergunta: # Roteiro de análise[\s\S]*\n\nResposta:\nResposta\.$/.test(await clip()), "pergunta e resposta copiadas");
  console.log("✓ copiar resposta e copiar com a pergunta");

  await ev("document.querySelector('[data-tab=\"transcript\"]')?.click(); document.querySelector('#m-export').click()");
  const incs = await ev("[...document.querySelectorAll('#export-menu [data-inc]')].map((i) => [i.dataset.inc, i.checked])");
  assert.deepEqual(incs, [["chat", true], ["notes", true], ["highlights", true], ["chapters", true], ["ai", false]]);
  await ev("document.querySelector('#export-menu [data-inc=\"ai\"]').click()");
  await waitFor(() => ev("(async () => (await chrome.storage.local.get('settings')).settings.exportInclude?.ai === true)()"), "escolha lembrada");
  assert.equal(await ev("document.querySelector('#export-menu').hidden"), false, "marcar não fecha o menu");
  if (process.env.SHOT_MENU) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await ev("document.documentElement.dataset.theme = 'dark'; window.scrollTo(0, 0); document.querySelector('.main, main')?.scrollTo?.(0, 0)");
    await sleep(300);
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    (await import("node:fs")).writeFileSync(process.env.SHOT_MENU, Buffer.from(data, "base64"));
  }
  await ev("document.querySelector('#export-menu [data-exp=\"plain\"]').click()");
  await waitFor(async () => /=== Perguntas à IA ===\n\nPergunta: # Roteiro de análise/.test(await clip()), "exportação com as perguntas à IA");
  console.log("✓ exportar com as perguntas e respostas da IA (escolha lembrada)");

  if (process.env.SHOT) {
    // Captura da seção para conferência visual: um modelo desafixado e o rascunho aberto.
    await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId);
    await ev("document.documentElement.dataset.theme = 'dark'; document.querySelector('#q-add').click()");
    await ev(`(() => { const el = document.querySelector('[data-draft] [data-k="label"]'); el.value = 'Um nome de modelo bem comprido para ver a contagem ficar laranja'.slice(0, 56); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(500);
    await ev("document.querySelector('[data-tab=\"ai\"]').click(); document.querySelector('#chat-select').value = 'c1'; document.querySelector('#chat-select').dispatchEvent(new Event('change', { bubbles: true }))");
    await sleep(300);
    await ev("document.querySelector('.chat').scrollIntoView()");
    await sleep(300);
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    (await import("node:fs")).writeFileSync(process.env.SHOT, Buffer.from(data, "base64"));
  }
  console.log("OK");
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
