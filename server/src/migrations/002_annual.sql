-- Plano anual: guarda o intervalo da cobrança e o início do período, para conceder os créditos todo mês
-- mesmo quando a fatura é uma vez por ano.
ALTER TABLE subscriptions ADD COLUMN billing_interval text;
ALTER TABLE subscriptions ADD COLUMN current_period_start timestamptz;
