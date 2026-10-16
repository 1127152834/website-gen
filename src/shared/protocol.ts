// 界面 ↔ 用户工作区：HTTP RPC 请求/响应，SSE 推送；事件 seq 仍用于日志补发。

export type RunEventKind = "step" | "mcp" | "ai_text" | "ai_thinking" | "ai_tool" | "warn" | "error";

/** 进度和 AI 日志的唯一来源（对应 run_events 表），界面按 seq 补发。 */
export interface RunEvent {
  seq: number;
  ts: number;
  batchId: string | null;
  siteId: string | null;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface AccountSummary {
  id: number;
  label: string;
  /** Token 末 4 位，只用于辨认 */
  tokenHint: string;
  status: "new" | "ok" | "auth_failed" | "error";
  lastError: string | null;
  lastSyncedAt: number | null;
  counts: { orders: number; websites: number; domains: number; mailOrders: number };
}

export interface DomainSummary {
  /** Hostinger 的域名 ID（同一账号内唯一；待设置的域名没有名字，只能靠它区分） */
  id: number;
  /** 待设置的域名为空字符串 */
  domain: string;
  status: string | null;
  expiresAt: string | null;
  hasWebsite: boolean;
  hasMail: boolean;
  /** 已进入放弃流程的域名永久不再进入新批次。 */
  abandoned?: boolean;
}

/** 模型用途：agent 对话与建站，vision 看截图，bulk 批量文案，review 合规审查 */
export type ModelRole = "agent" | "vision" | "bulk" | "review";

export interface ProviderSummary {
  id: number;
  name: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  hasKey: boolean;
  /** Key 末 4 位 */
  keyHint: string | null;
  models: { id: string; name: string; vision: boolean; thinkingLevels: string[] }[];
}

export interface RoleSummary {
  role: ModelRole;
  providerId: number;
  modelId: string;
  thinking: string;
  ready: boolean;
  /** 不可用的原因，可用时为 null */
  problem: string | null;
}

/** 建站流水线的步骤（顺序即执行顺序）：前 12 步在 Hostinger 上搭站（含邮箱和发信），后 6 步填内容并验收 */
export const PROVISION_STEPS = [
  { key: "precheck", name: "预检" },
  { key: "create_site", name: "创建网站" },
  { key: "wait_wordpress", name: "安装 WordPress" },
  { key: "ssl_maintenance", name: "SSL 与维护模式" },
  { key: "woocommerce", name: "安装 WooCommerce" },
  { key: "plugins_cleanup", name: "卸载多余插件" },
  { key: "theme", name: "部署 Obel 主题" },
  { key: "companion", name: "部署伴侣插件" },
  { key: "enroll", name: "注册伴侣插件" },
  { key: "mailbox", name: "客服邮箱" },
  { key: "mail_dns", name: "邮件 DNS" },
  { key: "smtp", name: "交易邮件发信" },
  { key: "products_pick", name: "从 CJ 选品" },
  { key: "content", name: "AI 撰写文案与政策" },
  { key: "store_setup", name: "配置商店" },
  { key: "pages", name: "创建页面" },
  { key: "products", name: "上架商品" },
  { key: "qa", name: "QA 验收" },
] as const;
export type StepKey = (typeof PROVISION_STEPS)[number]["key"];

export type SiteStatus = "queued" | "running" | "waiting" | "done" | "failed" | "abandoned";

export interface FreeDomain {
  domain: string;
  accountId: number;
  accountLabel: string;
  hasMail: boolean;
  expiresAt: string | null;
}

export interface BatchSummary {
  id: number;
  createdAt: number;
  total: number;
  done: number;
  failed: number;
  active: number;
}

export interface SiteProgress {
  id: number;
  batchId: number;
  domain: string;
  status: SiteStatus;
  /** 已完成的步骤数 */
  completed: number;
  /** 当前（或失败时停住的）步骤 */
  currentStep: string | null;
  lastError: string | null;
  updatedAt: number;
  /** 一键上线的时间；为空表示还在维护模式 */
  launchedAt: number | null;
}

export interface StepState {
  key: StepKey;
  name: string;
  status: "pending" | "running" | "waiting" | "done" | "skipped" | "failed";
  detail: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

/** sites.qa 返回给界面的 QA 报告：规则检查 + 截图（已转成 data URL）+ 整站 AI 复核 */
export interface QaView {
  at: number;
  checks: { id: string; name: string; level: "block" | "warn"; ok: boolean; detail: string }[];
  shots: { name: string; src: string }[];
  /** 阶段三的整站 AI 复核；旧站或复核没跑时为空 */
  review?: SiteReview;
}

/** 整站 AI 复核：逐页对照店铺规则和商品资料找问题，能修的自动修（最多 2 轮），修不了的留给你 */
export interface SiteReview {
  at: number;
  /** 自动修复实际跑了几轮（0–2） */
  rounds: number;
  /** 没有未解决的 P1 才算通过 */
  passed: boolean;
  issues: ReviewIssue[];
}

export interface ReviewIssue {
  /** 跨轮次稳定，用来对照同一个问题修没修好 */
  id: string;
  /** P1 阻断上线；P2 应该改；P3 建议 */
  level: "P1" | "P2" | "P3";
  kind: "copy" | "policy" | "product" | "visual" | "seo" | "config" | "other";
  /** 页面名，如「商品：Travel Duffel」「退货政策」 */
  page: string;
  url: string;
  /** 页面原文或截图里看到的情况 */
  evidence: string;
  why: string;
  fix: string;
  /** fixed = AI 已修并复核通过；open = 还没修好；needs_you = 需要你补真实资料（尺寸、套装组件、材质等） */
  status: "fixed" | "open" | "needs_you";
  /** 相关截图（data URL），可选 */
  shot?: string;
}

/** 站点页列出的站（流程已完成的） */
export interface SiteListItem {
  id: number;
  domain: string;
  launchedAt: number | null;
}

/** pi 对话的历史记录（来自 pi 的会话文件） */
export type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; thinking: string; error?: string }
  | { role: "tool"; id: string; name: string; args: unknown; ok: boolean | null; result: string };

/** 回复进行中推给界面的流式事件；回合结束（settled）后界面重新拉历史 */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean; result: string }
  | { type: "settled"; aborted: boolean }
  | { type: "error"; message: string };

/** 高风险动作只在当前用户的助手面板里授权；参数已经过敏感字段清理。 */
export interface AssistantConfirmation {
  id: string;
  name: string;
  description: string;
  args: unknown;
  expiresAt: number;
}

export type AssistantEvent = ChatEvent
  | ({ type: "confirm" } & AssistantConfirmation)
  | { type: "confirm_resolved"; id: string; approved: boolean };

/** 一条内容变更集 */
export interface ChangeSummary {
  id: number;
  summary: string;
  initiator: "pi" | "you" | "schedule";
  status: "applied" | "reverted";
  createdAt: number;
  revertAt: number | null;
  revertedAt: number | null;
  /** 定时恢复失败的原因 */
  revertError: string | null;
  /** 改了哪些对象 */
  targets: string[];
}

/** 邮件 DNS 的一项检查 */
export interface MailDnsCheck {
  key: "MX" | "SPF" | "DKIM" | "DMARC";
  ok: boolean;
  detail: string;
}

export interface MailDnsResult {
  /** 域名的 DNS 是否由 Hostinger 管理（只有这样才能自动修） */
  atHostinger: boolean;
  checks: MailDnsCheck[];
  /** 自动修复写入了哪些记录 */
  fixed: string[];
  /** DNS 不在 Hostinger 时，需要你在 DNS 服务商那里添加的记录 */
  manual: string[];
  /** 只检查时：修复会写入哪些记录 */
  planned: string[];
  snapshotId: number | null;
}

export interface MailStatus {
  email: string;
  /** 客服邮箱在不在本站域名上（不在就不归我们管） */
  onDomain: boolean;
  hasOrder: boolean;
  /** 邮箱状态（active 等），还没建为 null */
  mailbox: string | null;
  /** 流水线建邮箱时保存了密码 */
  passwordSaved: boolean;
  /** 有 Hostinger 邮箱订单时才检查 DNS */
  dns: MailDnsResult | null;
}

/** 交易邮件发信设置（站点上伴侣插件的 SMTP） */
export interface SmtpStatus {
  enabled: boolean;
  host: string | null;
  username: string | null;
  /** 这台电脑上保存了客服邮箱的密码（流水线新建的，或你在站点页填过） */
  passwordSaved: boolean;
}

export interface Request {
  kind: "req";
  id: number;
  method: string;
  params?: unknown;
}

export type Response =
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string };

export type Push =
  | { kind: "event"; event: RunEvent }
  // 某类数据在后台变了（例如定时同步完成），界面收到后重新拉取
  | { kind: "changed"; topic: "accounts" | "batches" | "changes" | "mail" }
  // 邮件只推送索引变动；正文始终通过当前用户的工作区读取。
  | { kind: "mail"; event: MailEvent }
  | { kind: "assistant"; event: AssistantEvent }
  // pi 对话的流式输出，只推不存（历史在 pi 的会话文件里）
  | { kind: "chat"; siteId: number; event: ChatEvent };

export type BackendMessage = Response | Push;

export interface MailEvent {
  type: "new" | "changed";
  mailboxId: number;
  folder?: string;
  uid?: number;
  unreadCount?: number;
}
