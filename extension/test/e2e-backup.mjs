// Teste do backup na pasta do computador e dos ajustes sincronizados, num Chrome real.
//   CHROME=... node test/e2e-backup.mjs [pasta-de-screenshots]
// O seletor de pastas do Windows não abre num teste automático: a "pasta escolhida" é uma pasta
// do sistema de arquivos privado do navegador (mesma API: FileSystemDirectoryHandle).
// A reinstalação é simulada apagando chrome.storage.local e recarregando a extensão.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
const [OUT = tmpdir()] = process.argv.slice(2);
if (!CHROME) {
  console.error("uso: CHROME=... node test/e2e-backup.mjs [pasta]");
  process.exit(2);
}
const EXT = resolve(import.meta.dirname, "..");
const EXPECTED_ID = "ohbnmfogdcbgegnpcaphidkjinplednd"; // fixado pela "key" do manifest
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "reunilo-bk-"));
let chrome, ws, seq = 0;
const pending = new Map();

async function launch() {
  const port = 9500 + Math.floor(Math.random() * 100);
  chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--window-size=1100,900", "about:blank"], { stdio: "ignore" });
  ws = null;
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
    } catch {
      ws = null;
      await sleep(200);
    }
  }
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
    }
  };
}
// Fecha o Chrome de verdade (o perfil fica, como no computador do usuário).
async function quit() {
  const closed = new Promise((r) => chrome.once("exit", r));
  await send("Browser.close").catch(() => {});
  await Promise.race([closed, sleep(5000)]);
}
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = ++seq;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
const evalIn = async (sid, expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✘"} ${label}`);
  if (!ok) failed = true;
};

// Reunião de exemplo no formato do "Exportar backup".
const t0 = Date.UTC(2026, 9, 17, 23, 34);
const sample = {
  id: "teste-bk-1",
  title: "Reunião de teste do backup",
  platform: "meet",
  meetingKey: "meet:abc-defg-hij",
  startedAt: t0,
  updatedAt: t0 + 120_000,
  endedAt: t0 + 120_000,
  speakers: { a: "Ana", b: "Bruno" },
  entries: [
    { id: "1", at: t0 + 1000, speakerId: "a", text: "Bom dia, vamos começar.", kind: "caption", source: "protocol" },
    { id: "2", at: t0 + 5000, speakerId: "b", text: "Bom dia! Trouxe os números do trimestre.", kind: "caption", source: "protocol" },
  ],
  asr: [],
  notes: { text: "", items: [] },
  highlights: {},
};

await launch();
try {
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  check(extId === EXPECTED_ID, `ID fixo da extensão (${extId})`);

  const open = async (path) => {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/${path}` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await sleep(1500);
    return { sessionId, targetId };
  };
  const msg = (sid, m) => evalIn(sid, `chrome.runtime.sendMessage(${JSON.stringify(m)})`);
  const files = (sid) => evalIn(sid, `(async () => {
    const { getBackupDir } = await import("/src/lib/backup.js");
    const dir = await getBackupDir();
    const out = {};
    for await (const [name, h] of dir.entries()) out[name] = await (await h.getFile()).text();
    return out;
  })()`);

  let { sessionId: app } = await open("src/app/app.html?view=settings");
  check(await evalIn(app, `document.getElementById("bk-status").textContent.startsWith("Desligado")`), "backup começa desligado");

  // "Escolhe" a pasta: o que o botão faz depois do seletor.
  await evalIn(app, `(async () => {
    const { setBackupDir, resolveBackupFolder } = await import("/src/lib/backup.js");
    const root = await navigator.storage.getDirectory();
    await setBackupDir(await resolveBackupFolder(await root.getDirectoryHandle("Documentos", { create: true })));
    return true;
  })()`);
  check((await msg(app, { type: "import", sessions: [sample] })) === 1, "reunião importada");
  await msg(app, { type: "backup-flush", all: true });
  let f = await files(app);
  const sessionFile = Object.keys(f).find((n) => n.endsWith("_teste-bk-1.json"));
  check(!!sessionFile && JSON.parse(f[sessionFile]).sessions[0].entries.length === 2, `reunião gravada na pasta Reunilo (${sessionFile})`);
  check(!!f["reunilo-ajustes.json"], "ajustes gravados na pasta");

  // Ajuste alterado vai para a conta do Chrome (chrome.storage.sync).
  await evalIn(app, `(async () => { const { setSettings } = await import("/src/lib/settings.js"); await setSettings({ myName: "Pessoa de Teste" }); })()`);
  await sleep(800);
  const synced = await evalIn(app, `(async () => { const { pullSyncedSettings } = await import("/src/lib/settings.js"); return pullSyncedSettings(); })()`);
  check(synced?.myName === "Pessoa de Teste" && synced._at > 0, "ajuste sincronizado com a conta do Chrome");
  check(!JSON.stringify(synced).includes("sk-ant"), "chave de API fora da sincronização");

  await evalIn(app, `location.reload()`).catch(() => {});
  await sleep(1500);
  const status = await evalIn(app, `document.getElementById("bk-status").textContent`);
  check(status.includes('"Reunilo"') && status.includes("último backup"), `status do backup em Ajustes: ${status}`);
  await evalIn(app, `document.getElementById("backup-card").scrollIntoView({ block: "center" })`);
  const { data } = await send("Page.captureScreenshot", { format: "png" }, app);
  writeFileSync(join(OUT, "backup-settings.png"), Buffer.from(data, "base64"));

  // "Reinstalação": remover a extensão apaga chrome.storage.local e a pasta lembrada; a pasta continua no disco.
  await evalIn(app, `(async () => { const { setBackupDir } = await import("/src/lib/backup.js"); await setBackupDir(null); await chrome.storage.local.clear(); })()`);
  await quit();
  await launch();
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await send("Target.getTargets");
    if (targetInfos.some((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"))) break;
    await sleep(200);
  }
  ({ sessionId: app } = await open("src/app/app.html"));
  check((await msg(app, { type: "list" })).length === 0, "depois de reinstalar: nenhuma reunião");
  writeFileSync(join(OUT, "backup-reinstalled.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" }, app)).data, "base64"));
  check(await evalIn(app, `!!document.querySelector("#recent [data-bk-restore]")`), "tela inicial vazia oferece restaurar de uma pasta");
  // O usuário escolhe a mesma pasta no seletor (aqui, o seletor devolve a pasta do teste).
  await evalIn(app, `(async () => {
    const root = await navigator.storage.getDirectory();
    const docs = await root.getDirectoryHandle("Documentos");
    window.showDirectoryPicker = async () => docs;
    document.querySelector("#recent [data-bk-restore]").click();
  })()`);
  await sleep(2500);
  const back = await msg(app, { type: "list" });
  const restored = back.length ? await msg(app, { type: "get", id: back[0].id }) : null;
  check(restored?.title === sample.title && restored.entries.length === 2, "reunião restaurada da pasta");
  check((await evalIn(app, `chrome.storage.local.get("settings").then((r) => r.settings?.myName)`)) === "Pessoa de Teste", "ajustes de volta (conta do Chrome)");

  // Apagar a reunião apaga o arquivo da pasta.
  await msg(app, { type: "delete", id: "teste-bk-1" });
  await msg(app, { type: "backup-flush" });
  f = await files(app);
  check(!Object.keys(f).some((n) => n.endsWith("_teste-bk-1.json")), "apagar a reunião apaga o arquivo do backup");
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  chrome.kill();
}
process.exit(failed ? 1 : 0);
