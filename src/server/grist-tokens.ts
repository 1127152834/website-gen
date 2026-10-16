import { randomBytes } from "node:crypto";
import type { AdminStore, AdminUser } from "./admin-db.ts";
import { tokenHash } from "./auth.ts";

/** One independently revocable MCP credential per user. Never persist the raw token. */
export class GristTokenStore {
  private readonly admin: AdminStore;
  constructor(admin: AdminStore) { this.admin = admin; }

  status(userId: number): { createdAt: number | null; lastUsedAt: number | null } {
    const row = this.admin.db.prepare("SELECT created_at, last_used_at FROM grist_mcp_tokens WHERE user_id = ?").get(userId) as { created_at: number; last_used_at: number | null } | undefined;
    return { createdAt: row?.created_at ?? null, lastUsedAt: row?.last_used_at ?? null };
  }

  generate(userId: number, now: number): { token: string; createdAt: number } {
    const user = this.admin.getUser(userId);
    if (!user || user.disabled) throw new Error("用户不存在或已停用");
    if (user.mustChangePassword) throw new Error("请先修改初始密码");
    const token = randomBytes(32).toString("base64url");
    this.admin.db.prepare(`INSERT INTO grist_mcp_tokens (user_id, token_hash, created_at, last_used_at)
      VALUES (?, ?, ?, NULL) ON CONFLICT(user_id) DO UPDATE SET
      token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL`)
      .run(userId, tokenHash(token), now);
    return { token, createdAt: now };
  }

  revoke(userId: number): void { this.admin.db.prepare("DELETE FROM grist_mcp_tokens WHERE user_id = ?").run(userId); }

  authenticate(token: string, now: number, touch = true): AdminUser | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const hash = tokenHash(token);
    const row = this.admin.db.prepare("SELECT user_id FROM grist_mcp_tokens WHERE token_hash = ?").get(hash) as { user_id: number } | undefined;
    const user = row && this.admin.getUser(row.user_id);
    if (!user || user.disabled || user.mustChangePassword) return undefined;
    if (touch) this.admin.db.prepare("UPDATE grist_mcp_tokens SET last_used_at = ? WHERE token_hash = ?").run(now, hash);
    return user;
  }
}
