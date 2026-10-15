// Hostinger 官方 MCP：每个账号一个 stdio 子进程（Token 只放在子进程环境变量里），按账号限流，空闲关闭。
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLimiter } from "./rate-limit.ts";

export type HostingerExec = (operation: string, params?: Record<string, unknown>) => Promise<unknown>;

export class HostingerError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "HostingerError";
    this.status = status;
  }
}

/** MCP 的错误文本形如 `HTTP 401: {...}`；状态码决定能不能重试。 */
export function parseError(text: string): HostingerError {
  const m = /^HTTP (\d{3}):/.exec(text.trim());
  return new HostingerError(text.slice(0, 500), m ? Number(m[1]) : null);
}

/**
 * 拉全列表。第一次不带分页参数（有的接口不接受）；响应是数组就直接返回，
 * 是 {data, meta} 且没取满 total 时，按 meta.per_page 继续翻页。
 */
export async function listAll(exec: HostingerExec, operation: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
  const first = await exec(operation, params);
  if (Array.isArray(first)) return first;
  const { data, meta } = first as { data: unknown[]; meta?: { total?: number; per_page?: number } };
  const all = [...data];
  const total = meta?.total ?? all.length;
  for (let page = 2; all.length < total; page++) {
    const next = (await exec(operation, { ...params, page, per_page: meta?.per_page })) as { data: unknown[] };
    if (next.data.length === 0) break; // 防止 total 不准时死循环
    all.push(...next.data);
  }
  return all;
}

const SERVER = createRequire(import.meta.url).resolve("@hostinger/mcp/src/servers/all.js");

export function createHostingerPool(idleMs = 5 * 60_000) {
  type Entry = { client: Promise<Client>; limiter: ReturnType<typeof createLimiter>; timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<number, Entry>();

  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "website-gen", version: "0.1.0" });
    await client.connect(new StdioClientTransport({
      // 在 Electron 里 execPath 是 Electron 本身，ELECTRON_RUN_AS_NODE 让它以 Node 模式运行 MCP 服务
      command: process.execPath,
      args: [SERVER],
      env: { HOSTINGER_API_TOKEN: token, ELECTRON_RUN_AS_NODE: "1", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      stderr: "ignore",
    }));
    return client;
  }

  async function close(accountId: number) {
    const e = entries.get(accountId);
    if (!e) return;
    entries.delete(accountId);
    clearTimeout(e.timer);
    await (await e.client.catch(() => null))?.close();
  }

  function forAccount(accountId: number, token: string): HostingerExec {
    return async (operation, params = {}) => {
      let e = entries.get(accountId);
      if (!e) {
        const client = connect(token);
        client.catch(() => entries.delete(accountId)); // 连接失败不缓存，下次重连
        e = { client, limiter: createLimiter(60, 60_000) };
        entries.set(accountId, e);
      }
      clearTimeout(e.timer);
      e.timer = setTimeout(() => void close(accountId), idleMs);
      await e.limiter.take();
      const res = await (await e.client).callTool({ name: "execute", arguments: { operation, params } }, undefined, { timeout: 10 * 60_000 });
      const text = (res.content as { text?: string }[]).map((c) => c.text ?? "").join("");
      if (res.isError) throw parseError(text);
      return JSON.parse(text);
    };
  }

  return { forAccount, close, closeAll: () => Promise.all([...entries.keys()].map(close)) };
}
