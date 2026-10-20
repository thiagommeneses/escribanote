// Tokens aleatórios, hash de tokens e criptografia dos documentos das reuniões.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(String(token)).digest();

// Documento -> JSON -> gzip -> AES-256-GCM. Formato gravado: iv (12) | tag (16) | conteúdo.
export function createSealer(keyBase64) {
  const key = Buffer.from(keyBase64 || "", "base64");
  if (key.length !== 32) throw new Error("DATA_KEY precisa ter 32 bytes em base64");
  return {
    keyVersion: 1,
    seal(obj) {
      const json = Buffer.from(JSON.stringify(obj));
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(gzipSync(json)), cipher.final()]);
      return { data: Buffer.concat([iv, cipher.getAuthTag(), body]), size: json.length };
    },
    open(buf) {
      const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(12, 28));
      const zipped = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
      return JSON.parse(gunzipSync(zipped).toString());
    },
  };
}
