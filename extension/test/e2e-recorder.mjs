// Teste do gravador do computador (Slack e outros apps) num Chrome real.
//   CHROME=... node test/e2e-recorder.mjs sistema.wav microfone.wav [pasta-de-screenshots]
// O "áudio do sistema" é simulado trocando getDisplayMedia por um stream que toca sistema.wav;
// o microfone é o dispositivo falso do Chrome tocando microfone.wav. Usa o modelo Whisper "base"
// (baixado na primeira vez; PROFILE=... reaproveita um perfil com o modelo em cache).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHROME = process.env.CHROME;
const [systemWav, micWav, OUT = tmpdir()] = process.argv.slice(2);
if (!CHROME || !systemWav || !micWav) {
  console.error("uso: CHROME=... node test/e2e-recorder.mjs sistema.wav microfone.wav [pasta]");
  process.exit(2);
}
const EXT = resolve(import.meta.dirname, "..");
const PORT = 9700 + Math.floor(Math.random() * 100);
const profile = process.env.PROFILE || mkdtempSync(join(tmpdir(), "reunilo-rec-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--no-first-run", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve(micWav)}`,
  "--autoplay-policy=no-user-gesture-required", "--window-size=1100,900", "about:blank"], { stdio: "ignore" });

let ws;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  } catch {
    ws = null;
    await sleep(200);
  }
}
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  }
};
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
const shot = async (sid, name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, sid);
  writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
};
let failed = false;
const check = (ok, label) => {
  console.log(`${ok ? "✔" : "✘"} ${label}`);
  if (!ok) failed = true;
};

try {
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.endsWith("/src/background.js"));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(200);
  }
  const open = async (path) => {
    const { targetId } = await send("Target.createTarget", { url: `chrome-extension://${extId}/${path}` });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await sleep(1200);
    return sessionId;
  };

  const rec = await open("src/app/gravar.html?test=1");
  await shot(rec, "recorder-setup.png");
  check(await evalIn(rec, `document.getElementById("title").value.startsWith("Huddle no Slack")`), "título padrão do huddle");

  // Botão "Testar o modelo": transcreve o trecho de referência embutido.
  await evalIn(rec, `document.getElementById("model").value = "base"; document.getElementById("test").click()`);
  let testOut = "";
  for (let i = 0; i < 180 && !/Funcionando|Não transcreveu|Falhou/.test(testOut); i++) {
    await sleep(1000);
    testOut = await evalIn(rec, `document.getElementById("test-out").textContent`);
  }
  console.log("  " + testOut);
  check(testOut.startsWith("Funcionando") && (await evalIn(rec, `!document.getElementById("start").disabled`)), "testar o modelo no gravador");

  // Áudio do sistema simulado: toca o WAV num AudioContext e entrega como getDisplayMedia.
  const b64 = readFileSync(systemWav).toString("base64");
  await evalIn(rec, `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    navigator.mediaDevices.getDisplayMedia = async () => {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
      const src = ctx.createBufferSource(); src.buffer = buf;
      const dest = ctx.createMediaStreamDestination(); src.connect(dest); src.start();
      const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 36 });
      canvas.getContext("2d").fillRect(0, 0, 64, 36);
      return new MediaStream([...canvas.captureStream(1).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    };
    document.getElementById("model").value = "base";
    document.getElementById("start").click();
    return true;
  })()`);
  await sleep(3000);
  check(await evalIn(rec, `!document.getElementById("live").hidden`), "gravação começou");

  // Espera a fala do sistema (0–22 s) e a do microfone (26–40 s) serem transcritas.
  let blocks = [];
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    blocks = await evalIn(rec, `[...document.querySelectorAll("#feed .blk")].map((b) => b.querySelector(".who").firstChild.textContent)`);
    if (blocks.includes("Participantes") && blocks.includes("Você") && i > 40) break;
  }
  await shot(rec, "recorder-live.png");
  check(blocks.includes("Participantes"), "fala do áudio do computador atribuída a Participantes");
  check(blocks.includes("Você"), "fala do microfone atribuída a Você");

  // Pausar pelo botão e retomar
  await evalIn(rec, `document.getElementById("pause").click()`);
  await sleep(600);
  check(await evalIn(rec, `document.body.classList.contains("paused")`), "pausa");
  await evalIn(rec, `document.getElementById("pause").click()`);
  await sleep(600);

  await evalIn(rec, `document.getElementById("stop").click()`);
  for (let i = 0; i < 60 && !(await evalIn(rec, `!document.getElementById("done").hidden`)); i++) await sleep(500);
  check(await evalIn(rec, `!document.getElementById("done").hidden`), "parar e salvar");
  await shot(rec, "recorder-done.png");

  const session = await evalIn(rec, `chrome.runtime.sendMessage({ type: "list" }).then((l) => chrome.runtime.sendMessage({ type: "get", id: l[0].id }))`);
  check(session.platform === "slack" && session.recorder && session.endedAt, "sessão salva como Slack e encerrada");
  console.log(session.asr.map((a) => `  [${a.source}] ${a.text}`).join("\n"));
  check(session.asr.some((a) => a.source === "system") && session.asr.some((a) => a.source === "mic"), "trechos das duas fontes");

  const app = await open(`src/app/app.html?id=${session.id}`);
  await sleep(800);
  await shot(app, "recorder-app.png");
  check((await evalIn(app, `document.getElementById("m-meta").textContent`)).includes("Slack"), "app mostra a plataforma Slack");
  check(await evalIn(app, `document.getElementById("m-hq").hidden`), "botão de alta precisão oculto no gravador");
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  chrome.kill();
}
process.exit(failed ? 1 : 0);
