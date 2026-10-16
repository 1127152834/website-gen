// 界面侧的后台客户端：RPC 走同源 HTTP，后台推送走按用户隔离的 SSE。
// SSE 每次重连都会带上最后收到的 seq，让服务端补发断线期间的消息。
import type { AssistantEvent, BackendMessage, ChatEvent, Request, Response, RunEvent } from "../../../shared/protocol.ts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { apiRequest, getCurrentUser, HttpError } from "./auth.ts";
import { RpcCache, stableRpcParams, type RpcCacheSnapshot } from "./rpc-cache.ts";

type AuthProblem = "unauthenticated" | "password_required" | "identity_changed";
type SseEnvelope = { seq: number; reset?: boolean; message?: BackendMessage } & Partial<BackendMessage>;

let nextId = 1;
let lastSeq = 0;
let source: EventSource | null = null;
let retryTimer: number | null = null;
let retryDelay = 500;
let generation = 0;
let connected = false;
let expectedUserId: number | null = null;

const eventListeners = new Set<(e: RunEvent) => void>();
const changedListeners = new Set<(topic: string) => void>();
const connectListeners = new Set<() => void>();
const readyListeners = new Set<() => void>();
const statusListeners = new Set<(connected: boolean) => void>();
const chatListeners = new Set<(siteId: number, e: ChatEvent) => void>();
const assistantListeners = new Set<(event: AssistantEvent) => void>();
export type MailPushEvent = { type: "new" | "changed"; mailboxId: number; folder?: string; uid?: number; unreadCount?: number };
const mailListeners = new Set<(event: MailPushEvent) => void>();

function reportAuthProblem(problem: AuthProblem): void {
  window.dispatchEvent(new CustomEvent<AuthProblem>("website-gen:auth", { detail: problem }));
}

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  for (const listener of statusListeners) listener(value);
  if (value) for (const listener of connectListeners) listener();
}

function dispatch(message: BackendMessage): void {
  if (message.kind === "event") {
    for (const listener of eventListeners) listener(message.event);
  } else if (message.kind === "changed") {
    for (const listener of changedListeners) listener(message.topic);
  } else if (message.kind === "chat") {
    for (const listener of chatListeners) listener(message.siteId, message.event);
  } else if (message.kind === "assistant") {
    for (const listener of assistantListeners) listener(message.event);
  } else if (message.kind === "mail") {
    for (const listener of mailListeners) listener(message.event);
  }
}

function scheduleReconnect(currentGeneration: number): void {
  if (currentGeneration !== generation || retryTimer != null) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    openEvents(currentGeneration);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 10_000);
}

async function recoverEvents(currentGeneration: number): Promise<void> {
  try {
    const user = await getCurrentUser();
    if (currentGeneration !== generation) return;
    if (expectedUserId == null || user.id !== expectedUserId) {
      reportAuthProblem("identity_changed");
      return;
    }
    if (user.mustChangePassword) {
      reportAuthProblem("password_required");
      return;
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      reportAuthProblem("unauthenticated");
      return;
    }
  }
  scheduleReconnect(currentGeneration);
}

function openEvents(currentGeneration: number): void {
  if (currentGeneration !== generation) return;
  const query = lastSeq > 0 ? `?afterSeq=${encodeURIComponent(lastSeq)}` : "";
  source = new EventSource(`/api/events${query}`);
  source.onopen = () => {
    if (currentGeneration !== generation) return;
    retryDelay = 500;
    setConnected(true);
  };
  source.onmessage = (event) => {
    if (currentGeneration !== generation) return;
    try {
      const envelope = JSON.parse(event.data) as SseEnvelope;
      if (envelope.reset) {
        if (Number.isSafeInteger(envelope.seq)) lastSeq = envelope.seq;
        // 服务端重启或补发缓冲缺口后，重新拉取各页持久化状态；不重置 React 页面本身。
        for (const listener of connectListeners) listener();
        return;
      }
      if (!Number.isSafeInteger(envelope.seq) || envelope.seq <= lastSeq) return;
      const message = envelope.message ?? envelope as BackendMessage;
      lastSeq = envelope.seq;
      dispatch(message);
    } catch (error) {
      console.warn("忽略无法解析的后台推送", error);
    }
  };
  source.onerror = () => {
    if (currentGeneration !== generation) return;
    source?.close();
    source = null;
    setConnected(false);
    void recoverEvents(currentGeneration);
  };
}

// 页面组件的 effect 比外层启动传输的 effect 先跑：深链接直接打开时，首批请求在这里等传输启动
let startWaiters: (() => void)[] = [];
function waitForStart(ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = window.setTimeout(() => {
      startWaiters = startWaiters.filter((waiter) => waiter !== done);
      reject(new Error("后台还没连上"));
    }, ms);
    startWaiters.push(done);
  });
}

/** 登录成功后启动；resetSeq 确保新会话绝不会收到上个用户的补发游标。 */
export function startBackendTransport(userId: number, resetSeq = false): void {
  stopBackendTransport(resetSeq);
  expectedUserId = userId;
  rpcCache.setUser(userId);
  for (const listener of readyListeners) listener();
  const currentGeneration = generation;
  openEvents(currentGeneration);
  const waiters = startWaiters;
  startWaiters = [];
  for (const waiter of waiters) waiter();
}

/** 注销或会话失效时立即切断推送，并清空用户相关传输状态。 */
export function stopBackendTransport(resetSeq = true): void {
  generation++;
  expectedUserId = null;
  rpcCache.setUser(null);
  source?.close();
  source = null;
  if (retryTimer != null) window.clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = 500;
  setConnected(false);
  if (resetSeq) {
    lastSeq = 0;
    nextId = 1;
  }
}

export async function call<T>(method: string, params?: unknown): Promise<T> {
  if (expectedUserId == null) await waitForStart();
  const requestGeneration = generation;
  const requestUserId = expectedUserId;
  const id = nextId++;
  const request: Request = { kind: "req", id, method, params };
  try {
    const response = await apiRequest<Response>("/api/rpc", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (requestGeneration !== generation || requestUserId !== expectedUserId) throw new Error("登录状态已变化，请重试");
    if (response.kind !== "res" || response.id !== id) throw new Error("后台返回了不匹配的响应");
    if (!response.ok) throw new Error(response.error);
    return response.result as T;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      stopBackendTransport();
    } else if (error instanceof HttpError && error.status === 403 && error.code === "password_required") {
      stopBackendTransport();
    }
    throw error;
  }
}

const rpcCache = new RpcCache((method, params) => call(method, params));
const DISABLED_RPC_SNAPSHOT: RpcCacheSnapshot = Object.freeze({ data: undefined, error: null, refreshing: false });

export type RpcDataOptions<T> = {
  topics?: readonly string[];
  enabled?: boolean;
  debounceMs?: number;
  /** 复用同一套按用户隔离的缓存承载少量非 RPC 读接口（例如管理员用户列表）。 */
  loader?: () => Promise<T>;
};

export type RpcDataResult<T> = RpcCacheSnapshot<T> & {
  loading: boolean;
  refresh: () => Promise<T | undefined>;
  invalidate: () => void;
};

/**
 * 按当前登录用户、方法和稳定参数缓存首屏读取。再次进入页面时同步返回旧值，随后后台校准。
 * params=null 或 enabled=false 时不发请求；同 key 的并发刷新由 RpcCache 合并。
 */
export function useRpcData<T>(method: string, params?: unknown | null, options: RpcDataOptions<T> = {}): RpcDataResult<T> {
  const paramsKey = stableRpcParams(params);
  const stableParams = useMemo(() => params, [paramsKey]);
  const enabled = options.enabled !== false && params !== null;
  const loader = options.loader;
  const fetcher = useMemo(() => loader ? () => loader() : undefined, [loader]);
  const subscribe = useCallback((listener: () => void) => enabled ? rpcCache.subscribe(method, stableParams, listener) : () => undefined, [enabled, method, paramsKey]);
  const getSnapshot = useCallback(() => enabled ? rpcCache.snapshot<T>(method, stableParams) : DISABLED_RPC_SNAPSHOT as RpcCacheSnapshot<T>, [enabled, method, paramsKey]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const refresh = useCallback(() => enabled
    ? rpcCache.refresh<T>(method, stableParams, fetcher).then((value) => value as T | undefined)
    : Promise.resolve(undefined), [enabled, method, paramsKey, fetcher]);
  const invalidate = useCallback(() => {
    if (enabled) rpcCache.invalidate(method, stableParams);
  }, [enabled, method, paramsKey]);
  const topicsKey = (options.topics ?? []).join("\u0000");
  const debounceMs = options.debounceMs ?? 200;

  useEffect(() => {
    if (!enabled) return;
    const refreshQuietly = () => { void refresh().catch(() => undefined); };
    let primed = false;
    const disposers = [onBackendReady(() => {
      primed = true;
      void refresh().catch(() => { primed = false; });
    }), onConnect(() => {
      if (primed) { primed = false; return; }
      refreshQuietly();
    })];
    for (const topic of options.topics ?? []) {
      disposers.push(onChanged(topic, () => {
        rpcCache.invalidate(method, stableParams);
        rpcCache.scheduleRefresh(method, stableParams, debounceMs, fetcher);
      }));
    }
    return () => disposers.forEach((dispose) => dispose());
  }, [enabled, method, paramsKey, topicsKey, debounceMs, fetcher, refresh]);

  return { ...snapshot, loading: enabled && snapshot.data === undefined && snapshot.error === null, refresh, invalidate };
}

/** params 省略时使该方法的所有参数变体过期；传入 params 时只使精确 key 过期。 */
export function invalidateRpcData(method?: string, ...params: [unknown?]): void {
  if (params.length === 0) rpcCache.invalidate(method);
  else rpcCache.invalidate(method, params[0]);
}

export function onEvent(listener: (e: RunEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/** 后台通知某类数据变了（例如定时同步完成）。 */
export function onChanged(topic: string, listener: () => void): () => void {
  const wrapped = (changedTopic: string) => {
    if (changedTopic === topic) listener();
  };
  changedListeners.add(wrapped);
  return () => changedListeners.delete(wrapped);
}

/** pi 对话的流式输出。 */
export function onChat(listener: (siteId: number, e: ChatEvent) => void): () => void {
  chatListeners.add(listener);
  return () => chatListeners.delete(listener);
}

/** 当前用户全局助手的流式输出与确认请求。 */
export function onAssistant(listener: (event: AssistantEvent) => void): () => void {
  assistantListeners.add(listener);
  return () => assistantListeners.delete(listener);
}

/** 邮件监听的新信/状态推送。正文永远不进入 SSE。 */
export function onMail(listener: (event: MailPushEvent) => void): () => void {
  mailListeners.add(listener);
  return () => mailListeners.delete(listener);
}

/** 每次（重新）连上后台都会触发；已连上时立即触发一次。 */
export function onConnect(listener: () => void): () => void {
  connectListeners.add(listener);
  if (connected) listener();
  return () => connectListeners.delete(listener);
}

/** 登录身份已绑定到 RPC 传输时触发；不等待 SSE 握手，避免首屏多一个网络往返。 */
export function onBackendReady(listener: () => void): () => void {
  readyListeners.add(listener);
  if (expectedUserId != null) listener();
  return () => readyListeners.delete(listener);
}

export function onConnectionStatus(listener: (value: boolean) => void): () => void {
  statusListeners.add(listener);
  listener(connected);
  return () => statusListeners.delete(listener);
}
