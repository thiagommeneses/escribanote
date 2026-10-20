// Área logada num Chrome real, contra o servidor de desenvolvimento (Postgres local, IA e Stripe simuladas).
//   CHROME=... TEST_DATABASE_URL=... node test/e2e-web.mjs [pasta-de-screenshots]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevServer } from "../scripts/dev-server.js";
import { sampleMeeting } from "./helpers.js";

const CHROME = process.env.CHROME;
const OUT = process.argv[2] || tmpdir();
if (!CHROME) throw new Error("defina CHROME");
const PORT = 8790 + Math.floor(Math.random() * 50);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✘"} ${label}`);
  if (!ok) failed = true;
};

const srv = await startDevServer({ port: PORT });
const DBG = 9300 + Math.floor(Math.random() * 100);
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "reunilo-web-"))}`,
  `--remote-debugging-port=${DBG}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

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
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
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
const shot = async (sid, name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sid);
  writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
};
const waitFor = async (sid, expr, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await evalIn(sid, expr).catch(() => false)) return true;
    if (Date.now() > end) {
      check(false, `tempo esgotado: ${what}`);
      return false;
    }
    await sleep(150);
  }
};

try {
  const { targetId } = await send("Target.createTarget", { url: `${srv.url}/app/` });
  const { sessionId: p } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, p);
  await send("Runtime.enable", {}, p);
  const go = (hash) => evalIn(p, `location.hash = ${JSON.stringify(hash)}; true`);

  // 1) Login por link mágico
  await waitFor(p, `!!document.getElementById("login-form")`, "tela de login");
  await shot(p, "web-1-login.png");
  await evalIn(p, `document.getElementById("login-email").value = "ana@exemplo.com"; document.querySelector("#login-form button").click(); true`);
  await waitFor(p, `!document.getElementById("login-sent").hidden`, "aviso de link enviado");
  const mail = await (await fetch(`${srv.url}/__test/mail`)).json();
  const link = mail.text.match(/https?:\/\/\S+#\/entrar\/[\w-]+/)[0];
  check(link.startsWith(srv.url + "/app/#/entrar/"), "e-mail com o link de acesso");
  await evalIn(p, `location.href = ${JSON.stringify(link)}; true`);
  await waitFor(p, `!!document.querySelector(".lib")`, "biblioteca depois do login");
  check(await evalIn(p, `document.querySelector(".empty-pane")?.textContent.includes("Conhecer o Pro")`), "conta grátis: convite para o Pro");

  // 2) Conta grátis: planos e Checkout
  await go("#/conta");
  await waitFor(p, `!!document.querySelector('[data-act="checkout"]')`, "planos na conta");
  await shot(p, "web-2-conta-gratis.png");
  check(await evalIn(p, `document.querySelector(".plans").textContent.includes("Pix Automático")`), "plano em reais com Pix Automático");

  // 3) Vira Pro e ganha reuniões (como se a extensão tivesse sincronizado)
  await fetch(`${srv.url}/__test/pro`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ana@exemplo.com" }) });
  const put = (doc) =>
    evalIn(p, `fetch("/api/v1/meetings/${doc.id}", { method: "PUT", headers: { "content-type": "application/json", "x-reunilo": "1" }, body: JSON.stringify({ doc: ${JSON.stringify(doc)} }) }).then((r) => r.status)`);
  check((await put(sampleMeeting("mt-1"))) === 200, "reunião enviada à conta");
  await put(sampleMeeting("mt-2", { title: "Daily do time de produto", platform: "slack", startedAt: Date.UTC(2026, 9, 19, 13), speakers: { a: "Carla", b: "Diego" } }));
  await evalIn(p, `location.reload(); true`);
  await sleep(800);
  await go("#/");
  await waitFor(p, `document.querySelectorAll("#list .card").length === 2`, "duas reuniões na lista");
  check(await evalIn(p, `!document.getElementById("credits").hidden && document.getElementById("credits").textContent.includes("15")`), "contador de créditos no topo");

  // 4) Abrir a reunião
  await go("#/r/mt-1");
  await waitFor(p, `document.querySelectorAll("#tx .blk").length === 2`, "transcrição com dois blocos");
  check(await evalIn(p, `document.querySelector("#tx .blk.hl .tag")?.textContent.includes("Decisão")`), "destaque marcado na transcrição");
  check(await evalIn(p, `document.getElementById("m-title").value`) === "Planejamento do orçamento", "título da reunião");

  // 5) Ata com IA (streaming) e salva
  await evalIn(p, `document.querySelector('[data-act="ata"]').click(); true`);
  await waitFor(p, `document.querySelector("#ata-live")?.textContent.includes("orçamento do Q4") && !document.querySelector(".typing")`, "ata gerada");
  check(await evalIn(p, `document.getElementById("credits").textContent.includes("14")`), "ata consumiu 1 crédito");
  await shot(p, "web-3-reuniao-ata.png");

  // 6) Pergunta à IA
  srv.anthropic.text = "**Bruno** aprovou a proposta de mídia de 180 mil.";
  await evalIn(p, `document.querySelector('[data-act="tab"][data-tab="ia"]').click(); document.getElementById("ask-input").value = "Quem aprovou a mídia?"; document.querySelector('[data-act="ask"]').click(); true`);
  await waitFor(p, `[...document.querySelectorAll("#qa .a")].at(-1)?.textContent.includes("aprovou a proposta")`, "resposta da IA");
  await sleep(500);
  const chats = await evalIn(p, `fetch("/api/v1/meetings/mt-1").then((r) => r.json()).then((d) => d.doc.chats.length)`);
  check(chats === 1, "conversa salva na reunião");
  await shot(p, "web-4-pergunta.png");

  // 7) Renomear participante
  await evalIn(p, `document.querySelector('.spk[data-spk="b"]').click(); true`);
  await sleep(200);
  await evalIn(p, `(() => { const i = document.querySelector("#tx input.input:not(#tx-search)"); i.value = "Bruno Lima"; i.blur(); return true; })()`);
  await waitFor(p, `[...document.querySelectorAll("#tx .who")].some((w) => w.textContent.includes("Bruno Lima"))`, "participante renomeado");

  // 8) Busca global sem acento
  await evalIn(p, `(() => { const s = document.getElementById("search"); s.value = "orcamento"; s.dispatchEvent(new Event("input")); document.getElementById("search-form").requestSubmit(); return true; })()`);
  await waitFor(p, `document.querySelector("#list .snip mark")?.textContent.toLowerCase().includes("orçamento")`, "resultado da busca com trecho marcado");
  await shot(p, "web-5-busca.png");

  // 9) Link de compartilhamento
  await evalIn(p, `document.querySelector('[data-act="drawer"][data-d="share"]').click(); true`);
  await waitFor(p, `!!document.querySelector('[data-act="share"]')`, "painel de compartilhar");
  await evalIn(p, `document.querySelector('[data-act="share"]').click(); true`);
  await waitFor(p, `!!document.getElementById("sh-url")`, "link criado");
  const shareUrl = await evalIn(p, `document.getElementById("sh-url").value`);
  const pub = await (await fetch(shareUrl)).text();
  check(pub.includes("Planejamento do orçamento") && pub.includes("Bruno Lima") && pub.includes("Resumo"), "página pública com ata e transcrição");

  // 10) Perguntar a todas as reuniões
  srv.anthropic.text = "Na reunião Planejamento do orçamento, a mídia de 180 mil foi aprovada.";
  await go("#/perguntar");
  await waitFor(p, `!!document.getElementById("askall-input")`, "tela de perguntar às reuniões");
  await evalIn(p, `document.getElementById("askall-input").value = "O que foi aprovado?"; document.querySelector('[data-act="askall"]').click(); true`);
  await waitFor(p, `document.querySelector("#qa .a")?.textContent.includes("180 mil")`, "resposta sobre todas as reuniões");
  check(await evalIn(p, `document.getElementById("credits").textContent.includes("11")`), "pergunta geral custou 2 créditos");

  // 11) Conta Pro
  await go("#/conta");
  await waitFor(p, `!!document.querySelector(".panel.pro")`, "painel do Pro");
  check(await evalIn(p, `document.querySelector(".panel.pro").textContent.includes("11 de 30")`), "créditos na conta");
  await shot(p, "web-6-conta-pro.png");

  // 12) Paleta de comandos
  await go("#/");
  await waitFor(p, `!!document.getElementById("list")`, "lista");
  await evalIn(p, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })); true`);
  await evalIn(p, `(() => { const i = document.getElementById("palette-input"); i.value = "daily"; i.dispatchEvent(new Event("input")); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); return true; })()`);
  await waitFor(p, `location.hash === "#/r/mt-2"`, "paleta abre a reunião");

  // 13) Celular
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, p);
  await go("#/r/mt-1");
  await sleep(700);
  check(await evalIn(p, `getComputedStyle(document.querySelector(".side")).display === "none" && document.documentElement.scrollWidth <= 390`), "celular: só a reunião, sem rolagem lateral");
  await shot(p, "web-7-celular.png");
  await go("#/");
  await sleep(500);
  await shot(p, "web-8-celular-lista.png");

  check(consoleErrors.length === 0, `sem erros no console${consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""}`);
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  chrome.kill();
  await srv.close();
}
process.exit(failed ? 1 : 0);
