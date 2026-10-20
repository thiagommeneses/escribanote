// Acesso ao Postgres e migrações (arquivos .sql em src/migrations, aplicados em ordem, uma vez cada).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

export function createDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = {
    pool,
    query: (text, params) => pool.query(text, params),
    async one(text, params) {
      const { rows } = await pool.query(text, params);
      return rows[0] || null;
    },
    async many(text, params) {
      return (await pool.query(text, params)).rows;
    },
    // Executa fn(client) numa transação; o client tem os mesmos one/many/query.
    async tx(fn) {
      const client = await pool.connect();
      const c = {
        query: (t, p) => client.query(t, p),
        one: async (t, p) => (await client.query(t, p)).rows[0] || null,
        many: async (t, p) => (await client.query(t, p)).rows,
      };
      try {
        await client.query("BEGIN");
        const out = await fn(c);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

export async function migrate(db, dir = new URL("./migrations/", import.meta.url).pathname) {
  await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.many("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(join(dir, f), "utf8");
    await db.tx(async (c) => {
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    });
    applied.push(f);
  }
  return applied;
}
