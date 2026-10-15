// 界面进程 ↔ 后台进程之间经 MessagePort 传递的消息。

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
  domain: string;
  status: string | null;
  expiresAt: string | null;
  hasWebsite: boolean;
  hasMail: boolean;
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

/** 建站流水线前半段的步骤（顺序即执行顺序） */
export const PROVISION_STEPS = [
  { key: "precheck", name: "预检" },
  { key: "create_site", name: "创建网站" },
  { key: "wait_wordpress", name: "安装 WordPress" },
  { key: "ssl_maintenance", name: "SSL 与维护模式" },
  { key: "woocommerce", name: "安装 WooCommerce" },
  { key: "theme", name: "部署 Obel 主题" },
  { key: "companion", name: "部署伴侣插件" },
  { key: "enroll", name: "注册伴侣插件" },
] as const;
export type StepKey = (typeof PROVISION_STEPS)[number]["key"];

export type SiteStatus = "queued" | "running" | "waiting" | "done" | "failed";

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
}

export interface StepState {
  key: StepKey;
  name: string;
  status: "pending" | "running" | "waiting" | "done" | "skipped" | "failed";
  detail: string | null;
  startedAt: number | null;
  finishedAt: number | null;
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
  | { kind: "changed"; topic: "accounts" | "batches" };

export type BackendMessage = Response | Push;
