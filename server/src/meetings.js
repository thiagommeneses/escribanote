// Reuniões: lista, sincronização com versão otimista, lixeira, busca e exportação.
import { isPro } from "./auth.js";
import { fail, iso } from "./http.js";
import { effectiveEntries, normalize, participantNames, speakerName } from "./lib.js";

const MAX_DOC_BYTES = 8 * 1024 * 1024;
const TRASH_DAYS = 30;
const SEARCH_TEXT_MAX = 400_000; // o tsvector do Postgres tem limite de 1 MB

export async function subscriptionOf(db, userId) {
  return db.one("SELECT status, current_period_end FROM subscriptions WHERE user_id = $1", [userId]);
}

export async function requirePro(db, userId) {
  if (!isPro(await subscriptionOf(db, userId))) {
    fail(402, "pro_required", "Este recurso faz parte do Reunilo Pro.");
  }
}

// Valida e normaliza o documento vindo da extensão ou do app.
export function cleanDoc(doc, id) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail(400, "bad_doc", "Documento inválido.");
  if (id && doc.id !== id) fail(400, "bad_doc", "O id do documento não confere.");
  if (!Array.isArray(doc.entries)) fail(400, "bad_doc", "Documento sem falas.");
  if (typeof doc.id !== "string" || !/^[\w.:-]{1,80}$/.test(doc.id)) fail(400, "bad_doc", "Id inválido.");
  const s = normalize(structuredClone(doc));
  delete s.blocks;
  s.shots = []; // capturas de tela ficam só no computador
  s.title = String(s.title || "Reunião").slice(0, 200);
  return s;
}

const tsOrNull = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms) : null);

// Texto indexado pela busca e metadados mostrados na lista.
export function describe(doc) {
  const entries = effectiveEntries(doc);
  const lines = [doc.title];
  for (const e of entries) if (e.text) lines.push(`${speakerName(doc, e.speakerId)}: ${e.text}`);
  if (doc.notes?.text) lines.push(doc.notes.text);
  for (const n of doc.notes?.items || []) lines.push(n.text || "");
  if (doc.summary?.text) lines.push(doc.summary.text);
  const last = entries.length ? entries[entries.length - 1].updatedAt || entries[entries.length - 1].at : doc.startedAt;
  return {
    searchText: lines.join("\n").slice(0, SEARCH_TEXT_MAX),
    summary: {
      participants: participantNames(doc).slice(0, 30),
      count: entries.length,
      highlights: Object.keys(doc.highlights || {}).length,
      hasSummary: !!doc.summary?.text,
      preview: (doc.summary?.text || "").replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 240),
      durationMs: Math.max(0, (doc.endedAt || last || doc.startedAt) - doc.startedAt) || 0,
      recorder: !!doc.recorder,
    },
  };
}

function listItem(r) {
  return {
    id: r.id,
    title: r.title,
    platform: r.platform,
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
    deleted: !!r.deleted_at,
    deletedAt: iso(r.deleted_at),
    size: r.size,
    ...r.summary,
  };
}

const LIST_COLS = "id, title, platform, started_at, ended_at, updated_at, version, deleted_at, size, summary";

export async function loadDoc(db, sealer, userId, id, { includeDeleted = false } = {}) {
  const r = await db.one("SELECT doc, version, deleted_at, updated_at FROM meetings WHERE user_id = $1 AND id = $2", [userId, id]);
  if (!r || (r.deleted_at && !includeDeleted)) fail(404, "not_found", "Reunião não encontrada.");
  return { doc: sealer.open(r.doc), version: r.version, updatedAt: iso(r.updated_at), deleted: !!r.deleted_at };
}

async function write(c, sealer, userId, doc, { insert, version }) {
  const sealed = sealer.seal(doc);
  if (sealed.size > MAX_DOC_BYTES) fail(413, "too_large", "Esta reunião passou do tamanho máximo (8 MB).");
  const { searchText, summary } = describe(doc);
  const params = [
    userId, doc.id, doc.title, doc.platform || null, tsOrNull(doc.startedAt), tsOrNull(doc.endedAt), tsOrNull(doc.updatedAt),
    sealed.data, sealer.keyVersion, sealed.size, summary, searchText,
  ];
  if (insert) {
    return c.one(
      `INSERT INTO meetings (user_id, id, title, platform, started_at, ended_at, doc_updated_at, doc, key_version, size, summary, tsv, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_tsvector('pt_unaccent', $12), 1)
       RETURNING version, updated_at`,
      params,
    );
  }
  return c.one(
    `UPDATE meetings SET title = $3, platform = $4, started_at = $5, ended_at = $6, doc_updated_at = $7, doc = $8, key_version = $9,
       size = $10, summary = $11, tsv = to_tsvector('pt_unaccent', $12), version = version + 1, updated_at = now()
     WHERE user_id = $1 AND id = $2 AND version = $13 RETURNING version, updated_at`,
    [...params, version],
  );
}

// Grava uma reunião (usado pela rota e pela IA, que salva a ata).
export async function saveMeeting(db, sealer, userId, doc, baseVersion) {
  return db.tx(async (c) => {
    const cur = await c.one("SELECT version, deleted_at FROM meetings WHERE user_id = $1 AND id = $2 FOR UPDATE", [userId, doc.id]);
    if (!cur) {
      const r = await write(c, sealer, userId, doc, { insert: true });
      return { version: r.version, updatedAt: iso(r.updated_at), created: true };
    }
    if (cur.deleted_at) fail(410, "deleted", "Esta reunião foi apagada da conta.", { version: cur.version });
    if (baseVersion !== cur.version) fail(409, "conflict", "A reunião mudou em outro lugar.", { version: cur.version });
    const r = await write(c, sealer, userId, doc, { insert: false, version: cur.version });
    return { version: r.version, updatedAt: iso(r.updated_at), created: false };
  });
}

export function registerMeetings(app, { db, sealer }) {
  const auth = { preHandler: app.authenticate };

  app.get("/api/v1/meetings", auth, async (req) => {
    const { changedSince, cursor, platform } = req.query || {};
    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
    const serverTime = new Date().toISOString();
    if (changedSince) {
      // Sincronização: tudo que mudou (inclusive apagadas) desde o último pedido.
      const since = new Date(changedSince);
      if (Number.isNaN(since.getTime())) fail(400, "bad_request", "Data inválida.");
      const rows = await db.many(`SELECT ${LIST_COLS} FROM meetings WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at LIMIT 1000`, [
        req.user.id,
        since,
      ]);
      return { items: rows.map(listItem), serverTime, more: rows.length === 1000 };
    }
    const params = [req.user.id];
    let where = "user_id = $1 AND deleted_at IS NULL";
    if (platform) where += ` AND platform = $${params.push(String(platform))}`;
    if (cursor) where += ` AND started_at < $${params.push(new Date(cursor))}`;
    const rows = await db.many(`SELECT ${LIST_COLS} FROM meetings WHERE ${where} ORDER BY started_at DESC NULLS LAST LIMIT ${limit}`, params);
    return {
      items: rows.map(listItem),
      nextCursor: rows.length === limit ? iso(rows[rows.length - 1].started_at) : null,
      serverTime,
    };
  });

  app.get("/api/v1/meetings/trash", auth, async (req) => {
    const rows = await db.many(`SELECT ${LIST_COLS} FROM meetings WHERE user_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`, [
      req.user.id,
    ]);
    return { items: rows.map(listItem), keepDays: TRASH_DAYS };
  });

  app.get("/api/v1/meetings/:id", auth, async (req) => loadDoc(db, sealer, req.user.id, req.params.id));

  app.put("/api/v1/meetings/:id", { ...auth, bodyLimit: MAX_DOC_BYTES + 64 * 1024 }, async (req) => {
    await requirePro(db, req.user.id);
    const doc = cleanDoc(req.body?.doc, req.params.id);
    const base = req.body?.baseVersion == null ? null : Number(req.body.baseVersion);
    return saveMeeting(db, sealer, req.user.id, doc, base);
  });

  app.delete("/api/v1/meetings/:id", auth, async (req) => {
    const r = await db.one(
      `UPDATE meetings SET deleted_at = now(), version = version + 1, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING version`,
      [req.user.id, req.params.id],
    );
    if (!r) fail(404, "not_found", "Reunião não encontrada.");
    await db.query("UPDATE shares SET revoked_at = now() WHERE user_id = $1 AND meeting_id = $2 AND revoked_at IS NULL", [req.user.id, req.params.id]);
    return { ok: true, version: r.version };
  });

  app.post("/api/v1/meetings/:id/restore", auth, async (req) => {
    const r = await db.one(
      `UPDATE meetings SET deleted_at = NULL, version = version + 1, updated_at = now()
       WHERE user_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING version`,
      [req.user.id, req.params.id],
    );
    if (!r) fail(404, "not_found", "Reunião não encontrada na lixeira.");
    return { ok: true, version: r.version };
  });

  app.get("/api/v1/search", auth, async (req) => {
    const q = String(req.query?.q || "").trim().slice(0, 200);
    if (!q) return { items: [] };
    const rows = await db.many(
      `SELECT id, title, platform, started_at, doc, ts_rank(tsv, query) AS rank
       FROM meetings, websearch_to_tsquery('pt_unaccent', $2) query
       WHERE user_id = $1 AND deleted_at IS NULL AND tsv @@ query
       ORDER BY rank DESC, started_at DESC LIMIT 20`,
      [req.user.id, q],
    );
    const words = fold(q).split(/\s+/).filter((w) => w.length > 1 && !w.startsWith("-"));
    return {
      items: rows.map((r) => {
        const doc = sealer.open(r.doc);
        return { id: r.id, title: r.title, platform: r.platform, startedAt: iso(r.started_at), ...snippet(doc, words) };
      }),
    };
  });

  app.get("/api/v1/export", auth, async (req, reply) => {
    const rows = await db.many("SELECT doc FROM meetings WHERE user_id = $1 AND deleted_at IS NULL ORDER BY started_at", [req.user.id]);
    reply.header("content-disposition", `attachment; filename="reunilo-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    return { app: "reunilo", version: 2, exportedAt: Date.now(), sessions: rows.map((r) => sealer.open(r.doc)) };
  });
}

const fold = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Primeira fala que contém um dos termos, com o instante para o app pular até ela.
function snippet(doc, words) {
  for (const e of effectiveEntries(doc)) {
    const t = fold(e.text || "");
    const w = words.find((x) => t.includes(x.replace(/^"|"$/g, "")));
    if (!w) continue;
    const i = t.indexOf(w.replace(/^"|"$/g, ""));
    const text = e.text;
    return {
      snippet: (i > 50 ? "…" : "") + text.slice(Math.max(0, i - 50), i + 120) + (i + 120 < text.length ? "…" : ""),
      speaker: speakerName(doc, e.speakerId),
      at: e.at,
      entryId: e.id,
    };
  }
  return { snippet: "", speaker: null, at: null, entryId: null };
}
