// Backup automático numa pasta do computador (File System Access API).
// A pasta escolhida fica guardada no IndexedDB da extensão e é usada pelo service worker
// e pelas páginas. Cada reunião vira um arquivo JSON no mesmo formato do "Exportar backup";
// os arquivos sobrevivem a remover a extensão e podem ir para outro computador (ex.: OneDrive).

const DB_NAME = "escriba"; // nome antigo do produto: mantido para não perder a pasta já escolhida
const STORE = "kv";
const DIR_KEY = "backupDir";
export const BACKUP_FOLDER = "Escribanote";
export const SETTINGS_FILE = "escribanote-ajustes.json";

function openDb() {
  return new Promise((ok, fail) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => ok(req.result);
    req.onerror = () => fail(req.error);
  });
}

async function kv(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((ok, fail) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => ok(req.result);
      tx.onerror = () => fail(tx.error);
    });
  } finally {
    db.close();
  }
}

export const getBackupDir = () => kv("readonly", (st) => st.get(DIR_KEY)).catch(() => null);
export const setBackupDir = (dir) => kv("readwrite", (st) => (dir ? st.put(dir, DIR_KEY) : st.delete(DIR_KEY)));

// "granted", "prompt" ou "denied". Pedir (ask) só funciona numa página, durante um clique.
export async function backupPermission(dir, ask = false) {
  const opts = { mode: "readwrite" };
  let state = await dir.queryPermission(opts);
  if (state !== "granted" && ask) state = await dir.requestPermission(opts);
  return state;
}

// Quem escolhe uma pasta qualquer (ex.: Documentos) ganha uma subpasta "Escribanote" dentro dela.
// As pastas "Escriba" e "Reunilo" (nomes antigos do produto) continuam valendo.
export async function resolveBackupFolder(picked) {
  return [BACKUP_FOLDER, "Escriba", "Reunilo"].includes(picked.name) ? picked : picked.getDirectoryHandle(BACKUP_FOLDER, { create: true });
}

const pad = (n) => String(n).padStart(2, "0");
// Nome estável (não muda se o título mudar): data de início + id.
export function backupFileName(s) {
  const d = new Date(s.startedAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}_${s.id}.json`;
}

async function writeJson(dir, name, data) {
  const file = await dir.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(JSON.stringify(data, null, 1));
  await w.close();
}

export function writeSessionFile(dir, s) {
  return writeJson(dir, backupFileName(s), { app: "escribanote", version: 2, exportedAt: Date.now(), sessions: [s] });
}

export async function removeSessionFile(dir, id) {
  for await (const [name] of dir.entries()) {
    if (name.endsWith(`_${id}.json`)) await dir.removeEntry(name).catch(() => {});
  }
}

export function writeSettingsFile(dir, settings) {
  return writeJson(dir, SETTINGS_FILE, { app: "escribanote", version: 2, exportedAt: Date.now(), settings });
}

// Lê todos os .json da pasta: arquivos do backup automático, do "Exportar backup" e de ajustes.
// Se a mesma reunião aparece em mais de um arquivo, fica a versão mais recente.
export async function readBackupFolder(dir) {
  const byId = new Map();
  let settings = null;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file" || !name.toLowerCase().endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(await (await handle.getFile()).text());
    } catch {
      continue;
    }
    if (data && data.settings && !data.sessions) settings = data.settings;
    const list = Array.isArray(data) ? data : Array.isArray(data?.sessions) ? data.sessions : [];
    for (const s of list) {
      if (!s || !s.id || !Array.isArray(s.entries)) continue;
      const prev = byId.get(s.id);
      if (!prev || (s.updatedAt || 0) > (prev.updatedAt || 0)) byId.set(s.id, s);
    }
  }
  return { sessions: [...byId.values()], settings };
}

// ---------- Exportação em pasta legível (uma pasta por reunião) ----------
// Dentro da pasta de backup já autorizada, a subpasta "Reuniões" recebe, para cada reunião encerrada,
// "AAAA-MM-DD HHMM Título/" com transcricao.md, reuniao.json (manifesto) e o áudio guardado, quando
// houver. É o que scripts externos devem observar; o JSON de backup continua sendo o formato de
// restauração. Ver docs/exportacao-em-pasta.md.
export const EXPORT_FOLDER = "Reuniões";
const safeName = (t) => String(t || "Reunião").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().replace(/\.+$/, "").slice(0, 80) || "Reunião";
export function exportFolderName(s) {
  const d = new Date(s.startedAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${safeName(s.title)}`;
}
async function writeFileIn(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
export function meetingManifest(s, { participants = [], audioFiles = [], version = "" } = {}) {
  const clock = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, "0")).join(":"); };
  return {
    app: "escribanote",
    versao: 1,
    escribanote: version,
    id: s.id,
    titulo: s.title,
    plataforma: s.platform,
    inicio: new Date(s.startedAt).toISOString(),
    fim: s.endedAt ? new Date(s.endedAt).toISOString() : null,
    duracaoSegundos: Math.max(0, Math.round(((s.endedAt || s.updatedAt) - s.startedAt) / 1000)),
    idioma: s.uiLang || null,
    participantes: participants,
    falas: s.entries.length,
    trechosWhisper: (s.asr || []).length,
    modeloWhisper: s.audio?.model || null,
    capitulos: (s.chapters || []).map((c) => ({ inicio: clock(c.startAt - s.startedAt), titulo: c.title })),
    temAta: !!(s.summary && s.summary.text),
    audio: audioFiles,
    exportadoEm: new Date().toISOString(),
  };
}
// Grava (ou regrava) a pasta da reunião. `markdown` já vem pronto; `audio` é [{name, file}].
export async function writeMeetingFolder(root, s, { markdown, manifest, audio = [] }) {
  const base = await root.getDirectoryHandle(EXPORT_FOLDER, { create: true });
  const name = exportFolderName(s);
  const dir = await base.getDirectoryHandle(name, { create: true });
  await writeFileIn(dir, "transcricao.md", markdown);
  await writeFileIn(dir, "reuniao.json", JSON.stringify(manifest, null, 2));
  for (const a of audio) {
    // só copia se ainda não existe com o mesmo tamanho (o áudio não muda depois de encerrado)
    const existing = await dir.getFileHandle(a.name).then((h) => h.getFile()).catch(() => null);
    if (existing && existing.size === a.file.size) continue;
    await writeFileIn(dir, a.name, a.file);
  }
  return name;
}
export async function removeMeetingFolder(root, name) {
  if (!name) return;
  const base = await root.getDirectoryHandle(EXPORT_FOLDER).catch(() => null);
  if (base) await base.removeEntry(name, { recursive: true }).catch(() => {});
}

// Área interna do Chrome (Origin Private File System): pasta "backup" privada da extensão,
// gravada no disco dentro do perfil. Não pede permissão nem pasta; some se a extensão for removida.
export async function internalBackupDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("backup", { create: true });
}

// Conteúdo de um arquivo de backup de reunião (mesmo formato do "Exportar backup").
export const sessionFileText = (s) => JSON.stringify({ app: "escribanote", version: 2, exportedAt: Date.now(), sessions: [s] }, null, 1);
export const settingsFileText = (settings) => JSON.stringify({ app: "escribanote", version: 2, exportedAt: Date.now(), settings }, null, 1);
