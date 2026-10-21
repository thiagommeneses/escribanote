-- Esquema inicial do Escribanote Pro.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Busca em português sem acento ("reuniao" acha "reunião").
CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION pt_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,            -- sempre em minúsculas
  name        text,
  country     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Links mágicos de login: só o hash do token é guardado.
CREATE TABLE login_tokens (
  token_hash  bytea PRIMARY KEY,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text
);
CREATE INDEX login_tokens_email ON login_tokens (email, created_at DESC);

-- Sessões do app web (kind = 'web') e tokens da extensão (kind = 'device').
CREATE TABLE auth_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('web', 'device')),
  token_hash    bytea NOT NULL UNIQUE,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

-- Reuniões: o documento completo (o mesmo JSON da extensão) vai comprimido e criptografado em `doc`.
CREATE TABLE meetings (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          text NOT NULL,
  title       text NOT NULL DEFAULT '',
  platform    text,
  started_at  timestamptz,
  ended_at    timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now(),  -- quando o servidor gravou (base do changedSince)
  doc_updated_at timestamptz,                      -- updatedAt do próprio documento
  version     integer NOT NULL DEFAULT 1,
  deleted_at  timestamptz,
  doc         bytea NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  size        integer NOT NULL DEFAULT 0,           -- bytes do JSON original
  summary     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- metadados para a lista (participantes, contagens)
  tsv         tsvector,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX meetings_list ON meetings (user_id, started_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX meetings_sync ON meetings (user_id, updated_at);
CREATE INDEX meetings_tsv ON meetings USING gin (tsv);

-- Links públicos de leitura.
CREATE TABLE shares (
  id                 text PRIMARY KEY,
  token_hash         bytea NOT NULL UNIQUE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id         text NOT NULL,
  include_transcript boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  views              integer NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id, meeting_id) REFERENCES meetings (user_id, id) ON DELETE CASCADE
);
CREATE INDEX shares_meeting ON shares (user_id, meeting_id);

-- Assinatura (uma por usuário).
CREATE TABLE subscriptions (
  user_id                 uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  status                  text NOT NULL DEFAULT 'none',
  currency                text,
  price_id                text,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  payment_method          text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Créditos de IA: saldo e histórico.
CREATE TABLE credit_balances (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance     integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  renews_at   timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       integer NOT NULL,
  reason      text NOT NULL,       -- grant, use, refund
  ref         text,                -- fatura da Stripe ou id da chamada de IA
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credit_ledger_grant_once ON credit_ledger (user_id, ref) WHERE reason = 'grant';

-- Cada chamada à IA inclusa: base do custo, do teto diário e de auditoria.
CREATE TABLE ai_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  meeting_id    text,
  kind          text NOT NULL,
  model         text NOT NULL,
  credits       integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'running',  -- running, done, failed
  input_tokens  integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer,
  cost_usd      numeric(10, 5) NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX ai_requests_day ON ai_requests (created_at);
CREATE INDEX ai_requests_review ON ai_requests (user_id, meeting_id, kind, created_at DESC);

-- Idempotência dos webhooks da Stripe.
CREATE TABLE stripe_events (
  id            text PRIMARY KEY,
  type          text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Ações sensíveis (login, dispositivo, compartilhamento, exportação, exclusão).
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid,
  action      text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
