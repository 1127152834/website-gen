import { createHash, randomBytes, scrypt } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const MAX_PASSWORD_BYTES = 1024;

function scryptKey(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("密码至少需要 8 个字符");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error("密码不能超过 1024 字节");
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  const [kind, nText, rText, pText, saltText, keyText, extra] = encoded.split("$");
  if (kind !== "scrypt" || extra !== undefined) return false;
  const n = Number(nText), r = Number(rText), p = Number(pText);
  const salt = Buffer.from(saltText ?? "", "base64"), expected = Buffer.from(keyText ?? "", "base64");
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scryptKey(password, salt, n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const randomInitialPassword = (): string => randomBytes(18).toString("base64url");
