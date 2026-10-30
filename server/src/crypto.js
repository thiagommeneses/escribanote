// Tokens aleatórios, hash de tokens e criptografia dos documentos das reuniões.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(String(token)).digest();

// Senhas: scrypt (nativo do Node, sem dependências). Formato: scrypt$N$r$p$salt$hash, em base64url.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scryptAsync = (pw, salt, keylen, opts) =>
  new Promise((ok, fail) => scrypt(pw, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? fail(err) : ok(key))));

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(String(password).normalize("NFKC"), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const key = await scryptAsync(String(password).normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return key.length === want.length && timingSafeEqual(key, want);
}

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
