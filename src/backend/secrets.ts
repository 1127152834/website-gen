// 凭据加密：AES-256-GCM。主密钥由主进程用 safeStorage（Windows DPAPI）保护后交给后台，只在内存里。
// 格式：版本(1) + IV(12) + 认证标签(16) + 密文。篡改或换了密钥都会在解密时报错。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

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
