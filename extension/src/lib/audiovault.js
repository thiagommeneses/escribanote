// Cofre de áudio: as faixas gravadas (aba/computador e microfone) ficam na área privada da extensão
// (Origin Private File System), uma pasta por reunião: audio/<id>/{tab|mic|system}.webm + meta.json.
// Nada sai do computador; o backup em arquivos e a sincronização Pro ignoram o áudio.
// Quem grava (offscreen, gravador) usa createTrackWriter; o painel lê com readTrack; o service worker
// apaga, lista e aplica cota e retenção.
const ROOT = "audio";

async function root(create) {
  const r = await navigator.storage.getDirectory();
  return r.getDirectoryHandle(ROOT, { create: !!create }).catch(() => null);
}
export async function sessionAudioDir(id, create = false) {
  const r = await root(create);
  if (!r) return null;
  return r.getDirectoryHandle(String(id), { create }).catch(() => null);
}

// Grava pedaços conforme chegam, cada um durável por si (abre, anexa no fim, fecha): se o navegador
// fechar no meio, o que já foi escrito fica.
export function createTrackWriter(id, source) {
  const name = `${source}.webm`;
  let bytes = 0;
  let chain = Promise.resolve();
  const write = (blob) => {
    chain = chain.then(async () => {
      const dir = await sessionAudioDir(id, true);
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable({ keepExistingData: true });
      await w.seek(bytes);
      await w.write(blob);
      await w.close();
      bytes += blob.size;
    }).catch(() => {});
    return chain;
  };
  return { write, close: () => chain, get bytes() { return bytes; } };
}

export async function writeMeta(id, meta) {
  const dir = await sessionAudioDir(id, true);
  const fh = await dir.getFileHandle("meta.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(meta));
  await w.close();
}
export async function readMeta(id) {
  const dir = await sessionAudioDir(id);
  if (!dir) return null;
  try {
    const f = await (await dir.getFileHandle("meta.json")).getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

export async function readTrack(id, source) {
  const dir = await sessionAudioDir(id);
  if (!dir) return null;
  try {
    return await (await dir.getFileHandle(`${source}.webm`)).getFile();
  } catch {
    return null;
  }
}

export async function audioInfo(id) {
  const dir = await sessionAudioDir(id);
  if (!dir) return null;
  const tracks = [];
  let bytes = 0;
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file" || !name.endsWith(".webm")) continue;
    const f = await h.getFile();
    tracks.push({ source: name.replace(/\.webm$/, ""), bytes: f.size });
    bytes += f.size;
  }
  return tracks.length ? { tracks, bytes, meta: await readMeta(id) } : null;
}

export async function deleteAudio(id) {
  const r = await root(false);
  if (!r) return false;
  await r.removeEntry(String(id), { recursive: true }).catch(() => {});
  return true;
}

export async function listAudio() {
  const r = await root(false);
  if (!r) return [];
  const out = [];
  for await (const [id, h] of r.entries()) {
    if (h.kind !== "directory") continue;
    const info = await audioInfo(id);
    if (info) out.push({ id, bytes: info.bytes, startedAt: info.meta?.startedAt || 0, keep: !!info.meta?.keep });
  }
  return out;
}

export async function vaultUsage() {
  const list = await listAudio();
  return { bytes: list.reduce((a, x) => a + x.bytes, 0), count: list.length };
}

// Decide o que apagar: primeiro o que passou da retenção, depois as mais antigas até caber na cota.
// Reuniões marcadas "manter" e as em `protect` (em andamento) ficam. Função pura, testável.
export function planEviction(items, { limitBytes, retentionMs, now = Date.now(), protect = new Set() }) {
  const victims = new Set();
  const can = (x) => !x.keep && !protect.has(x.id);
  if (retentionMs > 0) for (const x of items) if (can(x) && x.startedAt && now - x.startedAt > retentionMs) victims.add(x.id);
  let total = items.filter((x) => !victims.has(x.id)).reduce((a, x) => a + x.bytes, 0);
  if (limitBytes > 0) {
    for (const x of [...items].filter((x) => !victims.has(x.id) && can(x)).sort((a, b) => a.startedAt - b.startedAt)) {
      if (total <= limitBytes) break;
      victims.add(x.id);
      total -= x.bytes;
    }
  }
  return [...victims];
}

export async function enforceQuota(opts) {
  const items = await listAudio();
  const ids = planEviction(items, opts);
  for (const id of ids) await deleteAudio(id);
  return ids;
}
