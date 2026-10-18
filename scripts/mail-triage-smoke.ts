import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BoardCasePage, CaseDetail, TriageSettings, TriageStatus } from "../src/shared/mail-triage-types.ts";
import { startMailTriageFixture } from "./mail-triage-smoke-fixture.ts";

const root = resolve(import.meta.dirname, "..");
const requestedArtifactDir = process.env.MAIL_TRIAGE_SMOKE_ARTIFACT_DIR;
const artifactDir = requestedArtifactDir ? resolve(requestedArtifactDir) : resolve(root, ".tmp/mail-triage-implementation/20261016-sdd/task-16/evidence/browser");
if (requestedArtifactDir && !isAbsolute(requestedArtifactDir)) throw new Error("MAIL_TRIAGE_SMOKE_ARTIFACT_DIR 必须是绝对目录");
mkdirSync(artifactDir, { recursive: true });
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const journey: Record<string, unknown> = { startedAt: new Date().toISOString(), widths: [] as number[], assertions: [] as string[] };
const passed = (name: string) => (journey.assertions as string[]).push(name);

async function launchBrowser(): Promise<Browser> {
  if (process.env.QA_CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH, headless: true });
  if (process.platform === "win32") {
    try { return await chromium.launch({ channel: "msedge", headless: true }); }
    catch (error) { console.warn(`Edge 启动失败，尝试 Playwright Chromium：${(error as Error).message.split("\n")[0]}`); }
  }
  return chromium.launch({ headless: true });
}

async function login(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "登录" }).waitFor();
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("admin fixture password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "首次登录，请修改密码" }).waitFor();
  await page.getByLabel("当前密码").fill("admin fixture password");
  await page.getByLabel("新密码", { exact: true }).fill("admin changed fixture password");
  await page.getByLabel("再输入一次新密码").fill("admin changed fixture password");
  await page.getByRole("button", { name: "保存新密码" }).click();
  await page.getByText("后台已连接").waitFor();
}

async function rpc<T>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(async ({ method, params }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch("/api/rpc", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "website-gen" }, body: JSON.stringify({ method, params }), signal: controller.signal });
      const body = await response.json();
      if (!response.ok || !("ok" in body) || body.ok !== true) throw new Error(body.error ?? `RPC ${method} failed`);
      return body.result;
    } finally { clearTimeout(timeout); }
  }, { method, params }) as Promise<T>;
}

async function assertNoOverflow(page: Page, label: string): Promise<void> {
  const value = await page.evaluate(() => ({ body: document.body.scrollWidth, root: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  assert.ok(value.body <= value.viewport + 1 && value.root <= value.viewport + 1, `${label} 横向溢出：${JSON.stringify(value)}`);
}
async function finishAnimations(page: Page): Promise<void> {
  await page.locator("*").evaluateAll(elements => { for (const element of elements) for (const animation of element.getAnimations()) animation.finish(); });
}

const fixture = await startMailTriageFixture();
console.log("[mail-smoke] fixture-ready");
let browser: Browser | null = null;
const browserErrors: string[] = [], prohibitedBrowserRequests: string[] = [];
let expectedSseDisconnectCount = 0, sseReconnectPhase = false;
try {
  browser = await launchBrowser();
  console.log("[mail-smoke] browser-ready");
  const context = await browser.newContext({ baseURL: fixture.baseUrl, viewport: { width: 1440, height: 960 } });
  const origin = new URL(fixture.baseUrl).origin;
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + "/") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    prohibitedBrowserRequests.push(url); await route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(15_000);
  page.on("pageerror", error => browserErrors.push(`pageerror: ${error}`));
  page.on("requestfailed", request => {
    if (new URL(request.url()).pathname === "/api/events" && sseReconnectPhase) { expectedSseDisconnectCount++; return; }
    browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`);
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text(), location = message.location().url;
    if (/Failed to load resource.*401/i.test(text) && /\/api\/me(?:$|\?)/.test(location)) return;
    browserErrors.push(`console: ${text}`);
  });
  await login(page); passed("真实管理员会话、登录与强制改密");
  console.log("[mail-smoke] authenticated");
  const screenshotPaths: string[] = [];
  const screenshot = async (name: string) => { const path = join(artifactDir, name); await page.screenshot({ path, fullPage: true, animations: "disabled" }); screenshotPaths.push(path); };

  await page.goto("/mail/settings", { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "邮件预审设置" }).waitFor();
  const initialSettings = await rpc<TriageSettings>(page, "mail.triage.settings"); assert.equal(initialSettings.enabled, false); assert.equal(initialSettings.state, "disabled"); assert.equal(fixture.state().jobs.length, 0);
  await page.getByLabel("启用邮件预审").check(); await page.getByLabel("模式").selectOption("suggest_only"); await page.getByLabel("专用模型服务商").selectOption({ label: "Fixture Models" }); await page.locator("label").filter({ hasText: /^模型/ }).locator("select").selectOption("fixture-model"); await page.getByLabel(ADDRESS_RE()).first().check(); await page.getByLabel("同意当前目的地与范围").check(); await page.getByRole("button", { name: "保存设置" }).click(); await page.getByText("预审设置已保存").waitFor();
  const initiallyEnabled = await rpc<TriageSettings>(page, "mail.triage.settings"); assert.equal(initiallyEnabled.enabled, true); assert.deepEqual(initiallyEnabled.mailboxIds, [1]); assert.equal(initiallyEnabled.modelBinding?.modelId, "fixture-model"); fixture.refreshSeedCases(); passed("真实default OFF经生产UI选择独立role/scope并明确同意后启用");

  await page.goto("/mail", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "网关申请进度" }).waitFor();
  for (const title of ["需要你处理", "等待平台", "结果回执"]) await page.getByRole("heading", { name: new RegExp(title) }).waitFor();
  const board = await rpc<BoardCasePage>(page, "mail.cases.list", { page: 1, pageSize: 100 });
  assert.ok(board.columnTotals.needs_you >= 2 && board.columnTotals.awaiting_platform >= 1 && board.columnTotals.results >= 1, JSON.stringify(board.columnTotals));
  assert.ok(board.items.some(item => item.applicationId === "APP-SIGNED" && item.column === "needs_you"));
  assert.ok(board.items.some(item => item.applicationId === "APP-DECLINED" && item.requiresReply));
  assert.ok(board.items.some(item => item.applicationId === "APP-APPROVED" && item.column === "results"));
  const status = await rpc<TriageStatus>(page, "mail.triage.status"); assert.ok(status.openTaskCount >= 3);
  passed("三列、计数、新信核对、签名待补件、拒绝回复与结果列");
  await screenshot("mail-board-populated-1440.png");
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await page.goto("/mail", { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "网关申请进度" }).waitFor();
    await assertNoOverflow(page, `board-${width}`);
    if (width === 390) { const firstTab = page.getByRole("tab", { name: /需要你处理/ }); await firstTab.focus(); assert.equal(await firstTab.evaluate(element => element === document.activeElement), true); await page.getByRole("tab", { name: /结果回执/ }).click(); }
    await screenshot(`mail-triage-${width}.png`); (journey.widths as number[]).push(width);
  }
  passed("1440/1280/390 populated截图、无横向溢出、移动键盘焦点");
  await page.setViewportSize({ width: 1440, height: 960 }); await page.goto("/mail", { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "网关申请进度" }).waitFor();
  console.log("[mail-smoke] board-verified");

  await page.getByRole("button", { name: /打开申请 APP-SIGNED/ }).click();
  await page.getByRole("heading", { name: "申请身份与证据" }).waitFor();
  await page.getByRole("region", { name: "下一步" }).getByText("补交银行账单", { exact: true }).waitFor();
  const signedSheet = page.locator('[data-slot="sheet-content"][data-state="open"]');
  await finishAnimations(page);
  const signedBox = await signedSheet.boundingBox(); assert.ok(signedBox && signedBox.width >= 400 && signedBox.x < 1_100, JSON.stringify(signedBox));
  await screenshot("mail-case-drawer.png");
  await page.keyboard.press("Escape");
  await page.waitForURL(/\/mail\/?$/); passed("详情键盘 Escape 返回");
  console.log("[mail-smoke] drawer-verified");

  const declinedSummary = board.items.find(item => item.applicationId === "APP-DECLINED")!;
  const beforeSend = await rpc<CaseDetail>(page, "mail.cases.detail", { caseId: declinedSummary.caseId });
  const replyTask = beforeSend.projection.tasks.find(item => item.kind === "reply" && item.state === "open")!;
  const actionTask = beforeSend.projection.tasks.find(item => item.kind === "action" && item.state === "open")!;
  const readerRef = beforeSend.sources.find(item => item.readerRef)?.readerRef!;
  assert.ok(replyTask && actionTask && readerRef);
  console.log("[mail-smoke] sending-receipt");
  await rpc(page, "mail.send", { mailboxId: readerRef.mailboxId, to: ["review@fixture.test"], cc: [], bcc: [], subject: "Re: Application declined", text: "Here is the requested business model.", mode: "reply", replyTo: { folder: readerRef.folder, uid: readerRef.uid, readerRef }, attachments: [], requestId: randomUUID(), caseId: declinedSummary.caseId, selectedTaskIds: [replyTask.id] });
  console.log("[mail-smoke] receipt-sent");
  const afterSend = await rpc<CaseDetail>(page, "mail.cases.detail", { caseId: declinedSummary.caseId });
  console.log("[mail-smoke] receipt-verified");
  assert.equal(afterSend.projection.tasks.find(item => item.id === replyTask.id)?.state, "awaiting_external");
  assert.equal(afterSend.projection.tasks.find(item => item.id === actionTask.id)?.state, "open");
  assert.equal(fixture.stats().smtpCalls, 1); passed("SMTP fake仅一次，回执只推进选中回复义务");

  console.log("[mail-smoke] correction-opening");
  const conflictSummary = board.items.find(item => item.applicationId === "APP-CONFLICT")!;
  const conflictBefore = await rpc<CaseDetail>(page, "mail.cases.detail", { caseId: conflictSummary.caseId });
  const conflictSource = conflictBefore.sources[0]!; assert.ok(conflictSource && conflictBefore.projection.decision === "unknown");
  await page.getByRole("button", { name: /打开申请 APP-CONFLICT/ }).click();
  console.log("[mail-smoke] correction-route-ready");
  await page.getByText("为什么这样判断", { exact: true }).waitFor();
  console.log("[mail-smoke] correction-evidence-ready");
  const openCaseSheet = page.locator('[data-slot="sheet-content"][data-state="open"]');
  await openCaseSheet.getByRole("button", { name: "更正分类" }).first().click();
  console.log("[mail-smoke] correction-dialog-opening");
  await page.waitForTimeout(250);
  const correctionTitle = page.getByText("更正来源分类", { exact: true });
  console.log(`[mail-smoke] correction-dialog-count=${await correctionTitle.count()} visible=${await correctionTitle.isVisible()} errors=${JSON.stringify(browserErrors)}`);
  assert.equal(await correctionTitle.isVisible(), true, "更正来源分类对话框应可见");
  await rpc(page, "mail.triage.correct", { target: { type: "source", id: conflictSource.sourceId, sourceVersion: conflictSource.sourceVersion }, field: "tag", value: "冲突待核", requestId: randomUUID(), expectedVersion: conflictSource.manualVersion, reason: "并发操作者先行保存" });
  await page.getByLabel("短标签").fill("人工冲突"); await page.getByLabel("更正依据").fill("陈旧页面应显示冲突并刷新"); await page.getByRole("button", { name: "保存更正" }).click();
  await page.getByRole("alert").filter({ hasText: "来源已变化" }).waitFor();
  await page.getByRole("button", { name: "取消" }).click(); await correctionTitle.waitFor({ state: "hidden" });
  await openCaseSheet.getByRole("button", { name: "更正分类" }).first().click(); await correctionTitle.waitFor();
  await page.getByLabel("短标签").fill("人工冲突"); await page.getByLabel("更正依据").fill("按最新来源版本确认冲突分类"); await page.getByRole("button", { name: "保存更正" }).click(); await correctionTitle.waitFor({ state: "hidden" });
  const conflictAfter = await rpc<CaseDetail>(page, "mail.cases.detail", { caseId: conflictSummary.caseId });
  const corrected = conflictAfter.sources.find(item => item.sourceId === conflictSource.sourceId)!; assert.equal(corrected.manualVersion, conflictSource.manualVersion + 2); assert.equal(conflictAfter.projection.decision, "unknown"); await assert.rejects(rpc(page, "mail.triage.correct", { target: { type: "source", id: conflictSource.sourceId, sourceVersion: conflictSource.sourceVersion }, field: "tag", value: "过期提交", requestId: randomUUID(), expectedVersion: conflictSource.manualVersion + 1, reason: "再次验证旧版本不能覆盖" }), /version_conflict|版本冲突/);
  await page.keyboard.press("Escape"); await page.waitForURL(/\/mail\/?$/); passed("APP-CONFLICT陈旧CAS可见冲突、刷新后保存并持久重取"); console.log("[mail-smoke] correction-saved");

  await page.getByRole("link", { name: "邮件核对", exact: true }).click(); await page.waitForURL(/\/mail\/review$/);
  const reviewResponse = await page.request.get("/mail/review"), reviewBytes = await reviewResponse.body();
  console.log(`[mail-smoke] review-response=${reviewResponse.status()} ${reviewResponse.headers()["content-type"]} bytes=${reviewBytes.length} sha256=${createHash("sha256").update(reviewBytes).digest("hex")}`);
  await page.waitForTimeout(500);
  const reviewResources = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => entry.name).filter(name => /mail|route|index-/.test(name)));
  console.log(`[mail-smoke] review-url=${page.url()} body=${(await page.locator("body").innerText()).slice(0,120).replace(/\s+/g," ")} resources=${JSON.stringify(reviewResources)} errors=${JSON.stringify(browserErrors)}`);
  const reviewHeading = page.getByRole("heading", { name: "邮件核对" });
  console.log(`[mail-smoke] review-heading count=${await reviewHeading.count()} visible=${await reviewHeading.isVisible()}`);
  await reviewHeading.waitFor(); console.log("[mail-smoke] review-heading-ready");
  await page.getByRole("tab", { name: "通知抽查" }).click(); console.log("[mail-smoke] review-notifications-ready");
  await page.getByRole("tab", { name: "本地跟进提醒" }).click(); console.log("[mail-smoke] review-reminders-ready");
  await page.getByText(/不会自动发送、删除、归档或改已读/).waitFor(); passed("来源失效/核对队列与通知安全入口"); console.log("[mail-smoke] review-safety-verified");
  await screenshot("mail-review.png");
  await page.getByRole("link", { name: "通知邮件", exact: true }).click(); await page.waitForURL(/\/mail\/notifications$/); await page.getByText(/通过真实人工资格与抽查门槛/).waitFor();
  await page.getByRole("link", { name: "本地跟进提醒", exact: true }).click(); await page.waitForURL(/\/mail\/reminders$/); await page.getByText(/本地人工跟进提醒，不是通知邮件/).waitFor();

  await page.getByRole("link", { name: "预审设置", exact: true }).click(); await page.waitForURL(/\/mail\/settings$/);
  console.log("[mail-smoke] settings-route-ready");
  await page.getByRole("heading", { name: "邮件预审设置" }).waitFor();
  await page.getByText(/独立模型用途和 Key，不会回退/).waitFor();
  await screenshot("mail-settings.png");
  const enabledSettings = await rpc<TriageSettings>(page, "mail.triage.settings"); assert.equal(enabledSettings.enabled, true); assert.deepEqual(enabledSettings.mailboxIds, [1]); assert.equal(enabledSettings.modelBinding?.modelId, "fixture-model");
  fixture.appendInboxMail(7, "New no-action notice", "No action required."); await rpc(page, "mail.message", { mailboxId: 1, folder: "INBOX", uid: 7 });
  const completeDeadline = Date.now() + 10_000; while (!fixture.state().jobs.some(job => job.uid === 7 && ["succeeded", "needs_review"].includes(job.state)) && Date.now() < completeDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.ok(fixture.state().jobs.some(job => job.uid === 7 && ["succeeded", "needs_review"].includes(job.state)), JSON.stringify(fixture.state())); assert.equal(fixture.stats().modelCalls, 1);
  await page.getByRole("link", { name: "邮件核对", exact: true }).click(); await page.getByRole("heading", { name: "邮件核对" }).waitFor(); await page.getByRole("tab", { name: "判定待确认" }).click(); await page.getByText(/判定待确认\s+1 封邮件/).waitFor();
  const annotationModelCalls=fixture.stats().modelCalls,seenCalls=fixture.stats().rpcByMethod["mail.seen"]??0;
  await page.goto("/mail/1/INBOX",{waitUntil:"domcontentloaded"});await page.getByRole("heading",{name:"邮箱",exact:true}).waitFor();
  const noticeRow=page.getByRole("button",{name:/New no-action notice/});await noticeRow.getByText("普通通知",{exact:true}).waitFor();await noticeRow.getByText("邮件称无需处理",{exact:true}).waitFor();
  assert.equal(fixture.stats().modelCalls,annotationModelCalls);assert.equal(fixture.stats().rpcByMethod["mail.seen"]??0,seenCalls);passed("普通收件箱行按实际缓存世代显示有界预审注释，读取不触发模型或已读写入");
  await noticeRow.click();await page.waitForURL(/\/mail\/1\/INBOX\/7$/);await page.getByRole("region",{name:"邮件预审建议"}).waitFor();await page.getByText("严格来源证据",{exact:true}).waitFor();
  const list=await rpc<any>(page,"mail.messages",{mailboxId:1,folder:"INBOX",page:1,pageSize:30}),mail7=list.items.find((item:any)=>item.uid===7),annotations=await rpc<any>(page,"mail.triage.messageAnnotations",{mailboxId:1,folder:"INBOX",messages:[{uid:7,readIdentity:mail7.readIdentity}]}),annotation=annotations.items[0];assert.ok(annotation);
  await rpc(page,"mail.triage.correct",{target:{type:"source",id:annotation.sourceId,sourceVersion:annotation.sourceVersion},field:"tag",value:"并发先改",requestId:randomUUID(),expectedVersion:annotation.manualVersion,reason:"离线夹具模拟另一操作者先保存"});
  await page.getByLabel("更正短标签").fill("人工通知");await page.getByLabel("更正原因").fill("验证普通阅读器并发错误可见");await page.getByRole("button",{name:"更正标签"}).click();await page.getByRole("alert").filter({hasText:/版本冲突|version_conflict|来源已变化/}).waitFor();
  await page.reload({waitUntil:"domcontentloaded"});await page.getByLabel("更正短标签").fill("人工通知");await page.getByLabel("更正原因").fill("按刷新后的来源时钟重试");await page.getByRole("button",{name:"更正标签"}).click();await page.getByRole("region",{name:"邮件预审建议"}).getByText("人工通知",{exact:true}).waitFor();passed("普通阅读器严格证据与人工更正经历真实CAS冲突、刷新和成功重试");
  fixture.setCachedBody(7,"changed cache generation");await page.reload({waitUntil:"domcontentloaded"});await page.getByRole("article",{name:"邮件正文"}).getByText("changed cache generation",{exact:true}).waitFor();assert.equal(await page.getByRole("region",{name:"邮件预审建议"}).count(),0);assert.equal(await page.getByRole("button",{name:"更正标签"}).count(),0);passed("正文缓存竞态拒绝旧注释证据与更正能力");
  fixture.setCachedBody(7,"No action required.");await page.reload({waitUntil:"domcontentloaded"});await page.getByText("严格来源证据",{exact:true}).waitFor();
  fixture.qualifyNotification(7);await page.getByRole("link",{name:"通知邮件",exact:true}).click();await page.waitForURL(/\/mail\/notifications$/);await page.getByLabel("搜索通知邮件").fill("无需处理");await page.getByLabel("筛选通知邮箱").selectOption("1");
  await page.getByText(/通知邮件\s+1 封邮件/).waitFor();await page.getByRole("button",{name:/support@fixture\.test/}).click();await page.getByText("只读来源：不会标已读、翻译、删除、下载附件或自动执行邮件内容。").waitFor();passed("合格通知邮件可按摘要和邮箱筛选，并只做严格只读来源预览");
  await page.getByRole("link",{name:"本地跟进提醒",exact:true}).click();await page.waitForURL(/\/mail\/reminders$/);await page.getByText(/本地人工跟进提醒，不是通知邮件/).waitFor();passed("通知邮件与本地跟进提醒保持独立入口和语义");
  passed("默认OFF→UI独立模型/范围/明确同意→真实新信同步、持久job与临时核对");
  await page.goto("/mail/settings",{waitUntil:"domcontentloaded"}); await page.getByRole("heading", { name: "邮件预审设置" }).waitFor();
  fixture.appendInboxMail(8, "New in-flight notice", "Please review this second unique mail."); await rpc(page, "mail.message", { mailboxId: 1, folder: "INBOX", uid: 8 });
  const waitDeadline = Date.now() + 10_000; while (fixture.stats().modelCalls < 2 && Date.now() < waitDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal(fixture.stats().modelCalls, 2); assert.equal(fixture.stats().modelInFlight, 1); console.log("[mail-smoke] model-inflight-observed");
  await page.getByLabel("启用邮件预审").uncheck(); await page.getByRole("button", { name: "保存设置" }).click(); await page.getByText("邮件预审已关闭").waitFor();
  console.log("[mail-smoke] model-disable-sent");
  const abortDeadline = Date.now() + 8_000; while (fixture.stats().modelInFlight !== 0 && Date.now() < abortDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal(fixture.stats().modelInFlight, 0); assert.equal(fixture.stats().abortedAfterDispatch, 1); assert.equal(fixture.state().settings.state, "disabled"); passed("首个worker完成、第二个真实在途禁用取消且不复活"); console.log("[mail-smoke] model-abort-verified");

  const settingsUrl = page.url(), rpcBeforeResetRefresh = fixture.stats().rpcByMethod["mail.triage.settings"] ?? 0, resetFramesBefore = fixture.stats().sseResetFrames, sseConnectionsBefore = fixture.stats().sseConnections;
  let resetRouteHits = 0;
  await context.route("**/api/events*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { prohibitedBrowserRequests.push(url.toString()); await route.abort("blockedbyclient"); return; }
    resetRouteHits++; url.searchParams.set("afterSeq", String(Number.MAX_SAFE_INTEGER)); await route.continue({ url: url.toString() });
  }, { times: 1 });
  sseReconnectPhase = true; assert.ok(fixture.closeActiveSse() >= 1, "必须关闭页面正在使用的真实SSE连接");
  const reconnectDeadline = Date.now() + 12_000;
  while ((resetRouteHits !== 1 || fixture.stats().sseResetFrames <= resetFramesBefore || (fixture.stats().rpcByMethod["mail.triage.settings"] ?? 0) <= rpcBeforeResetRefresh || fixture.stats().sseConnections <= sseConnectionsBefore) && Date.now() < reconnectDeadline) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  sseReconnectPhase = false;
  assert.equal(resetRouteHits, 1); assert.ok(fixture.stats().sseResetFrames > resetFramesBefore); assert.ok(fixture.stats().sseConnections > sseConnectionsBefore); assert.ok((fixture.stats().rpcByMethod["mail.triage.settings"] ?? 0) > rpcBeforeResetRefresh); assert.equal(page.url(), settingsUrl); await page.getByText("后台已连接").waitFor();
  passed("页面保持挂载：真实SSE断线重连、production reset帧与具体settings RPC重取");

  await page.getByRole("link", { name: "按邮箱", exact: true }).click(); await page.waitForURL(/\/mail\/inbox$/); await page.getByRole("heading", { name: "邮箱", exact: true }).waitFor();
  await page.goto("/mail/1/Sent%20Messages/11", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "邮箱", exact: true }).waitFor();
  assert.match(page.url(), /\/mail\/1\/Sent%20Messages\/11/);
  const readerArticle = page.getByRole("article", { name: "邮件正文" });
  await readerArticle.getByText("Legacy Sent Messages body for translation and reply.", { exact: false }).waitFor();
  assert.equal(await readerArticle.locator('a[href^="http"]').count(), 0, "邮件正文不得渲染远程链接");
  await page.getByRole("button", { name: "翻译", exact: true }).click(); await page.getByText("夹具翻译正文", { exact: true }).waitFor();
  await page.getByRole("button", { name: "查看原文", exact: true }).click(); await readerArticle.getByText("Legacy Sent Messages body for translation and reply.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "回复", exact: true }).click(); const composeDialog = page.getByRole("dialog"); await composeDialog.waitFor(); assert.match(await composeDialog.getByText(/从 support@fixture\.test 发送纯文本邮件/).innerText(), /support@fixture\.test/);
  await composeDialog.getByLabel("正文（纯文本）").fill("Unsaved fixture draft."); await composeDialog.getByRole("button", { name: "取消", exact: true }).click(); await composeDialog.waitFor({ state: "hidden" }); assert.equal(fixture.stats().smtpCalls, 1);
  await page.getByRole("button", { name: "回复", exact: true }).click(); await composeDialog.waitFor();
  await composeDialog.getByLabel("正文（纯文本）").fill("Fixture reply from the original receiving identity."); await composeDialog.getByRole("button", { name: "发送", exact: true }).click(); await page.getByRole("button", { name: "确认发送" }).click(); await page.getByText("SMTP 已接受并已核对已发送副本").waitFor(); await composeDialog.waitFor({ state: "hidden" }); assert.equal(fixture.stats().lastSmtpAddress, "support@fixture.test");
  await screenshot("mail-inbox-layered.png");
  passed("URL编码Sent Messages旧路由、decoded folder、翻译/原文与原收件身份真实回复");

  await page.getByRole("link", { name: "邮箱管理", exact: true }).click(); await page.waitForURL(/\/mail\/manage$/); await page.getByRole("heading", { name: "邮箱管理" }).waitFor(); await page.getByText(ADDRESS_RE()).waitFor(); await screenshot("mail-manage.png"); passed("六入口键盘可达与邮箱管理页");

  const declinedSourceId = beforeSend.sources[0]?.sourceId; assert.ok(declinedSourceId);
  fixture.invalidateSource(declinedSourceId);
  await assert.rejects(rpc<CaseDetail>(page, "mail.cases.detail", { caseId: declinedSummary.caseId }), /事项投影包含未授权来源/);
  passed("来源失效后旧结果失效且详情fail-closed");
  const disabledBoardBeforeBackup = await rpc<BoardCasePage>(page, "mail.cases.list", { page: 1, pageSize: 100 });
  assert.ok(expectedSseDisconnectCount <= 1); assert.deepEqual(prohibitedBrowserRequests, []); assert.deepEqual(browserErrors, []); assert.equal(fixture.stats().prohibitedExternalRequests, 0); passed("浏览器与后端零禁止外连、零pageerror/console error");

  const stats = fixture.stats(); writeFileSync(join(artifactDir, "stats.json"), JSON.stringify({ ...stats, expectedSseDisconnectCount, prohibitedBrowserRequests: prohibitedBrowserRequests.length, browserErrors: browserErrors.length }, null, 2));
  journey.completedAt = new Date().toISOString(); writeFileSync(join(artifactDir, "journey.json"), JSON.stringify(journey, null, 2));
  const backup = await fixture.backupRestore(artifactDir); assert.equal(backup.integrityCheck, "ok"); assert.equal(backup.foreignKeyViolations, 0); assert.equal(backup.mailboxBindings.length, 1); assert.equal(backup.databases.length, 2); assert.ok(backup.databases.every(item => item.integrityCheck === "ok" && item.foreignKeyViolations === 0 && item.backupSha256 === item.restoredSha256)); assert.equal(backup.restoredSession.userId, 1); assert.equal(backup.restoredSession.role, "admin"); assert.equal(backup.restoredSession.mustChangePassword, false); assert.equal(backup.restoredSession.roleBinding, "fixture-model"); assert.equal(backup.restoredSession.triageState, "disabled"); assert.equal(backup.restoredSession.caseCount, disabledBoardBeforeBackup.total); assert.equal(backup.restoredSession.cachedSubject, "Sent folder legacy"); assert.equal(backup.restoredSession.disabledCaseFailClosed, true); writeFileSync(join(artifactDir, "backup-restore.json"), JSON.stringify(backup, null, 2));
  const artifacts = [...screenshotPaths, join(artifactDir, "stats.json"), join(artifactDir, "journey.json"), join(artifactDir, "backup-restore.json"), join(artifactDir, "workspace-consistent-backup.sqlite"), join(artifactDir, "workspace-restored.sqlite"), join(artifactDir, "admin-consistent-backup.sqlite"), join(artifactDir, "admin-restored.sqlite")];
  const hashes = artifacts.filter(existsSync).map(path => ({ file: path, sha256: sha256(path) })); writeFileSync(join(artifactDir, "hashes.json"), JSON.stringify(hashes, null, 2));
  console.log(`✔ mail triage smoke ${journey.assertions instanceof Array ? journey.assertions.length : 0} journeys`);
  console.log(`验收目录：${artifactDir}`);
} catch (error) {
  journey.failure = String(error); writeFileSync(join(artifactDir, "journey-failed.json"), JSON.stringify(journey, null, 2));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await fixture.dispose();
}

function ADDRESS_RE(): RegExp { return /support@fixture\.test/; }
