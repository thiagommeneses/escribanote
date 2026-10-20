// Backup automático numa pasta do computador (File System Access API).
// A pasta escolhida fica guardada no IndexedDB da extensão e é usada pelo service worker
// e pelas páginas. Cada reunião vira um arquivo JSON no mesmo formato do "Exportar backup";
// os arquivos sobrevivem a remover a extensão e podem ir para outro computador (ex.: OneDrive).

const DB_NAME = "escriba"; // nome antigo do produto: mantido para não perder a pasta já escolhida
const STORE = "kv";
const DIR_KEY = "backupDir";
export const BACKUP_FOLDER = "Reunilo";
export const SETTINGS_FILE = "reunilo-ajustes.json";

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

// Quem escolhe uma pasta qualquer (ex.: Documentos) ganha uma subpasta "Reunilo" dentro dela.
// A pasta "Escriba" (nome antigo do produto) continua valendo.
export async function resolveBackupFolder(picked) {
  return [BACKUP_FOLDER, "Escriba"].includes(picked.name) ? picked : picked.getDirectoryHandle(BACKUP_FOLDER, { create: true });
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
  return writeJson(dir, backupFileName(s), { app: "reunilo", version: 2, exportedAt: Date.now(), sessions: [s] });
}

export async function removeSessionFile(dir, id) {
  for await (const [name] of dir.entries()) {
    if (name.endsWith(`_${id}.json`)) await dir.removeEntry(name).catch(() => {});
  }
}

export function writeSettingsFile(dir, settings) {
  return writeJson(dir, SETTINGS_FILE, { app: "reunilo", version: 2, exportedAt: Date.now(), settings });
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
