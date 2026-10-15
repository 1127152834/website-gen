// 冒烟测试：启动构建好的桌面应用（先 npm run build），走一遍「连后台 → 跑示例任务 → 刷新后按 seq 补发 → 关窗进托盘 → 退出」。
// 用法：npm run smoke    截图写到 poc/out/（已被 git 忽略）
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

  await page.getByRole("button", { name: "运行示例任务" }).click();
  await page.getByText("全部完成").waitFor({ timeout: 15_000 });
  const rows = page.locator('section[aria-label="事件日志"] li');
  assert.equal(await rows.count(), 7, "7 step events expected");
  await page.screenshot({ path: "poc/out/smoke-1-done.png" });
  console.log("✔ demo task finished, 7 events");

  // 刷新界面：状态清空，必须从数据库按 seq 补回 7 条
  await page.reload();
  await page.getByText("后台已连接").waitFor({ timeout: 15_000 });
  await rows.nth(6).waitFor({ timeout: 10_000 });
  assert.equal(await rows.count(), 7, "replay after reload should restore 7 events");
  console.log("✔ reload replayed 7 events from SQLite");

  // 关窗口 = 隐藏到托盘，进程还在
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  assert.deepEqual(visible, [false], "window should be hidden, not destroyed");
  console.log("✔ closing the window hides it to the tray");

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
