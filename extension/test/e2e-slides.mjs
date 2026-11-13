// Slides da reunião na extensão, com a conta Pro simulada: o pedido leva as opções e as capturas (com id),
// o visualizador abre com a captura no slide, a edição e a troca de cores ficam salvas, o horário leva à
// transcrição e o .pptx é baixado.
//   CHROME=... node test/e2e-slides.mjs [pasta-das-capturas]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME"); process.exit(2); }
const OUT = process.argv[2] || null;
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9800 + Math.floor(Math.random() * 100);
const profile = mkdtempSync(join(tmpdir(), "escribanote-slides-"));
const downloads = mkdtempSync(join(tmpdir(), "escribanote-slides-dl-"));
const t0 = Date.now() - 20 * 60_000;
const requests = [];
const api = createServer((req, res) => {
  const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE", "content-type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const reply = (code, obj) => { res.writeHead(code, cors); res.end(JSON.stringify(obj)); };
    if (url.pathname === "/api/v1/meetings" && req.method === "GET") return reply(200, { items: [] });
    if (url.pathname === "/api/v1/ai/slides") {
      const b = JSON.parse(body);
      requests.push(b);
      const shot = b.shots?.[0]?.id || "";
      const sl = (o) => ({ id: Math.random().toString(36).slice(2, 8), layout: "topicos", title: "", bullets: [], stats: [], quote: "", speaker: "", notes: "", at: null, shot: "", ...o });
      return reply(200, { balance: 4, credits: 1, deck: {
        title: "Lançamento adiado para março", subtitle: "Decisões da reunião de planejamento", kind: b.options.kind, style: b.options.style, palette: b.options.palette, mode: b.options.mode, createdAt: Date.now(),
        slides: [
          sl({ layout: "capa", title: "Lançamento adiado para março", at: t0 + 60_000 }),
          sl({ title: "Testes ainda não passaram", bullets: ["Integração falha em dois ambientes", "Nova data na primeira semana de março"], notes: "Explique por que adiamos.", at: t0 + 5 * 60_000 }),
          sl({ layout: "imagem", title: "Painel de vendas mostrado", bullets: ["Receita acelera em outubro"], shot, at: t0 + 6 * 60_000 }),
          sl({ layout: "numeros", title: "Trimestre forte", stats: [{ value: "37%", label: "crescimento da receita" }, { value: "R$ 1,2 mi", label: "receita" }], at: t0 + 7 * 60_000 }),
          sl({ layout: "acoes", title: "Próximos passos", bullets: ["Ana: fechar o contrato (sexta)", "Bruno: plano do Slack"], at: t0 + 9 * 60_000 }),
        ],
      } });
    }
    reply(404, { error: "not_found", message: "não" });
  });
}).listen(0);
const API = `http://127.0.0.1:${api.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--window-size=1280,860",
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
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  // página auxiliar para preparar o armazenamento antes de abrir a reunião
  const { targetId: prepId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1` });
  const { sessionId: prep } = await send("Target.attachToTarget", { targetId: prepId, flatten: true });
  await sleep(800);
  const evIn = (sid, expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid).then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; });
  const lines = ["Bom dia, vamos falar do lançamento do produto novo e do que mudou desde a última reunião.", "O lançamento foi adiado para março porque os testes de integração ainda falham em dois ambientes.", "A receita do trimestre subiu 37 por cento e chegamos a um vírgula dois milhão de reais.", "Precisamos fechar o contrato com o fornecedor até sexta, a Ana cuida disso.", "O cliente pediu integração com o Slack e relatórios semanais, o Bruno faz o plano.", "Qualidade não é negociável, prefiro atrasar a lançar com bug.", "Então ficamos assim: nova data em março e revisão do plano na segunda.", "Obrigado a todos, até a próxima."];
  const entries = lines.map((text, i) => ({ id: "e" + i, kind: "caption", speakerId: i % 2 ? "b" : "a", text, at: t0 + (i + 1) * 70_000, updatedAt: t0 + (i + 1) * 70_000 + 6000 }));
  const session = { id: "m-sl", title: "Planejamento do lançamento Q1", platform: "meet", startedAt: t0, endedAt: t0 + 11 * 60_000, updatedAt: t0 + 11 * 60_000, speakers: { a: "Ana Souza", b: "Bruno Lima" }, entries, shots: [{ id: "sh1", at: t0 + 6 * 60_000 }] };
  await evIn(prep, `(async () => {
    const c = new OffscreenCanvas(800, 450); const g = c.getContext("2d");
    g.fillStyle = "#f8fafc"; g.fillRect(0, 0, 800, 450); g.fillStyle = "#2563eb";
    [60, 120, 90, 180, 240, 300].forEach((h, i) => g.fillRect(80 + i * 110, 400 - h, 70, h));
    g.fillStyle = "#0f172a"; g.font = "bold 28px sans-serif"; g.fillText("Receita por mês", 80, 60);
    const b = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
    await chrome.storage.local.set({ welcomeDone: true, "session:m-sl": ${JSON.stringify(session)}, "shot:m-sl:sh1": url, accountApi: ${JSON.stringify(API)},
      account: { token: "tok-teste-com-mais-de-20-letras", plan: "pro", balance: 5, email: "a@b.c", checkedAt: Date.now() } });
  })()`);
  await send("Target.closeTarget", { targetId: prepId });

  const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/src/app/app.html?tab=1&id=m-sl` });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  await sleep(1500);
  const ev = (e) => evIn(sessionId, e);
  const shot = async (name) => {
    if (!OUT) return;
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  };
  const waitFor = async (expr, what, tries = 60) => { for (let i = 0; i < tries; i++) { if (await ev(expr)) return; await sleep(250); } throw new Error("esperou demais: " + what); };

  // 1. Aba Slides: formulário com tipo, tamanho, estilo, cores, tema e capturas; custo de 1 crédito.
  await ev(`document.querySelector('.subtabs [data-tab="slides"]').click()`);
  await waitFor(`!!document.querySelector("#sl-gen")`, "formulário");
  assert.match(await ev(`document.querySelector("#sl-gen").textContent`), /Gerar slides.*1 crédito/);
  assert.equal(await ev(`document.querySelectorAll(".sl-kind").length`), 4);
  assert.match(await ev(`document.querySelector("#pane-slides").textContent`), /Usar as capturas de tela \(1\)/);
  await ev(`document.querySelector('input[name="sl-kind"][value="status"]').click()`);
  await ev(`(() => { const s = document.querySelector("#sl-style"); s.value = "classico"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await ev(`document.querySelector('[data-pal="verde"]').click()`);
  await ev(`(() => { const t = document.querySelector("#sl-inst"); t.value = "Foque nos prazos"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await shot("01-formulario");

  // 2. Gerar: o pedido leva as opções e a captura com id; o visualizador abre sozinho.
  await ev(`document.querySelector("#sl-gen").click()`);
  await waitFor(`!!document.querySelector(".esv")`, "visualizador");
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.deepEqual([r.options.kind, r.options.style, r.options.palette, r.options.mode, r.options.instructions], ["status", "classico", "verde", "claro", "Foque nos prazos"]);
  assert.equal(r.shots.length, 1);
  assert.equal(r.shots[0].id, "sh1");
  assert.equal(r.shots[0].mime, "image/jpeg");
  assert.equal(r.meeting.shots.length, 0, "a reunião vai sem as capturas embutidas");
  assert.equal(await ev(`document.querySelectorAll(".esv-thumb").length`), 5);
  await ev(`document.querySelector('.esv-thumb[data-i="2"]').click()`);
  await sleep(300);
  assert.equal(await ev(`!!document.querySelector(".esv-main .esd-img img")`), true, "a captura aparece no slide de imagem");
  await shot("02-visualizador");

  // 3. Editar texto e trocar as cores: fica salvo na reunião.
  await ev(`document.querySelector('.esv [data-a="edit"]').click()`);
  await ev(`document.querySelector('.esv-thumb[data-i="1"]').click()`);
  await ev(`(() => { const i = document.querySelector('.esv-edit [data-f="title"]'); i.value = "Testes ainda falham em 2 ambientes"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await ev(`(() => { const s = document.querySelector('.esv [data-k="mode"]'); s.value = "escuro"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(1500);
  await shot("03-edicao");
  const saved = await ev(`chrome.runtime.sendMessage({ type: "get", id: "m-sl" }).then((s) => s && s.slides)`).catch(() => null)
    || await ev(`chrome.storage.local.get("session:m-sl").then((r) => r["session:m-sl"].slides)`);
  assert.equal(saved.slides[1].title, "Testes ainda falham em 2 ambientes");
  assert.equal(saved.mode, "escuro");
  assert.equal(saved.palette, "verde");

  // 4. Baixar o .pptx.
  await ev(`document.querySelector('.esv [data-a="pptx"]').click()`);
  let file;
  for (let i = 0; i < 40 && !file; i++) { file = readdirSync(downloads).find((f) => f.endsWith(".pptx")); if (!file) await sleep(250); }
  assert.ok(file, "baixou o .pptx");
  assert.match(file, /Planejamento do lançamento Q1 - slides\.pptx/);
  assert.ok(statSync(join(downloads, file)).size > 5000);

  // 5. Apresentar e sair com Esc.
  await ev(`document.querySelector('.esv [data-a="present"]').click()`);
  await sleep(400);
  assert.equal(await ev(`!!document.querySelector(".esv-present .esd-slide")`), true);
  await shot("04-apresentando");
  await ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(300);
  assert.equal(await ev(`!!document.querySelector(".esv-present")`), false);

  // 6. O horário do slide leva à fala na transcrição.
  await ev(`document.querySelector(".esv-main .esd-at").click()`);
  await sleep(600);
  assert.equal(await ev(`!!document.querySelector(".esv")`), false, "o visualizador fecha");
  assert.equal(await ev(`document.querySelector('.subtabs [aria-selected="true"]').dataset.tab`), "transcript");
  assert.equal(await ev(`!!document.querySelector(".blk.flash")`), true, "a fala fica em destaque");

  // 7. A aba mostra o cartão com a capa e as ações.
  await ev(`document.querySelector('.subtabs [data-tab="slides"]').click()`);
  await waitFor(`!!document.querySelector(".sl-deck")`, "cartão dos slides");
  assert.match(await ev(`document.querySelector(".sl-deck").textContent`), /5 slides · Status de projeto · Escribanote Pro/);
  await shot("05-cartao");
  console.log("E2E SLIDES OK");
} finally {
  ws.close(); chrome.kill(); api.close(); await sleep(300);
  rmSync(profile, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
