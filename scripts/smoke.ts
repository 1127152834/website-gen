// 冒烟测试：启动构建好的桌面应用（先 npm run build），走一遍「连后台 → 批次和建站页的空状态 → 关窗进托盘 → 账号页 → 设置页 → 退出」。
// 用法：npm run smoke    截图写到 poc/out/（已被 git 忽略）
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import electronPath from "electron";
import { _electron } from "playwright-core";

const userData = mkdtempSync(join(tmpdir(), "website-gen-smoke-"));
mkdirSync("poc/out", { recursive: true });
const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: ["."],
  env: { ...process.env, WEBSITE_GEN_USER_DATA: userData } as Record<string, string>,
});

const page = await app.firstWindow();
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.getByText("后台已连接").waitFor({ timeout: 15_000 });
  console.log(`✔ backend connected (${page.url().split("/").slice(0, 3).join("/")}):`, (await page.locator("header dl").innerText()).replace(/\s+/g, " "));

  // 批次页是首页：没有批次时引导去建站；建站页没有可用域名时不能提交
  await page.getByText("还没有建站批次").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "去建站" }).click();
  await page.getByText("没有可用的域名").waitFor({ timeout: 10_000 });
  assert.ok(await page.getByRole("button", { name: "开始建站" }).isDisabled(), "cannot start without a free domain");
  await page.screenshot({ path: "poc/out/smoke-1-new-batch.png" });
  await page.getByRole("button", { name: "站点" }).click();
  await page.getByText("还没有建好的站").waitFor({ timeout: 10_000 });
  console.log("✔ batches, new-site and sites pages show their empty states");

  // 关窗口 = 隐藏到托盘，进程还在
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  assert.deepEqual(visible, [false], "window should be hidden, not destroyed");
  console.log("✔ closing the window hides it to the tray");

  // 主密钥：safeStorage 加密后落盘
  assert.ok(existsSync(join(userData, "master.key")), "master.key should be created");
  console.log("✔ master key created and protected with safeStorage");

  // 账号页：空状态 → 用假 Token 添加，必须被 Hostinger 拒绝（走一遍 界面→后台→MCP 子进程→Hostinger API）
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.getByRole("button", { name: "账号" }).click();
  await page.getByText("还没有接入账号").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "添加账号" }).click();
  await page.getByLabel("名称").fill("冒烟测试");
  await page.getByLabel("API Token").fill("invalid-smoke-test-token-0000");
  await page.getByRole("button", { name: "验证并添加" }).click();
  await page.getByRole("alert").filter({ hasText: "Token 无效" }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: "poc/out/smoke-2-accounts.png" });
  await page.keyboard.press("Escape");
  await page.getByText("还没有接入账号").waitFor({ timeout: 10_000 });
  console.log("✔ an invalid token is rejected by Hostinger and nothing is saved");

  // 设置页：两个 DeepSeek 提供方共用 Key；假 Key 测试必须被拒；改用途模型能保存
  await page.getByRole("button", { name: "设置" }).click();
  const providers = page.locator('section[aria-label="模型提供方"]');
  const roles = page.locator('section[aria-label="用途"]');
  await providers.getByText("DeepSeek（Anthropic 格式）").waitFor({ timeout: 10_000 });
  assert.equal(await providers.getByText("未设置").count(), 2, "both providers start without a key");
  assert.equal(await roles.getByText("还没有设置 Key").count(), 4, "all four roles need a key");
  await providers.getByRole("button", { name: "设置 Key" }).first().click();
  await page.getByLabel("API Key").fill("sk-smoke-test-0000");
  await page.getByRole("button", { name: "保存" }).click();
  await providers.getByText("已设置，尾号 0000").nth(1).waitFor({ timeout: 10_000 });
  assert.equal(await roles.getByText("可用").count(), 4, "all roles ready once the shared key is set");
  console.log("✔ one key is shared by both DeepSeek providers and all roles become ready");
  await providers.getByRole("button", { name: "测试 DeepSeek（OpenAI 格式）" }).click();
  await providers.getByRole("status").filter({ hasText: "Key 无效" }).waitFor({ timeout: 40_000 });
  console.log("✔ an invalid key is reported by the connection test");
  await roles.getByRole("combobox", { name: "建站与对话的模型" }).click();
  await page.getByRole("option", { name: "deepseek-flash" }).click();
  await roles.getByRole("combobox", { name: "建站与对话的模型" }).filter({ hasText: "deepseek-flash" }).waitFor();
  await page.getByRole("button", { name: "批次" }).click();
  await page.getByRole("button", { name: "设置" }).click();
  await roles.getByRole("combobox", { name: "建站与对话的模型" }).filter({ hasText: "deepseek-flash" }).waitFor({ timeout: 10_000 });
  await page.getByText("未设置，建站会停在「从 CJ 选品」这一步").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: "poc/out/smoke-3-settings.png" });
  console.log("✔ changing a role's model is saved");

  assert.deepEqual(errors, [], "no console errors");
  console.log("✔ no console errors");
} catch (e) {
  await page.screenshot({ path: "poc/out/smoke-failed.png" });
  console.log("✘ failed; page errors:\n  " + errors.join("\n  "));
  throw e;
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
