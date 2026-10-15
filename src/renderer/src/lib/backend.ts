// 界面侧的后台客户端：拿到预加载脚本转交的 MessagePort 后，提供 call()（请求/响应）和 onEvent()（事件推送）。
// 后台重启时会收到新端口，旧端口上未完成的请求一律以错误结束。
import type { BackendMessage, Request, RunEvent } from "../../../shared/protocol.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let port: MessagePort | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const eventListeners = new Set<(e: RunEvent) => void>();
const changedListeners = new Set<(topic: string) => void>();
const connectListeners = new Set<() => void>();

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data !== "backend-port" || !e.ports[0]) return;
  for (const p of pending.values()) p.reject(new Error("后台已重启，请重试"));
  pending.clear();
  port = e.ports[0];
  port.onmessage = (m: MessageEvent<BackendMessage>) => {
    const msg = m.data;
    if (msg.kind === "event") {
      for (const l of eventListeners) l(msg.event);
      return;
    }
    if (msg.kind === "changed") {
      for (const l of changedListeners) l(msg.topic);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  };
  for (const l of connectListeners) l();
});

export function call<T>(method: string, params?: unknown): Promise<T> {
  if (!port) return Promise.reject(new Error("后台还没连上"));
  const id = nextId++;
  const req: Request = { kind: "req", id, method, params };
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    port!.postMessage(req);
  });
}

export function onEvent(listener: (e: RunEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** 后台通知某类数据变了（例如定时同步完成）。 */
export function onChanged(topic: string, listener: () => void): () => void {
  const l = (t: string) => {
    if (t === topic) listener();
  };
  changedListeners.add(l);
  return () => changedListeners.delete(l);
}

/** 每次（重新）连上后台都会触发；已连上时立即触发一次。 */
export function onConnect(listener: () => void): () => void {
  connectListeners.add(listener);
  if (port) listener();
  return () => connectListeners.delete(listener);
}
