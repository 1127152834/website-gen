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

export interface Request {
  kind: "req";
  id: number;
  method: string;
  params?: unknown;
}

export type Response =
  | { kind: "res"; id: number; ok: true; result: unknown }
  | { kind: "res"; id: number; ok: false; error: string };

export interface Push {
  kind: "event";
  event: RunEvent;
}

export type BackendMessage = Response | Push;
