// 用户复核任务：复用持久任务队列与事件表，单站互斥；写入只走可回滚的 L1 变更集。
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PROVISION_STEPS, type QaRun, type QaRunEvent, type ReviewIssue, type SiteReview } from "../shared/protocol.ts";
import { enqueue, type Job } from "./jobs.ts";
import { siteContext, type PipelineDeps, type StepCtx } from "./pipeline.ts";
import { collectReviewSnapshot, planReviewIssueFix, runFullSiteReview, type ReviewFinding, type ReviewSnapshot, type ReviewAction } from "./review.ts";
import { siteTools } from "./site-tools.ts";
import { runQa, type QaReport } from "./store.ts";
import { completeVision } from "./vision.ts";
import { PROVISION_JOB } from "./batches.ts";

export const QA_JOB = "qa-review";
interface RunRequest { siteId: number; kind: QaRun["kind"]; issueId?: string }
interface StoredEvent { payload_json: string }
interface JobRow { id: number; site_id: number; status: string; created_at: number; updated_at: number; last_error: string | null }
const reportFor = (ctx: StepCtx): QaReport => JSON.parse(ctx.site.qa_json ?? "{}") as QaReport;
const eventsForRun = (db: DatabaseSync, runId: string): (QaRunEvent & { runKind?: QaRun["kind"]; result?: QaRun["result"]; initialOpenIds?: string[]; initialNeedsYou?: ReviewIssue[] })[] =>
  (db.prepare("SELECT payload_json FROM run_events WHERE json_extract(payload_json, '$.qaRunId') = ? ORDER BY seq").all(runId) as unknown as StoredEvent[])
    .map((row) => JSON.parse(row.payload_json));

export function qaRuns(db: DatabaseSync, siteId: number): QaRun[] {
  if (!Number.isInteger(siteId) || siteId <= 0) throw new Error("站点编号无效");
  const rows = db.prepare("SELECT id, site_id, status, created_at, updated_at, last_error FROM jobs WHERE type = ? AND site_id = ? ORDER BY id DESC LIMIT 20").all(QA_JOB, siteId) as unknown as JobRow[];
  return rows.map((row) => {
    const events = eventsForRun(db, String(row.id));
    const terminal = events.findLast((event) => event.stage === "finished" || event.stage === "failed");
    const status: QaRun["status"] = terminal ? terminal.stage === "failed" ? "error" : "done"
      : row.status === "failed" ? "error" : row.status === "done" ? "done" : row.status === "running" ? "running" : "queued";
    return { id: String(row.id), siteId, kind: events[0]?.runKind ?? "recheck", status, createdAt: row.created_at, events,
      ...(status === "done" || status === "error" ? { finishedAt: terminal?.at ?? row.updated_at } : {}),
      ...(terminal?.result ? { result: terminal.result } : {}),
      ...(status === "error" ? { error: terminal?.message ?? row.last_error ?? "复核任务未完成，请重试" } : {}),
    };
  });
}

export function startQaRun(d: PipelineDeps, request: RunRequest): { runId: string } {
  const { siteId, kind, issueId } = request;
  if (!Number.isInteger(siteId) || siteId <= 0 || !["fixIssue", "fixAll", "recheck"].includes(kind)) throw new Error("复核任务参数无效");
  const ctx = siteContext(d, siteId);
  if (kind === "fixIssue") {
    const issue = reportFor(ctx).review?.issues.find((issue) => issue.id === issueId);
    if (!issue || issue.status === "fixed") throw new Error("这个问题已处理或不存在，请刷新复核报告");
    if (issue.status === "needs_you") throw new Error("这个问题需要你补充真实资料，不能自动修复；请按「怎么改」补齐后重新复核");
  }
  // 同步事务先占位，RPC 不等待模型或浏览器；同时拦住正在建站的 QA，避免相互覆盖。
  d.db.exec("BEGIN IMMEDIATE");
  try {
    const active = d.db.prepare("SELECT 1 FROM jobs WHERE site_id = ? AND type IN (?, ?) AND status IN ('queued', 'running') LIMIT 1").get(siteId, QA_JOB, PROVISION_JOB);
    if (active) throw new Error("这个站点已有建站或复核任务正在运行，请等当前任务结束后再试");
    const now = d.now();
    const id = enqueue(d.db, QA_JOB, siteId, now);
    // 不让通用队列在不确定的远端写入后盲目重试。重启恢复也会读取已尝试的问题记录。
    d.db.prepare("UPDATE jobs SET max_attempts = 1 WHERE id = ?").run(id);
    const initialIssues = reportFor(ctx).review?.issues ?? [];
    d.emit({ batchId: ctx.site.batch_id, siteId, kind: "step", payload: { qaRunId: String(id), runKind: kind, at: now, stage: "queued", level: "info", message: "任务已排队，准备开始复核", initialOpenIds: initialIssues.filter((issue) => issue.status !== "fixed").map((issue) => issue.id), initialNeedsYou: initialIssues.filter((issue) => issue.status === "needs_you").map(({ shot: _shot, ...issue }) => issue), ...(issueId ? { issueId } : {}) } });
    d.db.exec("COMMIT");
    return { runId: String(id) };
  } catch (error) { d.db.exec("ROLLBACK"); throw error; }
}

function affectedUrls(snapshot: ReviewSnapshot, issue: ReviewIssue, action?: ReviewAction): string[] {
  const origin = new URL(issue.url).origin;
  const urls = new Set([issue.url]);
  const targets = snapshot.allTargets ?? snapshot.targets;
  if (action?.tool === "update_copy") {
    // 店铺文案包含全站标语，所有已发布目标都受影响。
    for (const target of targets) urls.add(new URL(target.path, origin).href);
  } else if (action?.tool === "update_policy") {
    const path = { shipping: "/shipping/", returns: "/returns/", privacy: "/privacy-policy/", terms: "/terms/" }[String(action.params.name)];
    if (path) urls.add(new URL(path, origin).href);
  } else if (action?.tool.startsWith("update_product")) {
    for (const target of targets.filter((target) => target.path === "/" || target.kind === "archive" || target.kind === "category" || (target.kind === "product" && target.targetId === action.params.id))) urls.add(new URL(target.path, origin).href);
  }
  return [...urls];
}

function persistAcceptance(ctx: StepCtx, report: QaReport) {
  ctx.save("qa_json", JSON.stringify(report));
  const failures = report.checks.filter((check) => check.level === "block" && !check.ok);
  const passed = Boolean(report.review?.passed) && !report.review?.issues.some((issue) => issue.level === "P1" && issue.status !== "fixed") && failures.length === 0;
  const at = ctx.d.now();
  const detail = passed ? "复核通过，所有必须解决的问题已处理" : `复核未通过：${failures.length} 项规则未通过，仍需处理复核问题`;
  ctx.d.db.prepare(`INSERT INTO provision_steps (site_id, step, status, detail, started_at, finished_at) VALUES (?, 'qa', ?, ?, ?, ?)
    ON CONFLICT (site_id, step) DO UPDATE SET status = excluded.status, detail = excluded.detail, finished_at = excluded.finished_at`).run(ctx.site.id, passed ? "done" : "failed", detail, at, at);
  // 与流水线相同：其他步骤没有完成时，不能仅凭 QA 把整个站点标成完成。
  const completed = ctx.d.db.prepare("SELECT step FROM provision_steps WHERE site_id = ? AND status IN ('done', 'skipped')").all(ctx.site.id) as { step: string }[];
  if (passed && PROVISION_STEPS.every((step) => completed.some((row) => row.step === step.key))) ctx.d.db.prepare("UPDATE sites SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?").run(at, ctx.site.id);
  else if (!passed) ctx.d.db.prepare("UPDATE sites SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?").run(detail, at, ctx.site.id);
  ctx.emit("step", { step: "qa", status: passed ? "done" : "failed", detail });
  return passed;
}

export async function runQaJob(d: PipelineDeps, job: Job): Promise<void> {
  const runId = String(job.id);
  const previousEvents = eventsForRun(d.db, runId);
  if (previousEvents.some((event) => event.stage === "finished" || event.stage === "failed")) return;
  const kind = previousEvents[0]?.runKind ?? "recheck";
  const issueId = previousEvents[0]?.issueId;
  let ctx: StepCtx | undefined;
  const emit = (event: Omit<QaRunEvent, "at"> & { result?: QaRun["result"] }) => d.emit({ batchId: ctx?.site.batch_id ?? 0, siteId: job.siteId!, kind: event.level === "error" ? "error" : event.level === "warning" ? "warn" : "step", payload: { qaRunId: runId, at: d.now(), ...event } });
  try {
    ctx = siteContext(d, job.siteId!);
    emit({ stage: "started", level: "info", message: kind === "recheck" ? "开始重新复核，不修改网站内容" : "开始修复；所有修改都会记录为可回滚变更" });
    const initial = reportFor(ctx).review;
    const initialOpen = new Set(previousEvents[0]?.initialOpenIds ?? initial?.issues.filter((issue) => issue.status !== "fixed").map((issue) => issue.id));
    const manualIssues = new Map((previousEvents[0]?.initialNeedsYou ?? initial?.issues.filter((issue) => issue.status === "needs_you") ?? []).map((issue) => [issue.id, issue]));
    const attempted = new Set(previousEvents.filter((event) => event.stage === "attempt").map((event) => event.issueId));
    const vision = d.vision ?? ((prompt, images) => completeVision(d.db, d.key, prompt, images, d.fetch));
    const loginUrl = async () => {
      const result = await ctx!.hx("wordpress_login_create-links", { username: ctx!.site.hostinger_username, software: ctx!.site.wp_software_id }) as { login: string };
      return `https://${result.login.replace(/^https?:\/\//, "")}`;
    };
    const outDir = join(d.workDir, "qa", ctx.domain, `run-${runId}`);
    let review: SiteReview | undefined = initial;
    let report: QaReport | undefined;
    const skipped = new Set<string>();
    for (let round = 0; round < (kind === "fixAll" ? 2 : 1); round++) {
      let urls: string[] | undefined;
      if (kind !== "recheck") {
        const current = reportFor(ctx);
        const candidates = (current.review?.issues ?? []).filter((issue) => issue.status !== "fixed" && (kind !== "fixIssue" || issue.id === issueId));
        let snapshot: ReviewSnapshot | undefined;
        for (const issue of candidates) {
          if (issue.status === "needs_you") {
            if (!skipped.has(issue.id)) emit({ stage: "skipped", level: "warning", issueId: issue.id, message: "需要你补充真实资料，未自动修改。请按问题中的「怎么改」补齐后重新复核" });
            skipped.add(issue.id); continue;
          }
          if (attempted.has(issue.id)) {
            if (!skipped.has(issue.id)) emit({ stage: "skipped", level: "warning", issueId: issue.id, message: "本次任务已经尝试过这个问题，不重复写入；将根据最新页面重新复核" });
            skipped.add(issue.id); continue;
          }
          attempted.add(issue.id);
          // 尝试记录在规划/写入之前落盘，崩溃恢复后不重复写同一问题。
          emit({ stage: "attempt", level: "info", issueId: issue.id, message: `正在为「${issue.page}」的问题制定修复方案` });
          try {
            snapshot ??= await collectReviewSnapshot(ctx, await loginUrl(), outDir, kind === "fixIssue" && issue.page !== "全站" && issue.page !== "Site-wide" ? [issue.url] : undefined);
            const finding: ReviewFinding = current.reviewFindings?.find((finding) => finding.issue.id === issue.id) ?? { issue, needsRealData: false };
            const action = await planReviewIssueFix(ctx, snapshot, { ...finding, issue }, vision);
            emit({ stage: "planned", level: action ? "success" : "warning", issueId: issue.id, message: action ? `已生成安全修复方案：${actionName(action.tool)}` : "没有可安全执行的修复方案，请根据「怎么改」手动处理" });
            if (!action) { emit({ stage: "skipped", level: "warning", issueId: issue.id, message: "缺少可验证的修改依据，未写入网站" }); continue; }
            if (kind === "fixIssue") urls = affectedUrls(snapshot, issue, action);
            const tool = siteTools(ctx, "you").find((tool) => tool.name === action.tool && tool.risk === "L1");
            if (!tool) { emit({ stage: "skipped", level: "warning", issueId: issue.id, message: "修复动作不在允许列表，未写入网站" }); continue; }
            const result = await tool.run({ ...action.params, summary: `QA 任务 #${runId} / 问题 ${issue.id}：${String(action.params.summary ?? actionName(action.tool))}` });
            if (result.ok !== true || typeof result.change_id !== "number") {
              emit({ stage: "skipped", level: "warning", issueId: issue.id, message: result.ok === true ? "内容与当前一致，没有新增修改；将重新复核" : "修改未通过安全校验，未写入；请核对真实资料和问题建议" });
            } else {
              emit({ stage: "applied", level: "success", issueId: issue.id, changesetId: result.change_id, message: `${actionName(action.tool)}，已记录变更 #${result.change_id}，可在变更记录中回滚` });
            }
          } catch (error) {
            emit({ stage: "skipped", level: "warning", issueId: issue.id, message: `修复未完成，保留问题：${error instanceof Error ? error.message : "请检查资料与连接后重试"}` });
          }
        }
        if (kind === "fixIssue" && !urls) {
          const target = candidates[0];
          if (target && target.page !== "全站" && target.page !== "Site-wide") urls = [target.url];
        }
      }
      emit({ stage: "review-start", level: "info", message: `${kind === "fixAll" ? `第 ${round + 1} 轮：` : ""}重新抓取${urls ? "受影响页面" : "全站页面"}并复核` });
      review = await runFullSiteReview(ctx, { loginUrl, outDir, vision, maxRounds: 0, ...(urls ? { urls } : {}), onProgress: ({ page, index, total }) => emit({ stage: "review-page", level: "info", message: `正在复核页面 ${index}/${total}：${page}` }) });
      if (kind !== "recheck" && manualIssues.size) {
        // 自动修改标语/图片也会改变原有事实哈希，不能因此把人工资料问题当作已补齐。
        // 固定保留本次开始时的人工门槛；经营者补充资料后，须主动「重新复核」再验收。
        const issues = new Map(review.issues.map((issue) => [issue.id, issue]));
        for (const [id, old] of manualIssues) issues.set(id, { ...(issues.get(id) ?? old), status: "needs_you", fixable: false });
        review = { ...review, issues: [...issues.values()], passed: ![...issues.values()].some((issue) => issue.level === "P1" && issue.status !== "fixed") };
        const checkpoint = reportFor(ctx);
        checkpoint.review = review;
        checkpoint.reviewFindings = checkpoint.reviewFindings?.map((finding) => manualIssues.has(finding.issue.id) ? { ...finding, issue: issues.get(finding.issue.id)!, needsRealData: true, action: undefined } : finding);
        ctx.save("qa_json", JSON.stringify(checkpoint));
      }
      // 规则验收也读最新状态。单项修复不再抓不相关页面，保留原有浏览器验收记录。
      report = await runQa(ctx, { review, skipBrowse: kind === "fixIssue" });
      ctx.save("qa_json", JSON.stringify(report));
      if (kind !== "fixAll" || !review.issues.some((issue) => issue.status === "open" && !attempted.has(issue.id))) break;
    }
    if (!review || !report) throw new Error("没有生成复核报告，请重新复核");
    d.db.exec("BEGIN IMMEDIATE");
    try {
      const passed = persistAcceptance(ctx, report);
      const result = { fixed: review.issues.filter((issue) => issue.status === "fixed" && (initialOpen.has(issue.id) || attempted.has(issue.id))).length, remainingP1: review.issues.filter((issue) => issue.level === "P1" && issue.status !== "fixed").length, passed };
      emit({ stage: "finished", level: passed ? "success" : "warning", result, message: `已修复 ${result.fixed} 项，剩余 ${result.remainingP1} 项必须解决的问题；${passed ? "复核已通过" : "复核未通过，请继续处理"}` });
      d.db.exec("COMMIT");
    } catch (error) { d.db.exec("ROLLBACK"); throw error; }
  } catch (error) {
    const message = `复核任务未完成：${error instanceof Error ? error.message : "请检查连接后重试"}`;
    // 外部验收中断时也撤销旧的通过标记，不把旧规则行当成本轮证据。
    const current = ctx ? reportFor(ctx) : undefined;
    const result = { fixed: 0, remainingP1: current?.review?.issues.filter((issue) => issue.level === "P1" && issue.status !== "fixed").length ?? 0, passed: false };
    if (ctx && current) {
      current.at = d.now();
      current.checks = [...(current.checks ?? []).filter((check) => check.id !== "ai-review"), { id: "ai-review", name: "整站 AI 文字与视觉复核", level: "block", ok: false, detail: message }];
      if (current.review) current.review.passed = false;
      d.db.exec("BEGIN IMMEDIATE");
      try { persistAcceptance(ctx, current); emit({ stage: "failed", level: "error", message, result }); d.db.exec("COMMIT"); }
      catch (persistError) { d.db.exec("ROLLBACK"); throw persistError; }
    } else emit({ stage: "failed", level: "error", message, result });
  }
}

function actionName(tool: string): string {
  return ({ update_product_main_image: "更新商品主图", update_product_variation_images: "更新商品规格图片", update_product: "更新商品文案", update_copy: "更新店铺文案", update_policy: "更新政策正文", update_meta: "更新页面摘要", update_product_categories: "更新商品分类" } as Record<string, string>)[tool] ?? "更新页面内容";
}
