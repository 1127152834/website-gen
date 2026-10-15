// Web 冒烟：真实 Node 服务 + 浏览器，覆盖登录、强制改密、空状态、用户管理和工作区隔离。
// 先运行 npm run build；所有数据和截图都写到系统临时目录，结束后删除。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
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
let modelFixture: Server | null = null;
let rejectedModelRequests = 0;
const modelRequests: { url?: string; authorization?: string }[] = [];
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
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await page.getByRole("heading", { name: "登录" }).waitFor();
}

try {
  const port = await freePort(), baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["src/server/index.ts"], {
    cwd: root,
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), ALLOW_PRIVATE_MODEL_HOSTS: "1", DATA_DIR: dataDir, DIST_DIR: distDir,
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

  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.getByRole("heading", { name: "总览", exact: true }).waitFor();
  await page.getByText("还没有站点", { exact: true }).waitFor();
  await nav.getByRole("link", { name: "批次", exact: true }).click();
  await page.getByText("还没有建站批次").waitFor();
  await nav.getByRole("link", { name: "建站", exact: true }).click();
  await page.getByText("没有可用的域名").waitFor();
  assert.ok(await page.getByRole("button", { name: "下一步" }).isDisabled());
  await nav.getByRole("link", { name: "站点", exact: true }).click();
  await page.getByText("还没有站点", { exact: true }).waitFor();
  await nav.getByRole("link", { name: "账号", exact: true }).click();
  await page.getByText("还没有接入账号").waitFor();
  console.log("✔ 总览、建站、批次、站点、账号页空状态正常");

  // 使用明确的本地模型服务夹具，真实经过 RPC、密钥解密、HTTP 和模型 SDK；不依赖外网可用性。
  modelFixture = createHttpServer((request, response) => {
    modelRequests.push({ url: request.url, authorization: request.headers.authorization });
    rejectedModelRequests++;
    response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error" } }));
  });
  await new Promise<void>((ready) => modelFixture!.listen(0, "127.0.0.1", ready));
  const fixtureAddress = modelFixture.address();
  assert.ok(fixtureAddress && typeof fixtureAddress !== "string");
  await nav.getByRole("link", { name: "设置", exact: true }).click();
  const settingsNav = page.getByRole("navigation", { name: "设置分区" });
  for (const name of ["模型厂商", "用途分配", "商品资料 CJ", "邮箱", "账户安全"]) {
    await settingsNav.getByRole("link", { name, exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  }
  await settingsNav.getByRole("link", { name: "模型厂商", exact: true }).click();
  await page.getByRole("button", { name: "添加厂商", exact: true }).click();
  const providerEditor = page.getByRole("dialog");
  await providerEditor.getByLabel("厂商名称", { exact: true }).fill("冒烟测试厂商");
  await providerEditor.getByLabel("Base URL", { exact: true }).fill(`http://127.0.0.1:${fixtureAddress.port}/v1`);
  await providerEditor.getByLabel("API Key", { exact: true }).fill("sk-smoke-test-invalid-0000");
  await providerEditor.getByRole("button", { name: "手动添加", exact: true }).click();
  await providerEditor.getByLabel("模型 ID", { exact: true }).fill("smoke-model");
  await providerEditor.getByRole("button", { name: "添加厂商", exact: true }).click();
  const providerCard = page.locator("article").filter({ has: page.getByRole("heading", { name: "冒烟测试厂商", exact: true }) });
  await providerCard.getByText("Key ····0000", { exact: true }).waitFor();
  await providerCard.getByRole("button", { name: "测试", exact: true }).click();
  const rejected = providerCard.getByRole("status");
  await rejected.waitFor({ timeout: 45_000 });
  assert.match(await rejected.innerText(), /Key 无效|401|authentication/i);
  assert.ok(rejectedModelRequests > 0, "连接测试必须实际请求模型服务");
  assert.ok(modelRequests.every((request) => request.url === "/v1/chat/completions" && request.authorization === "Bearer sk-smoke-test-invalid-0000"), "模型测试应使用保存的地址、协议和独立 Key");
  console.log("✔ 自定义厂商假 Key 被真实 HTTP 连接测试拒绝；设置所有分区可访问");

  // 真实 URL 重载 + 两个目标视口。设 SMOKE_KEEP_SCREENSHOTS=1 可保留成功截图供人工审查。
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, title] of [["/", "总览"], ["/new", "建站"], ["/batches", "批次"], ["/sites", "站点"], ["/accounts", "Hostinger 账号"], ["/settings", "设置"]]) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      await page.getByText("后台已连接").waitFor();
      await page.waitForFunction(() => !document.querySelector('[class*="animate-pulse"]'));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, `${width}px 的 ${path} 不应横向溢出`);
      await page.screenshot({ path: join(screenshotDir, `${title}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "用户菜单：admin" }).click();
  await page.getByRole("menuitem", { name: "深色模式" }).click();
  assert.equal(await page.locator("html").evaluate((element) => element.classList.contains("dark")), true);
  await page.screenshot({ path: join(screenshotDir, "设置-dark-1280.png"), fullPage: true });
  await page.getByRole("button", { name: "用户菜单：admin" }).click();
  await page.getByRole("menuitem", { name: "跟随系统" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  console.log("✔ 真实 URL 重载、1280/390 宽度、主题切换和页面截图");
  await nav.getByRole("link", { name: "用户管理", exact: true }).click();
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
  await nav.getByRole("link", { name: "设置", exact: true }).click();
  await page.getByText("还没有模型厂商", { exact: true }).waitFor();
  assert.equal(await page.getByText("冒烟测试厂商", { exact: true }).count(), 0, "普通用户不应看到管理员的自定义厂商");
  assert.equal(await page.getByText("Key ····0000", { exact: true }).count(), 0, "普通用户不应看到管理员工作区的模型 Key");
  await nav.getByRole("link", { name: "账号", exact: true }).click();
  await page.getByText("还没有接入账号").waitFor();
  assert.equal(await nav.getByRole("link", { name: "用户管理", exact: true }).count(), 0, "普通用户不应看到用户管理入口");
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
  if (modelFixture) await new Promise<void>((done) => modelFixture!.close(() => done()));
  if (server && !serverError && server.pid != null && server.exitCode == null) {
    server.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => { server?.kill("SIGKILL"); resolveExit(); }, 5_000);
      server!.once("exit", () => { clearTimeout(timer); resolveExit(); });
    });
  }
  rmSync(temp, { recursive: true, force: true });
  if (!failed && process.env.SMOKE_KEEP_SCREENSHOTS !== "1") rmSync(screenshotDir, { recursive: true, force: true });
  else console.log(`截图目录：${screenshotDir}`);
}
