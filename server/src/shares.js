// Links públicos só de leitura: criar, listar, revogar e a página /s/{token}.
import { audit } from "./auth.js";
import { hashToken, newToken } from "./crypto.js";
import { clientIp, fail, iso } from "./http.js";
import { clock, DEFAULT_TAGS, mdToHtml, participantNames, PLATFORM, toBlocks } from "./lib.js";
import { loadDoc, requirePro } from "./meetings.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function registerShares(app, { db, config, sealer, limiter }) {
  const auth = { preHandler: app.authenticate };
  const view = (r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    includeTranscript: r.include_transcript,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    revoked: !!r.revoked_at,
    views: r.views,
  });

  app.post("/api/v1/shares", auth, async (req) => {
    await requirePro(db, req.user.id);
    const meetingId = String(req.body?.meetingId || "");
    await loadDoc(db, sealer, req.user.id, meetingId); // existe e é do usuário
    const days = Math.min(Math.max(Number(req.body?.days) || 30, 1), 365);
    const token = newToken(18);
    const row = await db.one(
      `INSERT INTO shares (id, token_hash, user_id, meeting_id, include_transcript, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING *`,
      [newToken(9), hashToken(token), req.user.id, meetingId, req.body?.includeTranscript !== false, String(days)],
    );
    await audit(db, req.user.id, "share_create", { meetingId, days }, clientIp(req));
    // O token só aparece agora: o banco guarda apenas o hash.
    return { ...view(row), url: `${config.publicUrl}/s/${token}` };
  });

  app.get("/api/v1/shares", auth, async (req) => {
    const rows = await db.many("SELECT * FROM shares WHERE user_id = $1 AND meeting_id = $2 ORDER BY created_at DESC", [
      req.user.id,
      String(req.query?.meetingId || ""),
    ]);
    return { items: rows.map(view) };
  });

  app.delete("/api/v1/shares/:id", auth, async (req) => {
    const r = await db.query("UPDATE shares SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [req.params.id, req.user.id]);
    if (!r.rowCount) fail(404, "not_found", "Link não encontrado.");
    return { ok: true };
  });

  app.get("/s/:token", async (req, reply) => {
    reply
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      .header("x-robots-tag", "noindex, nofollow")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, no-store")
      .type("text/html; charset=utf-8");
    if (!limiter.take(`share-ip:${clientIp(req)}`, 120, 60_000)) return reply.code(429).send(page("Muitos acessos", "<p>Tente de novo em um minuto.</p>"));
    const s = await db.one(
      `UPDATE shares SET views = views + 1 WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
       RETURNING user_id, meeting_id, include_transcript, expires_at`,
      [hashToken(req.params.token)],
    );
    let doc = null;
    if (s) doc = await loadDoc(db, sealer, s.user_id, s.meeting_id).then((r) => r.doc).catch(() => null);
    if (!doc) return reply.code(404).send(page("Link indisponível", "<p>Este link expirou, foi revogado ou a reunião foi apagada.</p>"));
    return reply.send(renderMeeting(doc, s));
  });
}

function renderMeeting(doc, share) {
  const tags = DEFAULT_TAGS;
  const blocks = toBlocks(doc, { includeChat: false });
  const t0 = doc.startedAt;
  const who = participantNames(doc);
  const when = new Date(doc.startedAt).toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Sao_Paulo" });
  const dur = doc.endedAt ? Math.round((doc.endedAt - doc.startedAt) / 60000) : null;
  const tagLabel = (id) => {
    const t = tags.find((x) => x.id === id);
    return t ? `${t.emoji} ${t.label}` : id;
  };
  const hl = blocks.filter((b) => b.tags.length);
  let body = `<header><p class="eyebrow">${esc(PLATFORM[doc.platform] || "Reunião")} · ${esc(when)}${dur ? ` · ${dur} min` : ""}</p>
    <h1>${esc(doc.title)}</h1>${who.length ? `<p class="who">${esc(who.join(", "))}</p>` : ""}</header>`;
  if (doc.summary?.text) body += `<section><h2>Ata</h2><div class="ata">${mdToHtml(doc.summary.text)}</div></section>`;
  if (hl.length) {
    body += `<section><h2>Destaques</h2><ul class="hl">${hl
      .map((b) => `<li><span class="tag">${esc(b.tags.map(tagLabel).join(" "))}</span> <b>${esc(b.speaker)}</b>: ${esc(b.text)}</li>`)
      .join("")}</ul></section>`;
  }
  if (share.include_transcript && blocks.length) {
    body += `<section><h2>Transcrição</h2>${blocks
      .map((b) => `<div class="blk"><p class="meta"><b>${esc(b.speaker)}</b> <time>${clock(b.startAt - t0)}</time></p><p>${esc(b.text)}</p></div>`)
      .join("")}</section>`;
  }
  const until = new Date(share.expires_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  body += `<footer>Compartilhado pelo <a href="https://escribanote.com">Escribanote</a>. Este link vale até ${esc(until)}.</footer>`;
  return page(doc.title, body);
}

function page(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)} · Escribanote</title><style>
:root{--bg:#f7f5f0;--fg:#1f1b16;--muted:#6f675d;--line:#e4ded3;--accent:#c8442a;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#16130f;--fg:#f1ece4;--muted:#a59c90;--line:#332d26;--accent:#ef7a5e;--card:#1e1a15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 "Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px max(16px,env(safe-area-inset-left)) 64px}
.eyebrow{color:var(--accent);font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin:0}
h1{font-size:clamp(26px,5vw,36px);line-height:1.15;margin:8px 0;text-wrap:balance}.who{color:var(--muted);margin:0}
section{margin-top:36px;padding-top:24px;border-top:1px solid var(--line)}h2{font-size:20px;margin:0 0 12px}h3{font-size:16px;margin:18px 0 6px}
.ata ul,.hl{padding-left:20px}.tag{font-size:13px;color:var(--muted)}.blk{margin:0 0 14px}.blk p{margin:0}
.meta{font-size:14px}.meta time{color:var(--muted);font-variant-numeric:tabular-nums;margin-left:6px}
footer{margin-top:48px;color:var(--muted);font-size:13px}a{color:var(--accent)}
</style></head><body><main>${body}</main></body></html>`;
}
