// 主密钥：32 字节随机数，用 safeStorage（Windows 上是 DPAPI，绑定当前 Windows 用户）加密后存成 userData/master.key。
// 只有主进程能用 safeStorage，所以由主进程解开后交给后台进程，只放在内存里。
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { app, safeStorage } from "electron";

export async function loadMasterKey(): Promise<Buffer> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("系统加密服务不可用，无法保护密钥");
  const file = join(app.getPath("userData"), "master.key");

  if (existsSync(file)) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await readFile(file));
    if (shouldReEncrypt) await writeFile(file, await safeStorage.encryptStringAsync(result));
    return Buffer.from(result, "base64");
  }

  const key = randomBytes(32);
  // wx：文件已存在就失败，绝不覆盖已有主密钥（覆盖等于丢失所有凭据）
  await writeFile(file, await safeStorage.encryptStringAsync(key.toString("base64")), { flag: "wx" });
  return key;
}
