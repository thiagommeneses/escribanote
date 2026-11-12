// Avisos por e-mail perto do fim do teste grátis do Pro. Roda de tempos em tempos (index.js); cada teste recebe
// um aviso só: a linha é marcada no mesmo UPDATE que a escolhe, então duas rodadas juntas não mandam dois e-mails.
import { trialEndingEmail } from "./mail.js";

export async function trialReminders(db, mailer, config, { now = new Date(), log = console } = {}) {
  const hours = config.trial.remindHours;
  const due = await db.query(
    `UPDATE subscriptions s SET trial_reminder_at = $1
       FROM users u
      WHERE u.id = s.user_id AND s.status = 'trial' AND s.trial_reminder_at IS NULL
        AND s.current_period_end > $1 AND s.current_period_end <= $1::timestamptz + make_interval(hours => $2::int)
      RETURNING u.email, s.current_period_end`,
    [now, hours],
  );
  let sent = 0;
  for (const r of due.rows) {
    const left = Math.max(1, Math.round((new Date(r.current_period_end) - now) / 3600_000));
    try {
      await mailer.send({ to: r.email, ...trialEndingEmail(`${config.publicUrl}/app/#/conta?plano=anual&moeda=brl`, left) });
      sent++;
    } catch (err) {
      log.error?.({ err }, "aviso do fim do teste");
    }
  }
  return sent;
}
