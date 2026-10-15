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
  | { kind: "changed"; topic: "accounts" };

export type BackendMessage = Response | Push;
