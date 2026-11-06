// Mescla duas versões da mesma reunião (esta extensão e a conta) sem perder falas.
// Listas com id (falas, Whisper, notas, conversas) são unidas; quando o mesmo id existe nos dois lados,
// vence o item atualizado por último. Campos simples (título, ata) vêm do documento alterado por último.

const stamp = (x) => x?.updatedAt ?? x?.end ?? x?.at ?? x?.createdAt ?? x?.start ?? 0;
const order = (x) => x?.at ?? x?.start ?? x?.createdAt ?? 0;

function unionById(a = [], b = []) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    if (!item || item.id == null) continue;
    const prev = map.get(item.id);
    if (!prev || stamp(item) >= stamp(prev)) map.set(item.id, item);
  }
  return [...map.values()].sort((x, y) => order(x) - order(y));
}

// Conversas: vence a alterada por último (updatedAt, gravado ao perguntar, editar ou reenviar);
// sem essa marca nos dois lados, a mais longa. As excluídas (deletedChats) não voltam da outra cópia.
function unionChats(a = [], b = [], deleted = []) {
  const gone = new Set(deleted.map((d) => d.id));
  const map = new Map();
  for (const c of [...a, ...b]) {
    if (!c || gone.has(c.id)) continue;
    const prev = map.get(c.id);
    const newer = prev && c.updatedAt && prev.updatedAt ? c.updatedAt > prev.updatedAt : (c.messages?.length || 0) > (prev?.messages?.length || 0);
    if (!prev || newer) map.set(c.id, c);
  }
  return [...map.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
}

export function mergeDocs(local, remote) {
  if (!remote) return local;
  if (!local) return remote;
  const localNewer = (local.updatedAt || 0) >= (remote.updatedAt || 0);
  const newer = localNewer ? local : remote;
  const older = localNewer ? remote : local;
  const out = structuredClone(newer);
  out.entries = unionById(older.entries, newer.entries);
  out.asr = unionById(older.asr, newer.asr);
  out.deletedChats = unionById(older.deletedChats, newer.deletedChats).filter((d) => ![...(older.chats || []), ...(newer.chats || [])].some((c) => c.id === d.id && (c.updatedAt || 0) > (d.at || 0))).slice(-200);
  out.chats = unionChats(older.chats, newer.chats, out.deletedChats);
  out.notes = {
    text: newer.notes?.text || older.notes?.text || "",
    items: unionById(older.notes?.items, newer.notes?.items),
  };
  for (const k of ["speakers", "aliases", "merged", "fixes", "reviewed", "highlights", "voices"]) out[k] = { ...(older[k] || {}), ...(newer[k] || {}) };
  out.langs = { ...(older.langs || {}) };
  for (const [k, v] of Object.entries(newer.langs || {})) out.langs[k] = Math.max(out.langs[k] || 0, v);
  out.summary = newer.summary ?? older.summary ?? null;
  out.summaryHistory = unionById(older.summaryHistory, newer.summaryHistory).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((v, i) => ({ ...v, n: i + 1 }));
  out.ataTemplateId = newer.ataTemplateId ?? older.ataTemplateId ?? null;
  out.ataPrompt = newer.ataPrompt ?? older.ataPrompt ?? "";
  out.endedAt = newer.endedAt ?? older.endedAt ?? null;
  out.shots = local.shots || []; // capturas de tela só existem no computador
  out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
  return out;
}

// Mudou algo que vale enviar? (compara o que importa, sem as capturas locais)
export function sameContent(a, b) {
  const pick = (d) => JSON.stringify({ ...d, shots: undefined, updatedAt: undefined });
  return pick(a) === pick(b);
}
