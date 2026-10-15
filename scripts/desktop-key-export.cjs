// 仅供桌面版数据迁移：用临时下载的 Electron 解开 DPAPI 保护的旧主密钥。
// 用法：npx --yes electron@44.7.2 scripts/desktop-key-export.cjs -- <旧 master.key> <临时输出文件>
const { app, safeStorage } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const separator = process.argv.lastIndexOf("--");
const args = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(-2);
const [input, output] = args;
// master.key 是 v10 格式：真正的解密钥匙在桌面版 userData 的 Local State 里（再由 DPAPI 保护），
// 所以必须在 ready 之前把 userData 指回桌面版目录，否则 Electron 会新建一个钥匙，解不开旧文件。
if (input) app.setPath("userData", dirname(resolve(input)));

void (async () => {
  try {
    if (!input || !output) throw new Error("缺少旧 master.key 或临时输出文件路径");
    await app.whenReady();
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error("当前 Windows 用户无法使用 DPAPI 解密旧主密钥");
    const { result } = await safeStorage.decryptStringAsync(readFileSync(input));
    const key = Buffer.from(result, "base64");
    if (key.length !== 32) throw new Error("旧主密钥格式不正确");
    writeFileSync(output, key, { flag: "wx", mode: 0o600 });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
})();
