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
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "escribanote-web-"))}`,
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
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text) + " @" + (msg.params.exceptionDetails.url || ""));
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

  // 1) Login por link mágico, vindo da página /pro/ com o plano mensal em dólar escolhido
  await go("#/conta?plano=mensal&moeda=usd");
  await waitFor(p, `!!document.getElementById("login-form")`, "tela de login");
  await shot(p, "web-1-login.png");
  check(await evalIn(p, `[...document.querySelectorAll(".social-btn")].length === 2 && [...document.querySelectorAll(".social-btn")].every((b) => b.disabled)`), "login: Google e Apple aparecem desativados (em breve)");
  await evalIn(p, `document.getElementById("login-email").value = "ana@exemplo.com"; document.querySelector('[data-act="magic"]').click(); true`);
  await waitFor(p, `!document.getElementById("login-sent").hidden`, "aviso de link enviado");
  const mail = await (await fetch(`${srv.url}/__test/mail`)).json();
  const link = mail.text.match(/https?:\/\/\S+#\/entrar\/[\w-]+/)[0];
  check(link.startsWith(srv.url + "/app/#/entrar/"), "e-mail com o link de acesso");
  check(/<title>Seu link de acesso ao Escribanote<\/title>/.test(mail.html), "e-mail em HTML completo (com título)");
  // O link abre noutra aba (sessionStorage vazio): o plano escolhido tem que sobreviver.
  await evalIn(p, `sessionStorage.clear(); location.href = ${JSON.stringify(link)}; true`);

  // 2) Conta grátis: cai na assinatura com o plano escolhido; troca para anual e assina
  await waitFor(p, `!!document.getElementById("subscribe")`, "assinatura depois do login (plano vindo do site)");
  const offer = () => evalIn(p, `document.querySelector("#subscribe .offer-price").textContent.replace(/\\s+/g, " ")`);
  check((await offer()).includes("US$ 3"), "plano escolhido no site mantido (mensal em dólar)");
  await evalIn(p, `document.querySelector('[data-k="currency"][data-v="brl"]').click(); true`);
  let o = await offer();
  check(o.includes("R$ 15") && o.includes("Cartão de crédito") && !o.includes("Pix Automático"), "mensal em reais: só cartão");
  check(o.includes("Pix está disponível no plano anual"), "mensal avisa que o Pix é do anual");
  await evalIn(p, `document.querySelector('[data-k="interval"][data-v="year"]').click(); true`);
  o = await offer();
  check(o.includes("R$ 150") && o.includes("R$ 180") && o.includes("Pix Automático"), "anual em reais: R$ 150, preço cheio riscado e Pix");
  check(await evalIn(p, `document.querySelector("#subscribe .trust").textContent.includes("LGPD")`), "bloco de segurança com LGPD/GDPR/CCPA");
  await shot(p, "web-2-conta-gratis.png");
  await evalIn(p, `document.querySelector('#subscribe [data-act="checkout"]').click(); true`);
  await sleep(600);
  const calls = await (await fetch(`${srv.url}/__test/stripe`)).json();
  const co = calls.filter((c) => c[0] === "checkout.create").at(-1)?.[1];
  check(co?.line_items?.[0]?.price === "price_brl_year" && co.payment_method_types.includes("pix"), "checkout do anual em reais com Pix");
  await send("Page.navigate", { url: `${srv.url}/app/#/` }, p);
  await sleep(800);

  // 3) Vira Pro e ganha reuniões (como se a extensão tivesse sincronizado)
  await fetch(`${srv.url}/__test/pro`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ana@exemplo.com" }) });
  const put = (doc) =>
    evalIn(p, `fetch("/api/v1/meetings/${doc.id}", { method: "PUT", headers: { "content-type": "application/json", "x-escribanote": "1" }, body: JSON.stringify({ doc: ${JSON.stringify(doc)} }) }).then((r) => r.status)`);
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

  // 6b) Parar a resposta no meio: o que veio fica na conversa, marcado, e o crédito volta
  const credBefore = await evalIn(p, `document.getElementById("credits").textContent`);
  srv.anthropic.text = "Resposta longa que vai sendo escrita aos poucos. ".repeat(20);
  srv.anthropic.delayMs = 120;
  await evalIn(p, `document.getElementById("ask-input").value = "Explique tudo em detalhes"; document.querySelector('[data-act="ask"]').click(); true`);
  await waitFor(p, `!!document.querySelector('[data-act="ai-stop"]') && ([...document.querySelectorAll("#qa .a")].at(-1)?.textContent || "").includes("aos poucos")`, "resposta começando e botão Parar");
  await shot(p, "web-4b-parar.png");
  await evalIn(p, `document.querySelector('[data-act="ai-stop"]').click(); true`);
  await waitFor(p, `([...document.querySelectorAll("#qa .a")].at(-1)?.textContent || "").includes("interrompida") && !!document.querySelector('[data-act="ask"]')`, "resposta interrompida");
  srv.anthropic.delayMs = 0;
  await sleep(2500);
  check(await evalIn(p, `document.getElementById("credits").textContent`) === credBefore, "parar devolve o crédito");
  const chats2 = await evalIn(p, `fetch("/api/v1/meetings/mt-1").then((r) => r.json()).then((d) => d.doc.chats.length)`);
  check(chats2 === 2, "resposta interrompida fica salva na conversa");

  // 7) Renomear participante
  await evalIn(p, `document.querySelector('.spk[data-spk="b"]').click(); true`);
  await sleep(200);
  await evalIn(p, `(() => { const i = document.querySelector(".ask input"); i.value = "Bruno Lima"; document.querySelector(".ask [data-ok]").click(); return true; })()`);
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
  // Senha: a conta entrou pelo link e ainda não tem senha; define pelo painel
  check(await evalIn(p, `document.getElementById("pw-panel").textContent.includes("Definir senha")`), "conta sem senha oferece Definir senha");
  await evalIn(p, `document.querySelector('#pw-panel [data-act="pw-open"]').click(); document.getElementById("pw-change-new").value = "ana senha forte"; document.querySelector('#pw-change [type="submit"]').click(); true`);
  await waitFor(p, `document.getElementById("pw-panel")?.textContent.includes("Alterar senha")`, "senha definida na conta");

  // 11b) Slides: gerar (1 crédito), abrir o visualizador, editar, ir à fala pelo horário
  {
    const t0 = Date.UTC(2026, 9, 20, 14);
    const falas = ["Bom dia, vamos falar do lançamento do produto novo e do que mudou.", "O lançamento foi adiado para março porque os testes ainda falham.", "A receita do trimestre subiu 37 por cento.", "Precisamos fechar o contrato com o fornecedor até sexta.", "O cliente pediu integração com o Slack e relatórios semanais.", "Então ficamos assim: nova data em março e revisão na segunda."];
    const entries = falas.map((text, i) => ({ text: `${text} Isso foi discutido com calma e todos concordaram com os próximos passos.` })).map(({ text }, i) => ({ id: "l" + i, at: t0 + (i + 1) * 60_000, updatedAt: t0 + (i + 1) * 60_000 + 5000, speakerId: i % 2 ? "b" : "a", text, kind: "caption" }));
    await put(sampleMeeting("mt-3", { title: "Lançamento Q1", startedAt: t0, updatedAt: t0 + 8 * 60_000, endedAt: t0 + 8 * 60_000, entries, highlights: {} }));
    const sl = (o) => ({ layout: "topicos", title: "", bullets: [], stats: [], quote: "", speaker: "", notes: "", at: "00:00", shot: "", ...o });
    srv.anthropic.reviewText = JSON.stringify({ title: "Lançamento adiado para março", subtitle: "Planejamento do Q1", slides: [
      sl({ layout: "capa", title: "Lançamento adiado para março" }),
      sl({ title: "Testes ainda falham", bullets: ["Nova data em março", "Revisão na segunda"], notes: "Explique o atraso.", at: "00:02:00" }),
      sl({ layout: "numeros", title: "Trimestre forte", stats: [{ value: "37%", label: "receita" }, { value: "6", label: "falas" }], at: "00:03:00" }),
      sl({ layout: "acoes", title: "Próximos passos", bullets: ["Fechar o contrato (sexta)", "Plano do Slack"], at: "00:04:00" }),
    ] });
    await go("#/r/mt-3");
    await waitFor(p, `document.querySelectorAll("#tx .blk").length > 0`, "reunião dos slides");
    await evalIn(p, `document.querySelector('[data-act="tab"][data-tab="sl"]').click(); true`);
    await waitFor(p, `!!document.querySelector('[data-act="sl-gen"]')`, "formulário dos slides");
    await evalIn(p, `document.querySelector('input[name="sl-kind"][value="aula"]').click(); true`);
    await evalIn(p, `document.querySelector('[data-act="sl-pal"][data-pal="roxo"]').click(); true`);
    await shot(p, "web-6b-slides-form.png");
    await evalIn(p, `document.querySelector('[data-act="sl-gen"]').click(); true`);
    await waitFor(p, `!!document.querySelector(".esv .esv-thumb")`, "visualizador dos slides", 10000);
    check(await evalIn(p, `document.querySelectorAll(".esv-thumb").length`) === 4, "quatro slides no visualizador");
    check(await evalIn(p, `document.getElementById("credits").textContent.includes("10")`), "slides custaram 1 crédito");
    const reqSl = srv.anthropic.calls.at(-1).params;
    check(/Aula ou treinamento/.test(reqSl.system) && reqSl.output_config.format.type === "json_schema", "pedido com o tipo escolhido e esquema JSON");
    await evalIn(p, `document.querySelector('.esv-thumb[data-i="1"]').click(); true`);
    await shot(p, "web-6c-slides-visualizador.png");
    await evalIn(p, `document.querySelector('.esv [data-a="edit"]').click(); true`);
    await evalIn(p, `(() => { const i = document.querySelector('.esv-edit [data-f="title"]'); i.value = "Testes falham em dois ambientes"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await sleep(1500);
    const savedSl = await evalIn(p, `fetch("/api/v1/meetings/mt-3").then((r) => r.json()).then((d) => d.doc.slides)`);
    check(savedSl?.slides?.[1]?.title === "Testes falham em dois ambientes" && savedSl.palette === "roxo" && savedSl.kind === "aula", "edição salva na reunião da conta");
    await evalIn(p, `document.querySelector(".esv-main .esd-at").click(); true`);
    await waitFor(p, `!!document.querySelector(".esv-pop .esv-pop-msg.main")`, "balão com a fala do horário");
    check(await evalIn(p, `!!document.querySelector(".esv") && /Bruno|Ana/.test(document.querySelector(".esv-pop").textContent)`), "horário do slide abre o balão com a fala, sem sair dos slides");
    await shot(p, "web-6c2-slides-balao.png");
    await evalIn(p, `document.querySelector('.esv-pop [data-pop="jump"]').click(); true`);
    await sleep(500);
    check(await evalIn(p, `!document.querySelector(".esv") && !!document.querySelector("#tx .blk.flash")`), "horário do slide leva à fala");
    await evalIn(p, `document.querySelector('[data-act="tab"][data-tab="sl"]').click(); true`);
    await waitFor(p, `!!document.querySelector(".sl-deck .sl-cover")`, "cartão dos slides");
    await shot(p, "web-6d-slides-cartao.png");
    srv.anthropic.reviewText = null;
  }

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

  // 9) Site: página do Pro com os seletores e o atalho "Pro" no menu da home
  await send("Emulation.clearDeviceMetricsOverride", {}, p).catch(() => {});
  await send("Page.navigate", { url: `${srv.url}/` }, p);
  await waitFor(p, `document.readyState === "complete" && !!document.querySelector(".nav-pro")`, "home carregada");
  check(await evalIn(p, `document.querySelector(".nav-pro").getAttribute("href") === "pro/" && !!document.querySelector('.nav-login[href="app/"]')`), "home: menu com Pro e Entrar");
  check(await evalIn(p, `!document.body.textContent.includes("porque eles não existem")`), "home: sem a frase antiga sobre servidores");
  // Sai da conta: quem chega do site ainda não está logado.
  await evalIn(p, `fetch("/api/v1/auth/logout", { method: "POST", headers: { "x-escribanote": "1" } }).then((r) => r.status)`);
  await send("Page.navigate", { url: `${srv.url}/pro/` }, p);
  await waitFor(p, `document.readyState === "complete" && !!document.querySelector(".seg .thumb[style]")`, "página do Pro");
  const priceTxt = () => evalIn(p, `[document.getElementById("p-now").textContent, document.getElementById("p-pay").textContent, document.getElementById("p-cta").getAttribute("href")].join(" | ")`);
  let t = await priceTxt();
  check(t.includes("R$ 150") && t.includes("Pix Automático") && t.includes("plano=anual&moeda=brl"), "Pro: padrão anual em reais com Pix");
  await evalIn(p, `document.querySelector('[data-k="interval"] [data-v="month"]').click(); true`);
  t = await priceTxt();
  check(t.includes("R$ 15") && !t.includes("Pix") && t.includes("plano=mensal&moeda=brl"), "Pro: mensal em reais só no cartão");
  await evalIn(p, `document.querySelector('[data-k="currency"] [data-v="usd"]').click(); true`);
  t = await priceTxt();
  check(t.includes("US$ 3") && t.includes("plano=mensal&moeda=usd"), "Pro: mensal em dólar");
  await evalIn(p, `document.querySelector('[data-k="interval"] [data-v="month"]').focus(); document.querySelector('[data-k="interval"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); true`);
  t = await priceTxt();
  check(t.includes("US$ 30") && t.includes("plano=anual&moeda=usd"), "Pro: setas do teclado trocam para o anual");
  await evalIn(p, `document.getElementById("p-cta").click(); true`);
  await waitFor(p, `location.pathname === "/app/" && !!document.getElementById("login-form")`, "do botão Assinar para o login do app");
  check((await evalIn(p, `localStorage.getItem("escribanote:plano")`)) === JSON.stringify({ interval: "year", currency: "usd" }), "app guarda o plano escolhido no site para depois do login");

  // Entrar com e-mail + senha (senha errada primeiro)
  await evalIn(p, `document.getElementById("login-email").value = "ana@exemplo.com"; document.getElementById("login-password").value = "errada123"; document.querySelector('#login-form [type="submit"]').click(); true`);
  await waitFor(p, `document.getElementById("login-err").textContent.includes("incorretos")`, "senha errada avisa");
  await evalIn(p, `document.getElementById("login-password").value = "ana senha forte"; document.querySelector('#login-form [type="submit"]').click(); true`);
  await waitFor(p, `location.hash.startsWith("#/conta") && !!document.getElementById("pw-panel")`, "entrou com a senha e voltou para onde ia (conta)");
  // Esqueci minha senha: link por e-mail, senha nova, entra de novo
  await evalIn(p, `fetch("/api/v1/auth/logout", { method: "POST", headers: { "x-escribanote": "1" } }).then(() => { location.hash = "#/esqueci"; }); true`);
  await waitFor(p, `!!document.getElementById("link-form")`, "tela Esqueci minha senha");
  await evalIn(p, `document.getElementById("link-email").value = "ana@exemplo.com"; document.querySelector('#link-form [type="submit"]').click(); true`);
  await waitFor(p, `!document.getElementById("link-sent").hidden`, "aviso de link de senha enviado");
  const pwMail = await (await fetch(`${srv.url}/__test/mail`)).json();
  check(pwMail.subject === "Redefinir a senha do Escribanote", "e-mail de redefinição");
  const pwLink = pwMail.text.match(/https?:\/\/\S+#\/senha\/[\w-]+/)[0];
  await evalIn(p, `location.href = ${JSON.stringify(pwLink)}; true`);
  await waitFor(p, `!!document.getElementById("pw-form")`, "tela Escolha sua senha");
  await shot(p, "web-9-senha-nova.png");
  await evalIn(p, `document.getElementById("pw-new").value = "senha nova da ana"; document.getElementById("pw-again").value = "outra coisa"; document.querySelector('#pw-form [type="submit"]').click(); true`);
  await waitFor(p, `document.getElementById("pw-err").textContent.includes("não são iguais")`, "senhas diferentes avisam");
  await evalIn(p, `document.getElementById("pw-again").value = "senha nova da ana"; document.querySelector('#pw-form [type="submit"]').click(); true`);
  await waitFor(p, `!document.getElementById("pw-form") && !!document.querySelector(".top .nav")`, "senha nova salva e já entrou");
  const relogin = await fetch(`${srv.url}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ana@exemplo.com", password: "senha nova da ana" }) });
  check(relogin.status === 200, "a senha nova funciona no login");

  check(consoleErrors.length === 0, `sem erros no console${consoleErrors.length ? ": " + consoleErrors.join(" | ") : ""}`);
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  chrome.kill();
  await srv.close();
}
process.exit(failed ? 1 : 0);
