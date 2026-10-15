// 凭据加密：AES-256-GCM。每个工作区使用服务端主密钥派生的用户密钥，密文格式与桌面版兼容。
// 格式：版本(1) + IV(12) + 认证标签(16) + 密文。篡改或换了密钥都会在解密时报错。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const VERSION = 1;

export function seal(key: Buffer, plaintext: string): Uint8Array {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function unseal(key: Buffer, blob: Uint8Array): string {
  const buf = Buffer.from(blob);
  if (buf[0] !== VERSION) throw new Error("unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
  decipher.setAuthTag(buf.subarray(13, 29));
  return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
}

/** secrets 表：按名字存一条加密的值（例如 CJ 的 API Key 和 accessToken）。 */
export function getSecret(db: DatabaseSync, key: Buffer, name: string): string | null {
  const row = db.prepare("SELECT ciphertext FROM secrets WHERE name = ?").get(name) as { ciphertext: Uint8Array } | undefined;
  return row ? unseal(key, row.ciphertext) : null;
}

export function setSecret(db: DatabaseSync, key: Buffer, name: string, value: string, hint: string | null = null): void {
  db.prepare(`INSERT INTO secrets (name, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET ciphertext = excluded.ciphertext, hint = excluded.hint, updated_at = excluded.updated_at`)
    .run(name, seal(key, value), hint, Date.now());
}

export const secretHint = (db: DatabaseSync, name: string): string | null =>
  (db.prepare("SELECT hint FROM secrets WHERE name = ?").get(name) as { hint: string | null } | undefined)?.hint ?? null;
