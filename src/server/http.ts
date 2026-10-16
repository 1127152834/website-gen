import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Handlers } from "../backend/rpc.ts";
import { handleRequest } from "../backend/rpc.ts";
import type { Push, Request } from "../shared/protocol.ts";
import { newSessionToken } from "./auth.ts";
import { openAdminStore, type AdminStore, type AdminUser, type UserRole } from "./admin-db.ts";
import { acquireServerLock } from "./lock.ts";
import type { GristClient } from "../backend/grist.ts";
import { handleGristMcp } from "./grist-mcp.ts";
import { GristTokenStore } from "./grist-tokens.ts";

export interface WorkspaceLike {
  handlers: Handlers;
  gristClient?(): GristClient;
  /** 只在通过会话鉴权的显式附件下载中调用，绝不解析消息中的 URL。 */
  mailAttachment?(input: { mailboxId: number; folder: string; uid: number; partId: string }): Promise<{ name: string; type: string; size: number; data: Buffer }>;
  subscribe(listener: (push: Push) => void): () => void;
  close(): Promise<void>;
}
export interface WorkspaceManagerLike {
  open(userId: number): WorkspaceLike;
  get(userId: number): WorkspaceLike | undefined;
  close(userId: number): Promise<void>;
  closeAll(): Promise<void>;
}
export interface CreateAppOptions {
  dataDir: string;
  distDir?: string;
  workspaceManager: WorkspaceManagerLike;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "log" | "warn" | "error">;
  /** startServer 在生成主密钥前先拿锁；测试和嵌入调用可省略，由 createApp 自己拿锁。 */
  releaseLock?: () => void;
}
interface Session { user: AdminUser; tokenHash: string; rawToken: string }
interface ReplayItem { seq: number; message: Push }
interface StreamListener { send(item: ReplayItem): void; close(): void }
interface UserHub { nextSeq: number; replay: ReplayItem[]; listeners: Set<StreamListener>; unsubscribe: () => void }

const COOKIE = "website_gen_session";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}
const apiError = (res: ServerResponse, status: number, error: string, code?: string) => json(res, status, code ? { error, code } : { error });

async function bodyJson(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new Error("请求内容过大");
    chunks.push(buffer);
  }
  if (!length) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function cookieHeader(token: string, req: IncomingMessage, env: NodeJS.ProcessEnv): string {
  const forwardedHttps = env.TRUST_PROXY === "1" && req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() === "https";
  const directHttps = Boolean((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted);
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 60 * 60}${forwardedHttps || directHttps ? "; Secure" : ""}`;
}
const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
const publicUser = (user: AdminUser) => ({ id: user.id, username: user.username, role: user.role, mustChangePassword: user.mustChangePassword });

export async function createApp(options: CreateAppOptions): Promise<{ server: Server; admin: AdminStore; close(): Promise<void> }> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? console;
  const releaseLock = options.releaseLock ?? acquireServerLock(options.dataDir);
  let admin: AdminStore;
  try {
    admin = openAdminStore(join(options.dataDir, "admin.sqlite"));
  } catch (error) {
    releaseLock(); throw error;
  }
  try {
    await admin.bootstrap({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, now: clock(), printPassword: (message) => logger.log(message) });
  } catch (error) {
    admin.close(); releaseLock(); throw error;
  }

  const hubs = new Map<number, UserHub>();
  const gristTokens = new GristTokenStore(admin);
  const attachWorkspace = (userId: number): WorkspaceLike => {
    const workspace = options.workspaceManager.get(userId) ?? options.workspaceManager.open(userId);
    if (!hubs.has(userId)) {
      // 用时间作为序列基点，服务重启后不会从 1 开始，让仍打开的浏览器误判为旧消息。
      const hub: UserHub = { nextSeq: Math.max(1, clock() * 1000), replay: [], listeners: new Set(), unsubscribe: () => {} };
      hub.unsubscribe = workspace.subscribe((message) => {
        const item = { seq: hub.nextSeq++, message };
        hub.replay.push(item);
        if (hub.replay.length > 1000) hub.replay.shift();
        for (const listener of hub.listeners) listener.send(item);
      });
      hubs.set(userId, hub);
    }
    return workspace;
  };
  const detachWorkspace = (userId: number): void => {
    const hub = hubs.get(userId);
    if (hub) {
      hub.unsubscribe();
      for (const listener of hub.listeners) listener.close();
    }
    hubs.delete(userId);
  };
  try {
    for (const user of admin.enabledUsers()) attachWorkspace(user.id);
  } catch (error) {
    await options.workspaceManager.closeAll().catch(() => {});
    admin.close(); releaseLock(); throw error;
  }

  const authenticate = (req: IncomingMessage): Session | undefined => {
    const rawToken = cookieValue(req, COOKIE);
    if (!rawToken) return undefined;
    const found = admin.session(rawToken, clock());
    return found && { ...found, rawToken };
  };
  const requireSession = (req: IncomingMessage, res: ServerResponse): Session | undefined => {
    const session = authenticate(req);
    if (!session) apiError(res, 401, "请先登录", "unauthorized");
    else res.setHeader("Set-Cookie", cookieHeader(session.rawToken, req, env));
    return session;
  };
  const requireReady = (req: IncomingMessage, res: ServerResponse): Session | undefined => {
    const session = requireSession(req, res);
    if (session?.user.mustChangePassword) {
      apiError(res, 403, "首次登录必须先修改密码", "password_required");
      return undefined;
    }
    return session;
  };
  const requireAdmin = (req: IncomingMessage, res: ServerResponse): Session | undefined => {
    const session = requireReady(req, res);
    if (session && session.user.role !== "admin") {
      apiError(res, 403, "仅管理员可执行此操作", "admin_required");
      return undefined;
    }
    return session;
  };
  // 同一用户的停用 / 启用必须依次完成，不能让新工作区接到尚未关闭的旧实例。
  const statusChanges = new Map<number, Promise<unknown>>();
  async function serialStatus<T>(userId: number, action: () => Promise<T>): Promise<T> {
    const previous = statusChanges.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    statusChanges.set(userId, current);
    try { return await current; }
    finally { if (statusChanges.get(userId) === current) statusChanges.delete(userId); }
  }
  let activeLogins = 0;

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // MCP is a separate, Bearer-only boundary. Cookies and the RPC CSRF marker grant no access.
      if (url.pathname === "/api/mcp") {
        res.setHeader("Cache-Control", "no-store");
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "")?.[1];
        const user = token && gristTokens.authenticate(token, clock());
        if (!user) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="grist-mcp"');
          apiError(res, 401, "MCP 令牌无效或已撤销", "unauthorized"); return;
        }
        await handleGristMcp(req, res, () => {
          // Revocation/disable during a batch or before a tool invocation must also take effect.
          if (!gristTokens.authenticate(token, clock(), false)) throw new Error("MCP 令牌无效或已撤销");
          const workspace = options.workspaceManager.get(user.id) ?? attachWorkspace(user.id);
          if (!workspace.gristClient) throw new Error("请先在设置页配置 Grist");
          return workspace.gristClient();
        });
        return;
      }
      if (url.pathname.startsWith("/api/") && req.method === "POST" && req.headers["x-requested-with"] !== "website-gen") {
        // 登录没有会话可检查；其余受保护接口先返回 401，避免把 CSRF 检查伪装成登录状态探针。
        if (url.pathname !== "/api/login" && !authenticate(req)) apiError(res, 401, "请先登录", "unauthorized");
        else apiError(res, 403, "请求缺少安全标记", "csrf_required");
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await bodyJson(req);
        const username = String(body.username ?? "").trim(), password = String(body.password ?? "");
        if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(username) || password.length > 1024) {
          apiError(res, 400, "用户名格式或密码长度不正确", "invalid_login"); return;
        }
        // 只信任显式部署在反向代理后的请求；取最靠近该代理的客户端，忽略前置伪造段。
        const forwarded = req.headers["x-forwarded-for"]?.toString().split(",").at(-1)?.trim();
        const ip = env.TRUST_PROXY === "1" && forwarded && isIP(forwarded) ? forwarded : req.socket.remoteAddress ?? "unknown";
        const now = clock();
        if (activeLogins >= 8) { apiError(res, 429, "登录请求过多，请稍后再试", "rate_limited"); return; }
        if (!admin.beginLogin(ip, username, now)) { apiError(res, 429, "登录失败次数过多，请稍后再试", "rate_limited"); return; }
        const token = newSessionToken();
        activeLogins++;
        let user;
        try { user = await admin.login(username, password, token, now); }
        finally { activeLogins--; }
        if (user) admin.recordLogin(ip, username, true, now);
        if (!user) { apiError(res, 401, "用户名或密码不正确", "invalid_credentials"); return; }
        res.setHeader("Set-Cookie", cookieHeader(token, req, env));
        json(res, 200, { user: publicUser(user) }); return;
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const session = requireSession(req, res); if (!session) return;
        json(res, 200, { user: publicUser(session.user) }); return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        const session = requireSession(req, res); if (!session) return;
        admin.deleteSession(session.rawToken);
        res.setHeader("Set-Cookie", clearCookie); json(res, 200, { ok: true }); return;
      }

      if (req.method === "POST" && url.pathname === "/api/password") {
        let session = requireSession(req, res); if (!session) return;
        const body = await bodyJson(req);
        session = requireSession(req, res); if (!session) return;
        await admin.changePassword(session.user.id, String(body.old ?? ""), String(body.new ?? ""), session.tokenHash);
        json(res, 200, { user: publicUser(admin.getUser(session.user.id)!) }); return;
      }

      if (req.method === "POST" && url.pathname === "/api/rpc") {
        let session = requireReady(req, res); if (!session) return;
        // 20 MB 附件经 base64 编码会增加三分之一；其他 RPC 仍限制为 1 MB。
        const body = await bodyJson(req, 29 * 1024 * 1024);
        if (body.method !== "mail.send" && Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new Error("请求内容过大");
        session = requireReady(req, res); if (!session) return;
        const request: Request = { kind: "req", id: Number(body.id ?? 0), method: String(body.method ?? ""), params: body.params };
        const workspace = options.workspaceManager.get(session.user.id) ?? attachWorkspace(session.user.id);
        const tokenHandlers: Handlers = {
          "grist.mcpToken.status": () => gristTokens.status(session!.user.id),
          "grist.mcpToken.generate": () => gristTokens.generate(session!.user.id, clock()),
          "grist.mcpToken.revoke": () => { gristTokens.revoke(session!.user.id); return { ok: true }; },
        };
        json(res, 200, await handleRequest({ ...workspace.handlers, ...tokenHandlers }, request)); return;
      }

      if (req.method === "GET" && url.pathname === "/api/mail/attachments") {
        const session = requireReady(req, res); if (!session) return;
        const mailboxId = Number(url.searchParams.get("mailboxId"));
        const uid = Number(url.searchParams.get("uid"));
        const folder = url.searchParams.get("folder") ?? "";
        const partId = url.searchParams.get("partId") ?? "";
        if (!Number.isSafeInteger(mailboxId) || mailboxId <= 0 || !Number.isSafeInteger(uid) || uid <= 0 || !folder || folder.length > 1024 || !partId || partId.length > 128) throw new Error("附件参数无效");
        const workspace = options.workspaceManager.get(session.user.id) ?? attachWorkspace(session.user.id);
        if (!workspace.mailAttachment) { apiError(res, 404, "附件不存在"); return; }
        const attachment = await workspace.mailAttachment({ mailboxId, folder, uid, partId });
        // 下载期间会话可能被撤销；不能把已停用用户的数据继续发出去。
        if (!requireReady(req, res)) return;
        const safeName = attachment.name.replace(/[\r\n\u0000-\u001f\u007f/\\]/g, "_").slice(0, 200) || "attachment";
        const encoded = encodeURIComponent(safeName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16)}`);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "no-store",
          "Content-Length": attachment.data.length,
        }).end(attachment.data);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        const session = requireReady(req, res); if (!session) return;
        const workspace = options.workspaceManager.get(session.user.id) ?? attachWorkspace(session.user.id);
        void workspace;
        const hub = hubs.get(session.user.id)!;
        const querySeq = Number(url.searchParams.get("afterSeq") ?? req.headers["last-event-id"] ?? 0);
        const afterSeq = Number.isSafeInteger(querySeq) && querySeq >= 0 ? querySeq : 0;
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        // SSE 自己的心跳不是用户活动，不能让一个被遗忘的页面把会话永久续期。
        const sessionStillValid = () => Boolean(admin.session(session.rawToken, clock(), false));
        const listener: StreamListener = {
          send: (item) => {
            if (!sessionStillValid()) { if (!res.destroyed) res.end(); return; }
            if (!res.destroyed) res.write(`id: ${item.seq}\ndata: ${JSON.stringify(item)}\n\n`);
          },
          close: () => { if (!res.destroyed) res.end(); },
        };
        let replayAfter = afterSeq;
        const oldestSeq = hub.replay[0]?.seq ?? hub.nextSeq;
        if (afterSeq >= hub.nextSeq || (afterSeq > 0 && afterSeq < oldestSeq - 1)) {
          replayAfter = hub.nextSeq - 1;
          res.write(`data: ${JSON.stringify({ seq: replayAfter, reset: true })}\n\n`);
        }
        for (const item of hub.replay) if (item.seq > replayAfter) listener.send(item);
        hub.listeners.add(listener);
        const heartbeat = setInterval(() => {
          if (!sessionStillValid()) listener.close();
          else res.write(": keep-alive\n\n");
        }, 25_000);
        req.on("close", () => { clearInterval(heartbeat); hub.listeners.delete(listener); });
        return;
      }

      if (url.pathname === "/api/admin/users" && req.method === "GET") {
        if (!requireAdmin(req, res)) return;
        json(res, 200, { users: admin.listUsers() }); return;
      }
      if (url.pathname === "/api/admin/users" && req.method === "POST") {
        if (!requireAdmin(req, res)) return;
        const body = await bodyJson(req);
        if (!requireAdmin(req, res)) return;
        const user = await admin.addUser({ username: String(body.username ?? ""), password: String(body.password ?? ""), role: body.role === "admin" ? "admin" : "user" as UserRole, now: clock() });
        attachWorkspace(user.id);
        json(res, 201, { user }); return;
      }
      const reset = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
      if (reset && req.method === "POST") {
        if (!requireAdmin(req, res)) return;
        const id = Number(reset[1]), body = await bodyJson(req);
        if (!requireAdmin(req, res)) return;
        await admin.resetPassword(id, String(body.password ?? ""));
        json(res, 200, { user: admin.getUser(id) }); return;
      }
      const status = url.pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
      if (status && req.method === "POST") {
        if (!requireAdmin(req, res)) return;
        const id = Number(status[1]), body = await bodyJson(req);
        if (typeof body.disabled !== "boolean") throw new Error("disabled 必须是布尔值");
        const disabled = body.disabled;
        const user = await serialStatus(id, async () => {
          const actor = requireAdmin(req, res); if (!actor) return undefined;
          const previous = admin.getUser(id);
          if (!previous) throw new Error("用户不存在");
          // 先验证管理员保护规则，再改变工作区生命周期。
          const user = admin.setDisabled(id, disabled, actor.user.id);
          if (disabled) { detachWorkspace(id); await options.workspaceManager.close(id); }
          else {
            try { attachWorkspace(id); }
            catch (error) { admin.setDisabled(id, previous.disabled, actor.user.id); throw error; }
          }
          return user;
        });
        if (user) json(res, 200, { user });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        if (requireSession(req, res)) apiError(res, 404, "接口不存在", "not_found");
        return;
      }
      if (!options.distDir || !existsSync(options.distDir)) { apiError(res, 404, "前端尚未构建"); return; }
      const root = resolve(options.distDir);
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes("\0") || decoded.replaceAll("\\", "/").split("/").includes("..")) { apiError(res, 404, "文件不存在"); return; }
      const candidate = resolve(root, `.${normalize(decoded)}`);
      const inside = candidate === root || candidate.startsWith(`${root}${sep}`);
      if (!inside) { apiError(res, 404, "文件不存在"); return; }
      const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html");
      if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) { apiError(res, 404, "文件不存在"); return; }
      // 路径前缀检查不能挡住符号链接 / Windows junction，实际文件也必须留在构建目录。
      if (!realpathSync(file).startsWith(`${realpathSync(root)}${sep}`)) { apiError(res, 404, "文件不存在"); return; }
      res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
      createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      const message = error instanceof SyntaxError ? "JSON 格式不正确" : error instanceof Error ? error.message : String(error);
      if (!res.headersSent) apiError(res, message.includes("不存在") ? 404 : 400, message);
      else res.end();
    }
  });

  let closed = false;
  return {
    server, admin,
    async close() {
      if (closed) return;
      closed = true;
      for (const userId of [...hubs.keys()]) detachWorkspace(userId);
      await new Promise<void>((resolveClose) => server.listening ? server.close(() => resolveClose()) : resolveClose());
      try {
        await options.workspaceManager.closeAll();
      } finally {
        admin.close();
        releaseLock();
      }
    },
  };
}
