-- Aviso por e-mail perto do fim do teste grátis: uma vez só por assinatura de teste.
ALTER TABLE subscriptions ADD COLUMN trial_reminder_at timestamptz;
