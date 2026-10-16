import type { QaRun, QaView, ReviewIssue } from "../../../shared/protocol.ts";

const LEVEL_ORDER: Record<ReviewIssue["level"], number> = { P1: 0, P2: 1, P3: 2 };

export interface QaIssueGroups {
  open: ReviewIssue[];
  needsYou: ReviewIssue[];
  fixed: ReviewIssue[];
}

export function groupQaIssues(issues: ReviewIssue[]): QaIssueGroups {
  const sort = (items: ReviewIssue[]) => [...items].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.page.localeCompare(b.page, "zh-CN"));
  return {
    open: sort(issues.filter((issue) => issue.status === "open")),
    needsYou: sort(issues.filter((issue) => issue.status === "needs_you")),
    fixed: sort(issues.filter((issue) => issue.status === "fixed")),
  };
}

export function issueTitle(why: string): string {
  const text = why.replace(/\s+/g, " ").trim();
  const first = text.split(/(?<=[。！？.!?])\s*/u)[0] || "复核发现问题";
  return first.length > 56 ? `${first.slice(0, 55)}…` : first;
}

export function qaCounts(issues: ReviewIssue[]) {
  return {
    p1: issues.filter((issue) => issue.level === "P1" && issue.status !== "fixed").length,
    suggestions: issues.filter((issue) => issue.level !== "P1" && issue.status !== "fixed").length,
    needsYou: issues.filter((issue) => issue.status === "needs_you").length,
    fixed: issues.filter((issue) => issue.status === "fixed").length,
    fixable: issues.filter((issue) => issue.status === "open" && issue.fixable === true).length,
  };
}

export function qaPassed(qa: QaView | null): boolean {
  return Boolean(qa?.review?.passed) && !qa?.checks.some((check) => check.level === "block" && !check.ok);
}

export function needsYouGuidance(issue: ReviewIssue): string {
  const text = `${issue.kind} ${issue.page} ${issue.evidence} ${issue.why} ${issue.fix}`.toLowerCase();
  if (/(dimension|measurement|length|width|height|尺寸|长宽高|长度|宽度|高度)/u.test(text)) {
    return "请向供应商核实商品的实际长、宽、高和单位；不同规格尺寸不同时，需要分别提供。";
  }
  if (/(set contents|bundle|included|includes|component|package contains|pieces|套装|包含|组件|配件|件数)/u.test(text)) {
    return "请核实套装实际包含哪些物品、每种数量，以及图片中的配件是否随商品一起出售。";
  }
  if (/(company|business|legal name|identity|address|phone|contact|公司|主体|经营者|地址|电话|联系方式)/u.test(text)) {
    return "当前批次没有直接编辑主体的入口。请提供真实公司法定名称、地址和联系方式，由维护人员更正现有批次的经营主体资料，并同步关于我们、联系我们、政策页面及页脚；不需要重新建站。";
  }
  return "请准备可核对的真实业务或商品资料，并按「怎么改」补齐；系统不会根据页面图片或常见做法猜测。";
}

export function latestQaRun(runs: QaRun[]): QaRun | undefined {
  return [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function activeQaRun(runs: QaRun[]): QaRun | undefined {
  return runs.find((run) => run.status === "running" || run.status === "queued");
}

