import { hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_BYTES = 32;

function decodeMasterKey(encoded: string): Buffer {
  const value = encoded.trim();
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("WEBSITE_GEN_MASTER_KEY 必须是 32 字节的 base64 字符串");
  }
  return key;
}

/** 读取服务端主密钥；首次运行时生成文件。调用方必须明确传入数据目录。 */
export function loadMasterKey(dataDir: string, encoded = process.env.WEBSITE_GEN_MASTER_KEY): Buffer {
  if (encoded) return decodeMasterKey(encoded);
  const path = join(dataDir, "master.key");
  try {
    return decodeMasterKey(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, `${key.toString("base64")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return key;
}

/** 每个用户使用独立的数据密钥；主密钥本身不直接加密业务数据。 */
export function deriveUserKey(masterKey: Uint8Array, userId: number | string): Buffer {
  if (masterKey.byteLength !== KEY_BYTES) throw new Error("服务端主密钥必须是 32 字节");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), `user:${userId}`, KEY_BYTES));
}
