-- Senha (opcional): quem tem senha entra com e-mail + senha; o link mágico continua valendo.
-- password_hash: "scrypt$N$r$p$salt$hash" (base64url). Nulo = conta só com link.
ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE users ADD COLUMN password_set_at timestamptz;

-- O mesmo token por e-mail serve para entrar (login) e para definir/redefinir a senha (password).
ALTER TABLE login_tokens ADD COLUMN purpose text NOT NULL DEFAULT 'login' CHECK (purpose IN ('login', 'password'));
