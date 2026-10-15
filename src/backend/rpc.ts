import type { Request, Response } from "../shared/protocol.ts";

export type Handlers = Record<string, (params: unknown) => unknown>;

/** 把一条请求交给对应的方法；任何错误都变成错误响应，后台进程不因单个请求崩溃。 */
export async function handleRequest(handlers: Handlers, req: Request): Promise<Response> {
  const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
  if (!handler) return { kind: "res", id: req.id, ok: false, error: `unknown method: ${req.method}` };
  try {
    return { kind: "res", id: req.id, ok: true, result: await handler(req.params) };
  } catch (e) {
    return { kind: "res", id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
