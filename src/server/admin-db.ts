import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdminUser } from "../shared/auth.ts";
import { hashPassword, randomInitialPassword, tokenHash, verifyPassword } from "./auth.ts";

export type UserRole = "admin" | "user";
export type { AdminUser } from "../shared/auth.ts";
interface UserRow {
  id: number; username: string; password_hash: string; role: UserRole;
  must_change_password: number; disabled: number; created_at: number; last_login_at: number | null;
}

const SESSION_TTL = 7 * 24 * 60 * 60_000;
const ATTEMPT_WINDOW = 10 * 60_000;
const LOCK_TIME = 10 * 60_000;
// 未知用户名也跑同样的 scrypt，避免用响应时间枚举账号。
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$orjxYh3A5qbOetmx+mFyV33pLTzpIFaedK5QSH3i4TU=";
const rowUser = (row: UserRow): AdminUser => ({
  id: row.id, username: row.username, role: row.role,
  mustChangePassword: Boolean(row.must_change_password), disabled: Boolean(row.disabled),
  createdAt: row.created_at, lastLoginAt: row.last_login_at,
});

export class AdminStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  async bootstrap(options: { username?: string; password?: string; now: number; printPassword?: (message: string) => void }): Promise<{ user: AdminUser; generatedPassword: string | null } | null> {
    const count = (this.db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    if (count) return null;
    const username = options.username?.trim() || "admin";
    const generatedPassword = options.password ? null : randomInitialPassword();
    const password = options.password || generatedPassword!;
    const user = await this.addUser({ username, password, role: "admin", now: options.now });
    if (generatedPassword) options.printPassword?.(`首次启动管理员：${username}\n临时密码：${generatedPassword}\n登录后必须立即修改密码。`);
    return { user, generatedPassword };
  }

  listUsers(): AdminUser[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY id").all() as unknown as UserRow[]).map(rowUser);
  }

  enabledUsers(): AdminUser[] { return this.listUsers().filter((user) => !user.disabled); }

  getUser(id: number): AdminUser | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row && rowUser(row);
  }

  findUserByUsername(username: string): AdminUser | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.trim()) as UserRow | undefined;
    return row && rowUser(row);
  }

  async addUser(input: { username: string; password: string; role?: UserRole; now: number }): Promise<AdminUser> {
    const username = input.username.trim();
    if (!/^[\p{L}\p{N}_.-]{1,64}$/u.test(username)) throw new Error("用户名只能包含字母、数字、点、下划线和短横线");
    const passwordHash = await hashPassword(input.password);
    let id: number;
    try {
      id = Number(this.db.prepare("INSERT INTO users (username, password_hash, role, must_change_password, disabled, created_at) VALUES (?, ?, ?, 1, 0, ?) RETURNING id").get(username, passwordHash, input.role ?? "user", input.now)!.id);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("用户名已存在");
      throw error;
    }
    return this.getUser(id)!;
  }

  private async verifiedUserRow(username: string, password: string): Promise<UserRow | undefined> {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username.trim()) as UserRow | undefined;
    const passwordOk = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !passwordOk) return undefined;
    const current = this.db.prepare("SELECT * FROM users WHERE id = ?").get(row.id) as UserRow | undefined;
    if (!current || current.disabled || current.password_hash !== row.password_hash) return undefined;
    return current;
  }

  async authenticate(username: string, password: string): Promise<AdminUser | undefined> {
    const row = await this.verifiedUserRow(username, password);
    return row && rowUser(row);
  }

  /** 校验完成后在一个无 await 的事务里复核密码版本并签发会话。 */
  async login(username: string, password: string, rawToken: string, now: number): Promise<AdminUser | undefined> {
    const verified = await this.verifiedUserRow(username, password);
    if (!verified) return undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM users WHERE id = ?").get(verified.id) as UserRow | undefined;
      if (!current || current.disabled || current.password_hash !== verified.password_hash) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(tokenHash(rawToken), current.id, now + SESSION_TTL, now);
      this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, current.id);
      this.db.exec("COMMIT");
      return rowUser({ ...current, last_login_at: now });
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async resetPassword(userId: number, password: string): Promise<void> {
    const result = this.db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(await hashPassword(password), userId);
    if (!result.changes) throw new Error("用户不存在");
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  async changePassword(userId: number, oldPassword: string, password: string, keepTokenHash: string): Promise<void> {
    if (oldPassword === password) throw new Error("新密码不能和当前密码相同");
    const row = this.db.prepare("SELECT password_hash, disabled FROM users WHERE id = ?").get(userId) as { password_hash: string; disabled: number } | undefined;
    if (!row || row.disabled || !(await verifyPassword(oldPassword, row.password_hash))) throw new Error("当前密码不正确");
    const passwordHash = await hashPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.prepare(`
        UPDATE users SET password_hash = ?, must_change_password = 0
        WHERE id = ? AND password_hash = ? AND disabled = 0
          AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ?)
      `).run(passwordHash, userId, row.password_hash, keepTokenHash, userId);
      if (!updated.changes) throw new Error("账号状态或当前会话已变更，请重新登录");
      this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, keepTokenHash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setDisabled(userId: number, disabled: boolean, actorId: number): AdminUser {
    if (disabled && userId === actorId) throw new Error("不能停用自己");
    const user = this.getUser(userId);
    if (!user) throw new Error("用户不存在");
    if (disabled && user.role === "admin") {
      const enabledAdmins = (this.db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
      if (enabledAdmins <= 1) throw new Error("不能停用最后一个管理员");
    }
    this.db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
    if (disabled) this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    return this.getUser(userId)!;
  }

  isLoginLimited(ip: string, username: string, now: number): boolean {
    const rows = this.db.prepare("SELECT attempted_at FROM login_attempts WHERE ip = ? AND username = ? AND succeeded = 0 ORDER BY id DESC LIMIT 5").all(ip, username.toLowerCase()) as { attempted_at: number }[];
    // 触发后锁满十分钟；不能因第一条失败滑出统计窗口而提前解锁。
    return rows.length === 5 && rows[0].attempted_at - rows[4].attempted_at <= ATTEMPT_WINDOW && rows[0].attempted_at + LOCK_TIME > now;
  }

  /** 在异步 scrypt 前同步占一个失败名额，防止并发请求一起绕过限速检查。 */
  beginLogin(ip: string, username: string, now: number): boolean {
    const normalized = username.trim().toLowerCase();
    const ipFailures = (this.db.prepare("SELECT count(*) AS n FROM login_attempts WHERE ip = ? AND succeeded = 0 AND attempted_at > ?").get(ip, now - ATTEMPT_WINDOW) as { n: number }).n;
    if (ipFailures >= 50) return false;
    if (this.isLoginLimited(ip, normalized, now)) return false;
    this.db.prepare("INSERT INTO login_attempts (ip, username, succeeded, attempted_at) VALUES (?, ?, 0, ?)").run(ip, normalized, now);
    this.db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(now - 24 * 60 * 60_000);
    return true;
  }

  recordLogin(ip: string, username: string, succeeded: boolean, now: number): void {
    this.db.prepare("INSERT INTO login_attempts (ip, username, succeeded, attempted_at) VALUES (?, ?, ?, ?)").run(ip, username.toLowerCase(), succeeded ? 1 : 0, now);
    if (succeeded) this.db.prepare("DELETE FROM login_attempts WHERE ip = ? AND username = ?").run(ip, username.toLowerCase());
    this.db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").run(now - 24 * 60 * 60_000);
  }

  createSession(userId: number, rawToken: string, now: number): void {
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(tokenHash(rawToken), userId, now + SESSION_TTL, now);
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  }

  session(rawToken: string, now: number, slide = true): { user: AdminUser; tokenHash: string } | undefined {
    const hash = tokenHash(rawToken);
    const row = this.db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0").get(hash, now) as UserRow | undefined;
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    if (!row) return undefined;
    if (slide) this.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(now + SESSION_TTL, hash);
    return { user: rowUser(row), tokenHash: hash };
  }

  deleteSession(rawToken: string): void { this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(rawToken)); }
  close(): void { this.db.close(); }
}

export function openAdminStore(path: string): AdminStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')), must_change_password INTEGER NOT NULL DEFAULT 1,
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS login_attempts (
      id INTEGER PRIMARY KEY, ip TEXT NOT NULL, username TEXT NOT NULL, succeeded INTEGER NOT NULL, attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_attempts_lookup ON login_attempts(ip, username, attempted_at);
  `);
  return new AdminStore(db);
}
