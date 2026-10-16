export type RpcCacheSnapshot<T = unknown> = {
  data: T | undefined;
  error: Error | null;
  refreshing: boolean;
};

type Entry = {
  method: string;
  paramsKey: string;
  version: number;
  invalidated: boolean;
  snapshot: RpcCacheSnapshot;
  inFlight?: Promise<unknown>;
  queued?: Promise<unknown>;
};

const EMPTY_SNAPSHOT: RpcCacheSnapshot = Object.freeze({ data: undefined, error: null, refreshing: false });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function stableRpcParams(params: unknown): string {
  return JSON.stringify(canonical(params)) ?? "undefined";
}

export class RpcCache {
  private userId: number | null = null;
  private generation = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fetcher: (method: string, params?: unknown) => Promise<unknown>;

  constructor(fetcher: (method: string, params?: unknown) => Promise<unknown>) {
    this.fetcher = fetcher;
  }

  setUser(userId: number | null): void {
    if (this.userId === userId) return;
    this.userId = userId;
    this.generation++;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.entries.clear();
    for (const subscribers of this.listeners.values()) for (const listener of subscribers) listener();
  }

  private key(method: string, params?: unknown): string {
    return `${this.userId ?? "none"}\u0000${method}\u0000${stableRpcParams(params)}`;
  }

  snapshot<T>(method: string, params?: unknown): RpcCacheSnapshot<T> {
    return (this.entries.get(this.key(method, params))?.snapshot ?? EMPTY_SNAPSHOT) as RpcCacheSnapshot<T>;
  }

  subscribe(method: string, params: unknown, listener: () => void): () => void {
    const key = `${method}\u0000${stableRpcParams(params)}`;
    let subscribers = this.listeners.get(key);
    if (!subscribers) {
      subscribers = new Set();
      this.listeners.set(key, subscribers);
    }
    subscribers.add(listener);
    return () => {
      subscribers?.delete(listener);
      if (subscribers?.size === 0) this.listeners.delete(key);
    };
  }

  private emit(key: string): void {
    const entry = this.entries.get(key);
    const listenerKey = entry ? `${entry.method}\u0000${entry.paramsKey}` : key.slice(key.indexOf("\u0000") + 1);
    for (const listener of this.listeners.get(listenerKey) ?? []) listener();
  }

  refresh<T>(method: string, params?: unknown, fetcher = this.fetcher): Promise<T> {
    if (this.userId == null) return Promise.reject(new Error("后端尚未连接"));
    const key = this.key(method, params);
    const current = this.entries.get(key);
    if (current?.inFlight) {
      if (!current.invalidated) return current.inFlight as Promise<T>;
      if (current.queued) return current.queued as Promise<T>;
      const staleRequest = current.inFlight;
      const queuedGeneration = this.generation;
      const queued = staleRequest.catch(() => undefined).then(() => {
        if (queuedGeneration !== this.generation || this.entries.get(key) !== current) throw new Error("登录状态已变化，请重试");
        if (current.inFlight === staleRequest) current.inFlight = undefined;
        current.queued = undefined;
        return this.refresh<T>(method, params, fetcher);
      });
      current.queued = queued;
      return queued;
    }

    const entry: Entry = current ?? { method, paramsKey: stableRpcParams(params), version: 0, invalidated: false, snapshot: EMPTY_SNAPSHOT };
    entry.invalidated = false;
    entry.snapshot = { ...entry.snapshot, error: null, refreshing: true };
    this.entries.set(key, entry);
    this.emit(key);
    const generation = this.generation;
    const version = entry.version;
    const request = fetcher(method, params).then((result) => {
      if (generation !== this.generation || version !== entry.version || this.entries.get(key) !== entry) {
        if (this.entries.get(key) === entry && entry.inFlight === request) {
          entry.inFlight = undefined;
          entry.snapshot = { ...entry.snapshot, refreshing: false };
          this.emit(key);
        }
        throw new Error("登录状态已变化，请重试");
      }
      entry.inFlight = undefined;
      entry.snapshot = { data: result, error: null, refreshing: false };
      this.emit(key);
      return result as T;
    }, (reason: unknown) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      if (generation === this.generation && version === entry.version && this.entries.get(key) === entry) {
        entry.inFlight = undefined;
        entry.snapshot = { ...entry.snapshot, error, refreshing: false };
        this.emit(key);
      } else if (this.entries.get(key) === entry && entry.inFlight === request) {
        entry.inFlight = undefined;
        entry.snapshot = { ...entry.snapshot, refreshing: false };
        this.emit(key);
      }
      throw error;
    });
    entry.inFlight = request;
    return request as Promise<T>;
  }

  scheduleRefresh(method: string, params?: unknown, delayMs = 200, fetcher = this.fetcher): void {
    if (this.userId == null) return;
    const key = this.key(method, params);
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      void this.refresh(method, params, fetcher).catch(() => undefined);
    }, delayMs));
  }

  invalidate(method?: string, params?: unknown): void {
    const exactParams = arguments.length >= 2 ? stableRpcParams(params) : null;
    for (const [key, entry] of this.entries) {
      if (method != null && entry.method !== method) continue;
      if (exactParams != null && entry.paramsKey !== exactParams) continue;
      entry.version++;
      entry.invalidated = true;
      entry.snapshot = { ...entry.snapshot, error: null, refreshing: false };
      this.emit(key);
    }
  }
}
