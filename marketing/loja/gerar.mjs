// Imagens da ficha na Chrome Web Store: 5 capturas 1280×800, bloco pequeno 440×280 e grande 1400×560.
// Usa as capturas reais do app (site/img/app-*.webp, geradas por marketing/capturas-site.mjs).
//   CHROME=/caminho/chrome node marketing/loja/gerar.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
if (!CHROME) { console.error("Defina CHROME."); process.exit(2); }
const SITE = resolve(import.meta.dirname, "../../site");
const OUT = import.meta.dirname;
const css = `
@import url("file://${SITE}/fonts.css");
:root{--paper:oklch(96.6% 0.014 84);--paper-2:oklch(93.4% 0.02 82);--ink:oklch(23% 0.022 55);--ink-2:oklch(40% 0.022 55);--rec:oklch(58% 0.19 32);--marker:oklch(90% 0.15 98);--night:oklch(21% 0.018 50);--night-text:oklch(93% 0.016 84)}
*{box-sizing:border-box;margin:0}
body{width:var(--w);height:var(--h);overflow:hidden;background:var(--paper);color:var(--ink);font-family:"Hanken Grotesk",system-ui,sans-serif}
.serif{font-family:"Fraunces",Georgia,serif}
mark{background:linear-gradient(transparent 55%,var(--marker) 55%);color:inherit;padding:0 .08em}
.rec{display:inline-block;width:.55em;height:.55em;border-radius:50%;background:var(--rec);margin-right:.35em;vertical-align:.08em}
`;
const shotPage = (title, sub, img) => `
<div style="padding:44px 64px 0;height:100%;display:flex;flex-direction:column">
  <h1 class="serif" style="font-size:44px;font-weight:600;letter-spacing:-.01em;line-height:1.1">${title}</h1>
  <p style="font-size:20px;color:var(--ink-2);margin-top:10px">${sub}</p>
  <div style="flex:1;margin-top:28px;border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 18px 50px -12px oklch(23% 0.022 55 / .35);border:1px solid oklch(84% 0.024 78)">
    <img src="file://${SITE}/img/${img}" style="width:100%;display:block">
  </div>
</div>`;
const pages = [
  ["loja-1-transcricao.png", 1280, 800, shotPage("A reunião <mark>transcrita</mark> enquanto acontece", "Google Meet, Teams, Zoom e huddles do Slack, com quem falou e quando. Tudo fica no seu computador.", "app-transcricao.webp")],
  ["loja-2-ata.png", 1280, 800, shotPage("A ata pronta <mark>em segundos</mark>", "Decisões, ações com responsável e prazo, no seu modelo. Exporte em PDF, Word ou texto.", "app-ata.webp")],
  ["loja-3-slides.png", 1280, 800, shotPage("A reunião vira <mark>apresentação</mark>", "Slides com a IA em 8 estilos, notas do apresentador e .pptx editável. Cada slide aponta o momento da fala.", "app-slides.webp")],
  ["loja-4-ia.png", 1280, 800, shotPage("Pergunte à IA <mark>sobre a reunião</mark>", "Pontos principais, itens de ação, o que você perdeu. Use sua própria chave ou o Escribanote Pro.", "app-ia.webp")],
  ["loja-5-analise.png", 1280, 800, shotPage("Quem falou, quanto e <mark>o que importou</mark>", "Destaques, notas, capturas de tela e análise de fala. Busca em todas as reuniões.", "app-analise.webp")],
  ["loja-bloco-pequeno.png", 440, 280, `
<div style="height:100%;padding:30px 30px;display:flex;flex-direction:column;justify-content:space-between;background:var(--night);color:var(--night-text)">
  <div style="display:flex;align-items:center;gap:12px"><img src="file://${SITE}/img/icon.png" style="width:44px;height:44px;border-radius:10px"><span class="serif" style="font-size:30px;font-weight:600">Escribanote</span></div>
  <div class="serif" style="font-size:31px;line-height:1.12;font-weight:500"><span class="rec"></span>Suas reuniões,<br><span style="color:var(--marker)">transcritas e resumidas.</span></div>
  <div style="font-size:14px;opacity:.75">Meet · Teams · Zoom · Slack</div>
</div>`],
  ["loja-bloco-grande.png", 1400, 560, `
<div style="height:100%;display:grid;grid-template-columns:520px 1fr;background:var(--night);color:var(--night-text)">
  <div style="padding:60px 56px;display:flex;flex-direction:column;justify-content:center;gap:22px">
    <div style="display:flex;align-items:center;gap:14px"><img src="file://${SITE}/img/icon.png" style="width:52px;height:52px;border-radius:12px"><span class="serif" style="font-size:36px;font-weight:600">Escribanote</span></div>
    <div class="serif" style="font-size:46px;line-height:1.08;font-weight:500"><span class="rec"></span>Cada palavra da reunião, <span style="color:var(--marker)">anotada.</span></div>
    <div style="font-size:18px;opacity:.8">Transcrição privada, ata, slides e perguntas à IA para Meet, Teams, Zoom e Slack.</div>
  </div>
  <div style="padding:48px 0 0 0;overflow:hidden"><img src="file://${SITE}/img/app-slides.webp" style="width:1040px;border-radius:12px 0 0 0;display:block;box-shadow:0 20px 60px #0008"></div>
</div>`],
];

const PORT = 9700 + Math.floor(Math.random() * 200);
const profile = mkdtempSync(join(tmpdir(), "esn-loja-"));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); } }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
try {
  for (const [name, w, h, body] of pages) {
    const file = join(profile, name + ".html");
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>${css}</style><body style="--w:${w}px;--h:${h}px">${body}</body>`);
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: "file://" + file });
    await sleep(1500);
    const r = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    writeFileSync(join(OUT, name), Buffer.from(r.data, "base64"));
    console.log("✓", name);
  }
} finally {
  ws.close(); chrome.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true });
}
