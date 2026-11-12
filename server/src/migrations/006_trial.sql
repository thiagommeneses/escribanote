-- Teste grátis do Pro (48 h, sem cartão): uma vez por e-mail. Guarda só o hash SHA-256 do e-mail, que fica
-- mesmo se a conta for apagada, para o teste não ser repetido apagando e recriando a conta.
CREATE TABLE trial_claims (
  email_hash  text PRIMARY KEY,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);
