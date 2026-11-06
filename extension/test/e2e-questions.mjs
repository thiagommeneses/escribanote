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
  shots: [{ id: "s1", at: t0 + 30_000 }],
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
    await chrome.storage.local.set({ "shot:teste-q-1:s1": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==" });
    await chrome.runtime.sendMessage({ type: "import", sessions: [${JSON.stringify(sample)}, ${JSON.stringify({ ...sample, id: "teste-q-live", title: "Reunião ao vivo", endedAt: null, chats: [], shots: [] })}] });
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

  // Material de apoio: arquivo de texto, PDF e imagem pelo botão; texto colado; remover.
  await ev("document.querySelector('[data-tab=\"ai\"]').click()");
  await ev(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hora,WIN\\n09:00,130000"], "cotacoes.csv", { type: "text/csv" }));
    dt.items.add(new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], "noticias.pdf", { type: "application/pdf" }));
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "grafico.png", { type: "image/png" }));
    const input = document.querySelector('#support-input'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => ev("document.querySelectorAll('#support-list .support-item').length === 3"), "três anexos");
  await ev("document.querySelector('#support-paste').click()");
  await waitFor(() => ev("!!document.querySelector('.ask textarea')"), "caixa de colar");
  await ev("(() => { const ta = document.querySelector('.ask textarea'); ta.value = 'Calendário: IPCA às 9h\\nPayroll às 10h30'; ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); })()");
  await waitFor(() => ev("document.querySelectorAll('#support-list .support-item').length === 4"), "texto colado anexado");
  const sup = await ev(`(async () => { const s = await chrome.runtime.sendMessage({ type: "get", id: "${sample.id}" }); return s.support.map((x) => [x.kind, x.name]); })()`);
  assert.deepEqual(sup, [["text", "cotacoes.csv"], ["pdf", "noticias.pdf"], ["image", "grafico.png"], ["text", "Calendário: IPCA às 9h"]]);
  const csv = await ev(`(async () => { const s = await chrome.runtime.sendMessage({ type: "get", id: "${sample.id}" }); return (await chrome.runtime.sendMessage({ type: "support-get", id: s.id, supportId: s.support[0].id })).data; })()`);
  assert.equal(csv, "hora,WIN\n09:00,130000");
  assert.match(await ev("document.querySelector('#support-count').textContent"), /^4 · vai junto/);
  await ev("document.querySelector('#support-list [data-support-rm]').click()");
  await waitFor(() => ev("document.querySelectorAll('#support-list .support-item').length === 3"), "remover anexo");
  console.log("✓ material de apoio: arquivo, PDF, imagem, texto colado e remover");

  // Opções da reunião (capturas para a IA e pesquisa na web), captura automática e glossário de mercado.
  const jpeg = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
  assert.equal(await ev(`chrome.runtime.sendMessage({ type: "auto-shot", id: "${sample.id}", dataUrl: "${jpeg}" })`), null, "reunião encerrada não recebe captura automática");
  assert.ok(await ev(`chrome.runtime.sendMessage({ type: "auto-shot", id: "teste-q-live", dataUrl: "${jpeg}" })`), "reunião em andamento recebe");
  assert.equal(await ev(`(async () => (await chrome.runtime.sendMessage({ type: "get", id: "teste-q-live" })).shots.filter((x) => x.auto).length)()`), 1);
  assert.equal(await ev("document.querySelector('#opt-shots').disabled"), true, "reunião sem capturas: opção desligada");
  await ev("document.querySelector('#opt-web').click()");
  await waitFor(() => ev(`(async () => (await chrome.runtime.sendMessage({ type: "get", id: "${sample.id}" })).aiOptions.web === true)()`), "pesquisa na web salva na reunião");
  // Na reunião em andamento, que tem a captura automática:
  await ev(`location.search = "?tab=1&id=teste-q-live"`);
  await sleep(1200);
  await waitFor(() => ev("document.querySelector('#m-title')?.value === 'Reunião ao vivo'"), "reunião ao vivo aberta");
  await ev("document.querySelector('[data-tab=\"ai\"]').click()");
  await waitFor(() => ev("!document.querySelector('#opt-shots').disabled && document.querySelector('#opt-shots-n').textContent === '(1)'"), "opção de capturas liberada, com 1 captura");
  await ev("document.querySelector('#opt-shots').click()");
  await waitFor(() => ev(`(async () => (await chrome.runtime.sendMessage({ type: "get", id: "teste-q-live" })).aiOptions.shots === true)()`), "capturas ligadas na reunião");
  await ev(`location.search = "?tab=1&id=${sample.id}"`);
  await sleep(1200);
  await waitFor(() => ev("document.querySelector('#m-title')?.value === " + JSON.stringify(sample.title)), "volta à reunião");
  console.log("✓ captura automática guardada; capturas e pesquisa na web ligadas para a reunião");

  await ev("document.querySelector('[data-view=\"settings\"], #nav-settings, [data-goto-view=\"settings\"]')?.click()");
  await ev("document.querySelector('#gloss-market').click()");
  await waitFor(() => ev("(async () => /\\bBOVA11\\b/.test((await chrome.storage.local.get('settings')).settings.glossary || ''))()"), "termos do mercado no vocabulário");
  await ev("document.querySelector('#gloss-market').click()");
  await waitFor(() => ev("document.querySelector('#toast').textContent.includes('já estão')"), "não duplica os termos");
  console.log("✓ termos do mercado financeiro no vocabulário, sem duplicar");
  await ev("document.querySelector('[data-goto-view=\"meeting\"], #nav-meeting, [data-view=\"meeting\"]')?.click()");

  // Geração da ata: cartão de espera (etapa, tempo, palavras) no lugar do texto ao vivo; prévia só quando pedida.
  {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    const { sessionId: swSid } = await send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    await evIn(swSid)(`(() => {
      globalThis.__realFetch ||= globalThis.fetch;
      chrome.permissions.contains = async () => true;
      globalThis.fetch = async (url, init) => {
        if (!String(url).startsWith("https://api.anthropic.com/")) return globalThis.__realFetch(url, init);
        const ev = (e) => "data: " + JSON.stringify(e) + "\\n\\n";
        const parts = ["# Ata\\n\\n", "Decisões da reunião ", "sobre o pregão. ", "Próximos passos definidos."];
        const enc = new TextEncoder();
        return new Response(new ReadableStream({ async start(c) {
          await new Promise((r) => setTimeout(r, 1200));
          c.enqueue(enc.encode(ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })));
          for (const t of parts) { c.enqueue(enc.encode(ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }))); await new Promise((r) => setTimeout(r, 900)); }
          c.enqueue(enc.encode(ev({ type: "message_delta", delta: { stop_reason: "end_turn" } })));
          c.close();
        } }), { status: 200 });
      };
    })()`);
    await ev(`(async () => { await chrome.storage.local.set({ apiKey: "sk-ant-teste" }); chrome.permissions.contains = async () => true; })()`);
    await ev("document.querySelector('[data-tab=\"ata\"]').click()");
    await waitFor(() => ev("!!document.querySelector('#ata-gen') && !document.querySelector('#ata-gen').disabled"), "botão da ata");
    await ev("document.querySelector('#ata-gen').click()");
    await waitFor(() => ev("document.querySelector('#ata-body .wait .wait-label')?.textContent === 'Lendo a transcrição…'"), "cartão de espera");
    assert.equal(await ev("document.querySelector('#ata-body .wait-prev').hidden"), true, "sem prévia antes do texto");
    assert.equal(await ev("document.querySelector('#ata-gen').textContent"), "Cancelar");
    await waitFor(() => ev("document.querySelector('#ata-body .wait-label')?.textContent === 'Escrevendo a ata…'"), "etapa de escrita");
    assert.equal(await ev("document.querySelector('#ata-body .wait-prev').hidden || document.querySelector('#ata-body .wait-prev').open"), false, "prévia disponível, fechada");
    assert.equal(await ev("document.querySelector('#ata-body .wait-text').textContent"), "", "texto parcial não aparece sem pedir");
    assert.match(await ev("document.querySelector('#ata-body .wait-words').textContent"), /palavra/);
    await ev("document.querySelector('#ata-body .wait-prev summary').click()");
    await waitFor(() => ev("document.querySelector('#ata-body .wait-text')?.textContent.includes('Decisões')"), "prévia mostra o texto parcial");
    if (process.env.SHOT_ATA) {
      await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
      await ev("document.documentElement.dataset.theme = 'dark'; document.querySelector('#ata-body').scrollIntoView()");
      const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      (await import("node:fs")).writeFileSync(process.env.SHOT_ATA, Buffer.from(data, "base64"));
    }
    await waitFor(() => ev("!document.querySelector('#ata-body .wait') && document.querySelector('#ata-body').textContent.includes('Próximos passos definidos')"), "ata pronta", 15000);
    console.log("✓ ata: cartão de espera com etapa, tempo e palavras; prévia só ao pedir; ata aparece formatada no fim");
    await ev(`chrome.storage.local.remove("apiKey")`);
  }

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
