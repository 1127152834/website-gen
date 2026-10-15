// Web 冒烟：真实 Node 服务 + 浏览器，覆盖登录、强制改密、空状态、用户管理和工作区隔离。
// 先运行 npm run build；所有数据和截图都写到系统临时目录，结束后删除。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const distDir = join(root, "dist");
if (!existsSync(join(distDir, "index.html"))) throw new Error("找不到 dist/index.html；请先运行 npm run build");

const temp = mkdtempSync(join(tmpdir(), "website-gen-smoke-"));
const screenshotDir = mkdtempSync(join(tmpdir(), "website-gen-smoke-shots-"));
const dataDir = join(temp, "data");
const initialAdminPassword = "admin smoke password";
const adminPassword = "changed admin password";
const initialUserPassword = "alice initial password";
const userPassword = "alice changed password";
let server: ChildProcess | null = null, browser: Browser | null = null;
let serverError: Error | null = null;
let failed = false;
const serverOutput: string[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("无法分配冒烟测试端口");
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return address.port;
}

async function waitForServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    if (server?.exitCode != null) throw new Error(`服务提前退出（${server.exitCode}）：\n${serverOutput.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/me`);
      if (response.status === 401) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`等待服务启动超时：\n${serverOutput.join("")}`);
}

async function launchBrowser(): Promise<Browser> {
  if (process.env.QA_CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH, headless: true });
  if (process.platform === "win32") {
    try { return await chromium.launch({ channel: "msedge", headless: true }); }
    catch (error) { console.warn(`Edge 启动失败，尝试 Playwright Chromium：${(error as Error).message.split("\n")[0]}`); }
  }
  return chromium.launch({ headless: true });
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.getByRole("heading", { name: "登录" }).waitFor();
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
}

async function forcedPasswordChange(page: Page, oldPassword: string, newPassword: string): Promise<void> {
  await page.getByRole("heading", { name: "首次登录，请修改密码" }).waitFor();
  await page.getByLabel("当前密码").fill(oldPassword);
  await page.getByLabel("新密码", { exact: true }).fill(newPassword);
  await page.getByLabel("再输入一次新密码").fill(newPassword);
  await page.getByRole("button", { name: "保存新密码" }).click();
  await page.getByText("后台已连接").waitFor({ timeout: 15_000 });
}

async function logout(page: Page, username: string): Promise<void> {
  await page.getByRole("button", { name: `用户菜单：${username}` }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await page.getByRole("heading", { name: "登录" }).waitFor();
}

try {
  const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, DIST_DIR: distDir,
      ADMIN_USERNAME: "admin", ADMIN_PASSWORD: initialAdminPassword,
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  server.stdout?.on("data", (chunk) => serverOutput.push(String(chunk)));
  server.stderr?.on("data", (chunk) => serverOutput.push(String(chunk)));
  server.once("error", (error) => { serverError = error; });
  await waitForServer(baseUrl);
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    const expectedLoggedOutProbe = /Failed to load resource.*401/i.test(message.text()) && /\/api\/me(?:$|\?)/.test(location);
    if (!expectedLoggedOutProbe) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await login(page, "admin", initialAdminPassword);
  await forcedPasswordChange(page, initialAdminPassword, adminPassword);
  console.log("✔ 管理员登录并完成首次强制改密");

  await page.getByText("还没有建站批次").waitFor();
  await page.getByRole("button", { name: "建站", exact: true }).click();
  await page.getByText("没有可用的域名").waitFor();
  assert.ok(await page.getByRole("button", { name: "开始建站" }).isDisabled());
  await page.getByRole("button", { name: "站点", exact: true }).click();
  await page.getByText("还没有建好的站").waitFor();
  await page.getByRole("button", { name: "账号", exact: true }).click();
  await page.getByText("还没有接入账号").waitFor();
  console.log("✔ 建站、批次、站点、账号页空状态正常");

  // 管理员工作区保存一个假模型 Key，再验证远端拒绝；随后用它证明新用户工作区看不到该 Key。
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const providers = page.locator('section[aria-label="模型提供方"]');
  await providers.getByText("未设置").first().waitFor();
  await providers.getByRole("button", { name: "设置 Key" }).first().click();
  await page.getByLabel("API Key").fill("sk-smoke-test-invalid-0000");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await providers.getByText("已设置，尾号 0000").first().waitFor();
  await providers.getByRole("button", { name: /测试/ }).first().click();
  const rejected = providers.getByRole("status").first();
  await rejected.waitFor({ timeout: 45_000 });
  assert.doesNotMatch(await rejected.innerText(), /连接正常/);
  console.log("✔ 假模型 Key 被连接测试拒绝");

  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("heading", { name: "用户管理" }).waitFor();
  await page.getByRole("button", { name: "添加用户" }).click();
  const dialog = page.getByRole("dialog", { name: "添加用户" });
  await dialog.getByLabel("用户名").fill("alice");
  await dialog.getByLabel("初始密码").fill(initialUserPassword);
  await dialog.getByRole("button", { name: "创建用户" }).click();
  await page.getByText("alice", { exact: true }).waitFor();
  console.log("✔ 管理员创建普通用户");

  assert.deepEqual(errors, [], `浏览器控制台错误：\n${errors.join("\n")}`);
  await logout(page, "admin");
  await login(page, "alice", initialUserPassword);
  await forcedPasswordChange(page, initialUserPassword, userPassword);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const userProviders = page.locator('section[aria-label="模型提供方"]');
  await userProviders.getByText("未设置").first().waitFor();
  assert.equal(await userProviders.getByText("已设置，尾号 0000").count(), 0, "普通用户不应看到管理员工作区的模型 Key");
  await page.getByRole("button", { name: "账号", exact: true }).click();
  await page.getByText("还没有接入账号").waitFor();
  assert.equal(await page.getByRole("button", { name: "用户管理", exact: true }).count(), 0, "普通用户不应看到用户管理入口");
  console.log("✔ 新用户看不到管理员的模型 Key 或管理入口");
  await logout(page, "alice");
  assert.deepEqual(errors, [], `浏览器控制台错误：\n${errors.join("\n")}`);
  console.log("✔ 注销后回到登录页");
} catch (error) {
  failed = true;
  if (browser) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages[0]) {
      await pages[0].screenshot({ path: join(screenshotDir, "failed.png"), fullPage: true }).catch(() => {});
      console.error(`失败截图已保留：${join(screenshotDir, "failed.png")}`);
    }
  }
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (server && !serverError && server.pid != null && server.exitCode == null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => { server?.kill("SIGKILL"); resolveExit(); }, 5_000);
      server!.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
  }
  rmSync(temp, { recursive: true, force: true });
  if (!failed) rmSync(screenshotDir, { recursive: true, force: true });
}
