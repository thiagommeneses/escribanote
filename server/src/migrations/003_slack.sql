-- Integração com o Slack: workspace conectado por usuário (token do bot cifrado), canal padrão,
-- atas publicadas (para responder perguntas no thread) e deduplicação de eventos.
CREATE TABLE slack_installations (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  team_id      text NOT NULL,
  team_name    text,
  bot_user_id  text,
  token        bytea NOT NULL,                    -- {token} cifrado com a DATA_KEY
  key_version  smallint NOT NULL DEFAULT 1,
  channel_id   text,
  channel_name text,
  auto         boolean NOT NULL DEFAULT false,    -- publicar a ata sozinho quando a reunião termina
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slack_installations_team ON slack_installations (team_id);

CREATE TABLE slack_oauth_states (
  state       text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_posts (
  team_id     text NOT NULL,
  channel_id  text NOT NULL,
  ts          text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, channel_id, ts)
);

CREATE TABLE slack_events (
  event_id    text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now()
);
