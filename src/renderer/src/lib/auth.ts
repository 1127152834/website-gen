import type { AdminUser, AuthUser } from "../../../shared/auth.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

type ErrorBody = { error?: string; code?: string };
export const AUTH_SYNC_KEY = "website-gen:auth-sync";
let requestGeneration = 0;

/** 身份即将复核或切换时，让旧页面尚未完成的请求失效。 */
export function invalidateApiRequests(): void {
  requestGeneration++;
}

function announceAuthChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTH_SYNC_KEY, `${Date.now()}:${crypto.randomUUID()}`);
  } catch {
    // 禁用本地存储时仍可靠窗口聚焦复核登录身份。
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const generation = requestGeneration;
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if ((init.method ?? "GET").toUpperCase() !== "GET") headers.set("X-Requested-With", "website-gen");

  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await readBody(response);
  if (generation !== requestGeneration) throw new Error("登录状态已变化，请重试");
  if (!response.ok) {
    const error = body && typeof body === "object" ? body as ErrorBody : null;
    const message = error?.error ?? (typeof body === "string" ? body : `请求失败（${response.status}）`);
    if (typeof window !== "undefined" && response.status === 401 && path !== "/api/login" && path !== "/api/me") {
      window.dispatchEvent(new CustomEvent("website-gen:auth", { detail: "unauthenticated" }));
    } else if (typeof window !== "undefined" && response.status === 403 && error?.code === "password_required" && path !== "/api/password") {
      window.dispatchEvent(new CustomEvent("website-gen:auth", { detail: "password_required" }));
    }
    throw new HttpError(message, response.status, error?.code ?? null);
  }
  return body as T;
}

function userFrom<T extends { user: AuthUser } | AuthUser>(body: T): AuthUser {
  return "user" in body ? body.user : body;
}

export async function getCurrentUser(): Promise<AuthUser> {
  return userFrom(await apiRequest<{ user: AuthUser } | AuthUser>("/api/me"));
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const user = userFrom(await apiRequest<{ user: AuthUser } | AuthUser>("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  }));
  announceAuthChange();
  return user;
}

export async function logout(): Promise<void> {
  await apiRequest("/api/logout", { method: "POST" });
  announceAuthChange();
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<AuthUser> {
  const body = await apiRequest<{ user?: AuthUser }>("/api/password", {
    method: "POST",
    body: JSON.stringify({ old: oldPassword, new: newPassword }),
  });
  const user = body.user ?? await getCurrentUser();
  announceAuthChange();
  return user;
}

export async function listUsers(): Promise<AdminUser[]> {
  const body = await apiRequest<{ users: AdminUser[] } | AdminUser[]>("/api/admin/users");
  return Array.isArray(body) ? body : body.users;
}

export async function addUser(username: string, password: string, role: AdminUser["role"]): Promise<void> {
  await apiRequest("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });
}

export async function resetUserPassword(id: number, password: string): Promise<void> {
  await apiRequest(`/api/admin/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function setUserDisabled(id: number, disabled: boolean): Promise<void> {
  await apiRequest(`/api/admin/users/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ disabled }),
  });
}
