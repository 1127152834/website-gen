// Per-user Grist REST client. Never follows redirects with a user's API key.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { assertPublicBaseUrl } from "./net-guard.ts";

export type GristFields = Record<string, unknown>;
export type GristUser = { id: number; name: string; email?: string; picture?: string | null } & GristFields;
export type GristOrg = { id: number; name: string; domain: string | null; access?: string } & GristFields;
export type GristDoc = { id: string; name: string; urlId?: string | null; access?: string; workspace?: GristWorkspace } & GristFields;
export type GristWorkspace = { id: number; name: string; docs?: GristDoc[]; orgDomain?: string; org?: GristOrg; access?: string } & GristFields;
export type GristUserProfile = { user: GristUser; org?: GristOrg; orgError?: { error: string; status: number } };
export type GristColumnFields = {
  type?: string;
  label?: string;
  formula?: string;
  isFormula?: boolean;
  widgetOptions?: string;
} & GristFields;
export type GristColumnInput = { id: string; fields?: GristColumnFields };
export type GristColumn = { id: string; fields: GristColumnFields };
export type GristTable = { id: string; fields: GristFields; columns?: GristColumn[] };
export type GristRecordInput = { fields: GristFields };
export type GristRecord = GristRecordInput & { id: number };
export type GristTables = { tables: GristTable[] };
export type GristColumns = { columns: GristColumn[] };
export type GristRecords = { records: GristRecord[] };
export type GristRecordIds = { records: { id: number }[] };
export type GristSqlResult = { statement: string; records: GristRecordInput[] };
export type GristSnapshots = { snapshots: { snapshotId: string; lastModified: string; docId: string }[] };
export type GristListOptions = { filter?: Record<string, unknown[]>; sort?: string | string[]; limit?: number };

export class GristError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "GristError";
    this.status = status;
  }
}

/** Synchronous URL validation is also used when saving workspace settings. */
export function normalizeGristBaseUrl(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl.trim()); }
  catch { throw new GristError("Grist 地址无效，请填写完整的 HTTP 或 HTTPS 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new GristError("Grist 地址只允许 HTTP 或 HTTPS，且不能包含用户名、密码、查询参数或片段");
  }
  return url.toString().replace(/\/+$/, "");
}

// URL canonicalizes IPv4-mapped IPv6 literals to hex; net-guard only recognizes dotted form.
function normalizeMappedAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(host);
  if (!mapped) return address;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

/** Strict public-host policy: the model-provider private-host override does not apply to Grist.
 * Rechecked on every request. As with net-guard, this is a DNS preflight, not IP pinning.
 */
export async function assertGristBaseUrl(baseUrl: string): Promise<void> {
  const normalized = normalizeGristBaseUrl(baseUrl);
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new GristError("Grist 地址指向本机或内网，不允许访问");
  const mapped = normalizeMappedAddress(host);
  try {
    await assertPublicBaseUrl(mapped !== host ? `http://${mapped}` : normalized, {}, async (hostname) => {
      const addresses = await lookup(hostname, { all: true });
      if (addresses.length === 0) throw new Error("没有可用的 DNS 地址");
      return addresses.map(({ address, family }) => {
        const normalizedAddress = normalizeMappedAddress(address);
        return { address: normalizedAddress, family: normalizedAddress === address ? family : 4 };
      });
    });
  } catch (error) {
    if (error instanceof Error && /本机|内网/.test(error.message)) throw new GristError("Grist 地址指向本机或内网，不允许访问");
    throw new GristError(`Grist 地址检查失败：无法解析 ${host}，请检查地址和 DNS`);
  }
}

function segment(value: string | number): string {
  const text = String(value);
  if (!text.trim() || text === "." || text === ".." || /[\u0000-\u001f\u007f]/.test(text)) throw new GristError("Grist 标识符无效");
  return encodeURIComponent(text);
}

/** Deliberately accepts SELECT only, not WITH/PRAGMA or multiple statements.
 * The REST SQL endpoint additionally enforces SQLite read-only execution on Grist's side.
 */
export function assertGristSelectSql(sql: string): void {
  let tokens = "";
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const end = char === "[" ? "]" : char;
      let closed = false;
      while (++i < sql.length) {
        if (sql[i] !== end) continue;
        if (sql[i + 1] === end && end !== "]") { i++; continue; }
        closed = true;
        break;
      }
      if (!closed) throw new GristError("Grist SQL 引号未闭合，仅支持单条 SELECT 查询");
      tokens += " ? ";
    } else if (char === "-" && sql[i + 1] === "-") {
      while (i + 1 < sql.length && sql[i + 1] !== "\n") i++;
      tokens += " ";
    } else if (char === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new GristError("Grist SQL 注释未闭合，仅支持单条 SELECT 查询");
      i = end + 1;
      tokens += " ";
    } else {
      if (char === ";") throw new GristError("Grist SQL 仅支持不带分号的单条 SELECT 查询");
      tokens += char;
    }
  }
  if (!/^\s*SELECT\b/i.test(tokens)) throw new GristError("Grist SQL 仅支持单条 SELECT 只读查询");
}

type GristClientOptions = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

const RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const ERROR_MAX_BYTES = 64 * 1024;

/** Bound decompressed stream bytes as well as advertised length, before JSON parsing.
 * Upstream row limits are not trusted: a single cell or an error response may be enormous.
 */
async function readBoundedResponse(response: Response, controller: AbortController): Promise<string> {
  const maximum = response.ok ? RESPONSE_MAX_BYTES : ERROR_MAX_BYTES;
  const reader = response.body?.getReader();
  let cancelled = false;
  const cancel = (reason: unknown) => {
    if (cancelled) return;
    cancelled = true;
    void reader?.cancel(reason).catch(() => {});
  };
  const onAbort = () => cancel(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const tooLarge = (): never => {
    const error = new GristError(`Grist 响应正文超过大小上限（HTTP ${response.status}）：最多 ${maximum / 1024} KiB，请减少查询的数据量`, response.status);
    cancel(error);
    controller.abort(error);
    throw error;
  };
  try {
    if (controller.signal.aborted) { cancel(controller.signal.reason); throw controller.signal.reason; }
    const declared = response.headers.get("Content-Length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) tooLarge();
    if (!reader) return "";
    // A growing bounded buffer avoids unbounded per-chunk object overhead from tiny chunks.
    let bytes = Buffer.alloc(0);
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      if (value.byteLength === 0) continue;
      const previous = total;
      total += value.byteLength;
      if (total > maximum) tooLarge();
      if (bytes.length < total) {
        const next = Buffer.allocUnsafe(Math.min(maximum, Math.max(total, bytes.length * 2, 8192)));
        bytes.copy(next, 0, 0, previous);
        bytes = next;
      }
      bytes.set(value, previous);
    }
    return bytes.toString("utf8", 0, total);
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
}

export function gristClient(options: GristClientOptions) {
  const baseUrl = normalizeGristBaseUrl(options.baseUrl);
  const fetch = options.fetch ?? globalThis.fetch;
  const apiKey = options.apiKey.trim();
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new GristError("Grist API Key 不能为空或包含换行符");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new GristError("Grist 请求超时设置无效");
  const redact = (message: string) => message.replaceAll(apiKey, "[已隐藏]").slice(0, 800);

  async function request<T>(path: string, method = "GET", body?: unknown, query?: URLSearchParams): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new GristError(`Grist 请求超时（${timeoutMs / 1000} 秒）`);
    const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(controller.signal.reason instanceof GristError ? controller.signal.reason : timeoutError);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([aborted, (async () => {
        await assertGristBaseUrl(baseUrl);
        if (controller.signal.aborted) throw controller.signal.reason;
        const suffix = query?.size ? `?${query}` : "";
        const response = await fetch(`${baseUrl}/api${path}${suffix}`, {
          method,
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
        const raw = await readBoundedResponse(response, controller);
        let parsed: unknown;
        try { parsed = raw ? JSON.parse(raw) : undefined; }
        catch {
          if (response.ok) throw new GristError(`Grist 响应格式无效（HTTP ${response.status}），应为 JSON`, response.status);
        }
        if (!response.ok) {
          const authStatus = response.status === 401 || response.status === 403;
          if (authStatus && parsed === undefined) {
            throw new GristError(`Grist 拒绝了来自本服务器的请求（HTTP ${response.status}，返回的是网页或其他非 JSON 内容，而不是 API 数据），通常是 Grist 前面的防火墙（如 Cloudflare）拦截了本服务器的网络出口，不是 API Key 的问题。请检查服务器网络或代理设置（见部署文档 docs/deploy.md）。`, response.status);
          }
          const errorField = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
          const detail = errorField === undefined ? response.statusText || "服务端未提供错误详情" : typeof errorField === "string" ? errorField : JSON.stringify(errorField);
          const auth = authStatus && errorField !== undefined ? "API Key 无效或没有权限；" : "";
          throw new GristError(`Grist 请求失败（HTTP ${response.status}）：${auth}${redact(detail)}`, response.status);
        }
        return parsed as T;
      })()]);
    } catch (error) {
      if (error instanceof GristError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason instanceof GristError ? controller.signal.reason : timeoutError;
      throw new GristError(`Grist 请求失败：${redact(error instanceof Error ? error.message : String(error))}`);
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    }
  }

  const docPath = (docId: string) => `/docs/${segment(docId)}`;
  const tablePath = (docId: string, tableId: string) => `${docPath(docId)}/tables/${segment(tableId)}`;

  return {
    async getUserProfile() { return request<GristUserProfile>("/session/access/active"); },
    async listOrgs() { return request<GristOrg[]>("/orgs"); },
    async listWorkspaces(orgId: string | number) { return request<GristWorkspace[]>(`/orgs/${segment(orgId)}/workspaces`); },
    async listDocs(workspaceId: string | number) {
      const workspace = await request<GristWorkspace>(`/workspaces/${segment(workspaceId)}`);
      return workspace.docs ?? [];
    },
    async getDocInfo(docId: string) { return request<GristDoc>(docPath(docId)); },
    async getTables(docId: string) { return request<GristTables>(`${docPath(docId)}/tables`); },
    async getTableColumns(docId: string, tableId: string) { return request<GristColumns>(`${tablePath(docId, tableId)}/columns`); },
    async listRecords(docId: string, tableId: string, options: GristListOptions = {}) {
      const query = new URLSearchParams();
      if (options.filter !== undefined) query.set("filter", JSON.stringify(options.filter));
      if (options.sort !== undefined) query.set("sort", Array.isArray(options.sort) ? options.sort.join(",") : options.sort);
      if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new GristError("Grist limit 必须是正整数");
        query.set("limit", String(options.limit));
      }
      return request<GristRecords>(`${tablePath(docId, tableId)}/records`, "GET", undefined, query);
    },
    async addRecords(docId: string, tableId: string, records: GristRecordInput[]) {
      return request<GristRecordIds>(`${tablePath(docId, tableId)}/records`, "POST", { records });
    },
    async updateRecords(docId: string, tableId: string, records: GristRecord[]) {
      return request<void>(`${tablePath(docId, tableId)}/records`, "PATCH", { records });
    },
    async removeRecords(docId: string, tableId: string, recordIds: number[]) {
      return request<void>(`${tablePath(docId, tableId)}/records/delete`, "POST", recordIds);
    },
    async queryDocument(docId: string, sql: string, args?: (string | number)[]) {
      assertGristSelectSql(sql);
      return request<GristSqlResult>(`${docPath(docId)}/sql`, "POST", { sql, ...(args === undefined ? {} : { args }) });
    },
    async listSnapshots(docId: string) { return request<GristSnapshots>(`${docPath(docId)}/snapshots`); },
    async listAttachments(docId: string, options: { limit?: number } = {}) {
      const query = new URLSearchParams();
      if (options.limit !== undefined) {
        if (!Number.isSafeInteger(options.limit) || options.limit < 1) throw new GristError("Grist limit 必须是正整数");
        query.set("limit", String(options.limit));
      }
      return request<GristRecords>(`${docPath(docId)}/attachments`, "GET", undefined, query);
    },
    async createDoc(workspaceId: string | number, name: string) { return request<string>(`/workspaces/${segment(workspaceId)}/docs`, "POST", { name }); },
    async createTable(docId: string, tableId: string, columns: GristColumnInput[] = []) {
      return request<{ tables: { id: string }[] }>(`${docPath(docId)}/tables`, "POST", { tables: [{ id: tableId, columns }] });
    },
    async addTableColumn(docId: string, tableId: string, column: GristColumnInput) {
      return request<{ columns: { id: string }[] }>(`${tablePath(docId, tableId)}/columns`, "POST", { columns: [column] });
    },
    async updateTableColumn(docId: string, tableId: string, columnId: string, fields: GristColumnFields) {
      return request<void>(`${tablePath(docId, tableId)}/columns`, "PATCH", { columns: [{ id: columnId, fields }] });
    },
    async renameTable(docId: string, tableId: string, newTableId: string) {
      return request<{ actionNum?: number; retValues?: unknown[] }>(`${docPath(docId)}/apply`, "POST", [["RenameTable", tableId, newTableId]]);
    },
    async removeTable(docId: string, tableId: string) {
      return request<{ actionNum?: number; retValues?: unknown[] }>(`${docPath(docId)}/apply`, "POST", [["RemoveTable", tableId]]);
    },
    async removeTableColumn(docId: string, tableId: string, columnId: string) {
      return request<void>(`${tablePath(docId, tableId)}/columns/${segment(columnId)}`, "DELETE");
    },
  };
}

export type GristClient = ReturnType<typeof gristClient>;
