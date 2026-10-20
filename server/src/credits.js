// Créditos de IA: concessão por ciclo (com teto), reserva atômica e devolução.
import { fail, iso } from "./http.js";

// Concede os créditos de um ciclo pago. `ref` (id da fatura) garante que cada ciclo conta uma vez só.
export async function grantCycle(db, userId, ref, renewsAt, { perCycle, max }) {
  return db.tx(async (c) => {
    const inserted = await c.one(
      `INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES ($1, 0, 'grant', $2)
       ON CONFLICT (user_id, ref) WHERE reason = 'grant' DO NOTHING RETURNING id`,
      [userId, ref],
    );
    if (!inserted) return null;
    const row = await c.one(
      `INSERT INTO credit_balances (user_id, balance, renews_at) VALUES ($1, LEAST($2::int, $3::int), $4)
       ON CONFLICT (user_id) DO UPDATE SET balance = LEAST(credit_balances.balance + $2::int, $3::int), renews_at = $4, updated_at = now()
       RETURNING balance`,
      [userId, perCycle, max, renewsAt],
    );
    await c.query("UPDATE credit_ledger SET delta = $2 WHERE id = $1", [inserted.id, perCycle]);
    return row.balance;
  });
}

export async function reserve(db, userId, n, ref) {
  if (n <= 0) return balanceOf(db, userId);
  return db.tx(async (c) => {
    const row = await c.one(
      "UPDATE credit_balances SET balance = balance - $2, updated_at = now() WHERE user_id = $1 AND balance >= $2 RETURNING balance, renews_at",
      [userId, n],
    );
    if (!row) {
      const cur = await c.one("SELECT balance, renews_at FROM credit_balances WHERE user_id = $1", [userId]);
      const when = cur?.renews_at ? new Date(cur.renews_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : null;
      fail(402, "no_credits", `Seus créditos de IA acabaram${when ? `. Eles renovam em ${when}` : ""}. Você pode usar a sua própria chave de API em Ajustes.`, {
        balance: cur?.balance ?? 0,
        needed: n,
        renewsAt: iso(cur?.renews_at),
      });
    }
    await c.query("INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'use', $3)", [userId, -n, ref]);
    return row.balance;
  });
}

export async function refund(db, userId, n, ref) {
  if (n <= 0) return balanceOf(db, userId);
  return db.tx(async (c) => {
    const row = await c.one("UPDATE credit_balances SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance", [userId, n]);
    await c.query("INSERT INTO credit_ledger (user_id, delta, reason, ref) VALUES ($1, $2, 'refund', $3)", [userId, n, ref]);
    return row?.balance ?? 0;
  });
}

export async function balanceOf(db, userId) {
  return (await db.one("SELECT balance FROM credit_balances WHERE user_id = $1", [userId]))?.balance ?? 0;
}
