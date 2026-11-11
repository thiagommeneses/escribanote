-- Transcrição de áudio no servidor (Groq): quanto áudio cada trabalho já mandou, para limitar ao que foi pago.
ALTER TABLE ai_requests ADD COLUMN IF NOT EXISTS audio_ms bigint NOT NULL DEFAULT 0;
