// 把已停止的桌面版数据迁入一个没有业务数据的 web 用户。
// 默认桌面目录：%APPDATA%\website-gen；默认目标：第一个管理员。
import { randomBytes } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "../src/backend/db.ts";
import { seal, unseal } from "../src/backend/secrets.ts";
import { openAdminStore } from "../src/server/admin-db.ts";
import { deriveUserKey, loadMasterKey } from "../src/server/keys.ts";
import { acquireServerLock } from "../src/server/lock.ts";

const REKEY_COLUMNS = [
  ["hostinger_accounts", "token_ciphertext"],
  ["model_providers", "api_key_ciphertext"],
  ["secrets", "ciphertext"],
  ["sites", "wp_admin_ciphertext"],
  ["sites", "enroll_ciphertext"],
  ["sites", "companion_ciphertext"],
  ["sites", "mailbox_ciphertext"],
] as const;

export interface ImportDesktopOptions {
  desktopDir: string;
  dataDir: string;
  userId: number;
  oldKey: Uint8Array;
  masterKey?: Uint8Array;
}

export interface ImportDesktopResult {
  userId: number;
  targetDir: string;
  backupDir: string | null;
  rekeyed: number;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function directoryHasFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  for (const name of readdirSync(path)) {
    const item = lstatSync(join(path, name));
    if (item.isDirectory()) {
      if (directoryHasFiles(join(path, name))) return true;
    } else {
      return true;
    }
  }
  return false;
}

/** 初始化产生的空库允许导入；任何账号、批次、密钥、事件、聊天或工作文件都算已有数据。 */
export function workspaceHasBusinessData(userDir: string): boolean {
  if (directoryHasFiles(join(userDir, "pi")) || directoryHasFiles(join(userDir, "work"))) return true;
  const path = join(userDir, "website-gen.sqlite");
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    for (const table of ["hostinger_accounts", "batches", "sites", "secrets", "run_events", "changesets"]) {
      if (hasTable(db, table) && Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n) > 0) return true;
    }
    if (hasTable(db, "model_providers")) {
      const row = db.prepare("SELECT 1 FROM model_providers WHERE api_key_ciphertext IS NOT NULL LIMIT 1").get();
      if (row) return true;
    }
    return false;
  } finally {
    db.close();
  }
}

function copyTree(source: string, target: string): void {
  if (!existsSync(source)) return;
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`迁移目录里不允许符号链接：${source}`);
  if (!stat.isDirectory()) throw new Error(`预期目录但找到文件：${source}`);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name), to = join(target, name), item = lstatSync(from);
    if (item.isSymbolicLink()) throw new Error(`迁移目录里不允许符号链接：${from}`);
    if (item.isDirectory()) copyTree(from, to);
    else if (item.isFile()) cpSync(from, to, { errorOnExist: true, force: false, preserveTimestamps: true });
    else throw new Error(`迁移目录里有不支持的文件类型：${from}`);
  }
}

function movedQaPath(file: string, oldWork: string, newWork: string): string {
  const absolute = resolve(file);
  const fromOldWork = relative(resolve(oldWork), absolute);
  if (fromOldWork !== ".." && !fromOldWork.startsWith(`..${sep}`) && !isAbsolute(fromOldWork)) return join(newWork, fromOldWork);
  // 从 Windows 复制到 Linux 时 path 模块不能识别盘符，按旧 work/ 后的相对段恢复。
  const match = /(?:^|[\\/])work[\\/](.+)$/i.exec(file);
  return match ? join(newWork, ...match[1].split(/[\\/]+/)) : join(newWork, "qa", basename(file));
}

function rekeyDatabase(db: DatabaseSync, oldKey: Uint8Array, newKey: Uint8Array, oldWork: string, newWork: string): number {
  let rekeyed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of REKEY_COLUMNS) {
      if (!hasTable(db, table)) continue;
      const rows = db.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as unknown as { id: number; value: Uint8Array }[];
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        update.run(seal(Buffer.from(newKey), unseal(Buffer.from(oldKey), row.value)), row.id);
        rekeyed++;
      }
    }
    if (hasTable(db, "sites")) {
      const rows = db.prepare("SELECT id, qa_json FROM sites WHERE qa_json IS NOT NULL").all() as unknown as { id: number; qa_json: string }[];
      const update = db.prepare("UPDATE sites SET qa_json = ? WHERE id = ?");
      for (const row of rows) {
        const report = JSON.parse(row.qa_json) as { shots?: { name: string; file: string }[] };
        if (!Array.isArray(report.shots)) continue;
        report.shots = report.shots.map((shot) => ({ ...shot, file: movedQaPath(String(shot.file), oldWork, newWork) }));
        update.run(JSON.stringify(report), row.id);
      }
    }
    db.exec("COMMIT");
    return rekeyed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function importDesktopData(options: ImportDesktopOptions): Promise<ImportDesktopResult> {
  const desktopDir = resolve(options.desktopDir), dataDir = resolve(options.dataDir);
  const sourceDb = join(desktopDir, "website-gen.sqlite");
  if (!existsSync(sourceDb)) throw new Error(`找不到桌面版数据库：${sourceDb}`);
  if (options.oldKey.byteLength !== 32) throw new Error("旧主密钥必须是 32 字节");
  if (!Number.isSafeInteger(options.userId) || options.userId <= 0) throw new Error("目标用户 ID 必须是正整数");

  const releaseServerLock = acquireServerLock(dataDir);
  try {
  const targetDir = join(dataDir, "users", String(options.userId));
  if (workspaceHasBusinessData(targetDir)) throw new Error("目标用户已有业务数据，拒绝覆盖");
  mkdirSync(dirname(targetDir), { recursive: true });
  const lockPath = join(dataDir, "import.lock");
  let lock: number | undefined;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("另一个导入正在进行；若上次异常退出，请确认服务已停止后删除 data/import.lock");
    throw error;
  }

  const staging = join(dataDir, "users", `.desktop-import-${options.userId}-${randomBytes(6).toString("hex")}`);
  const backupDir = existsSync(targetDir) ? join(dataDir, "users", `.before-desktop-import-${options.userId}-${Date.now()}`) : null;
  let targetMoved = false, stageMoved = false;
  try {
    mkdirSync(staging, { recursive: false });
    const source = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      await backup(source, join(staging, "website-gen.sqlite"));
    } finally {
      source.close();
    }
    copyTree(join(desktopDir, "pi"), join(staging, "pi"));
    copyTree(join(desktopDir, "work"), join(staging, "work"));

    const stagedDb = new DatabaseSync(join(staging, "website-gen.sqlite"));
    let rekeyed: number;
    try {
      migrate(stagedDb);
      const masterKey = options.masterKey ? Buffer.from(options.masterKey) : loadMasterKey(dataDir);
      rekeyed = rekeyDatabase(stagedDb, options.oldKey, deriveUserKey(masterKey, options.userId), join(desktopDir, "work"), join(targetDir, "work"));
      stagedDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      stagedDb.close();
    }

    if (backupDir) { renameSync(targetDir, backupDir); targetMoved = true; }
    renameSync(staging, targetDir); stageMoved = true;
    return { userId: options.userId, targetDir, backupDir, rekeyed };
  } catch (error) {
    if (targetMoved && !stageMoved && backupDir && !existsSync(targetDir)) renameSync(backupDir, targetDir);
    throw error;
  } finally {
    if (!stageMoved) rmSync(staging, { recursive: true, force: true });
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
  } finally {
    releaseServerLock();
  }
}

interface CliOptions { dataDir: string; desktopDir: string; username?: string }
function parseCli(argv: string[]): CliOptions {
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const options: CliOptions = {
    dataDir: resolve(process.env.DATA_DIR || join(repoRoot, "data")),
    desktopDir: resolve(process.env.APPDATA || "", "website-gen"),
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    if (argv[index] === "--data-dir" && value) { options.dataDir = resolve(value); index++; }
    else if (argv[index] === "--desktop-dir" && value) { options.desktopDir = resolve(value); index++; }
    else if (argv[index] === "--user" && value) { options.username = value; index++; }
    else throw new Error(`未知或缺少参数：${argv[index]}`);
  }
  return options;
}

async function exportDesktopKey(desktopDir: string): Promise<{ dir: string; key: Buffer }> {
  if (process.platform !== "win32") throw new Error("DPAPI 主密钥只能在创建它的 Windows 用户下导出");
  const dir = mkdtempSync(join(tmpdir(), "website-gen-desktop-key-"));
  const output = join(dir, "key.bin");
  try {
    const helper = fileURLToPath(new URL("desktop-key-export.cjs", import.meta.url));
    const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    const npmSibling = process.env.npm_execpath ? join(dirname(process.env.npm_execpath), "npx-cli.js") : "";
    const npxCli = [npmSibling, bundled].find((path) => path && existsSync(path));
    if (!npxCli) throw new Error("找不到 Node 自带的 npx-cli.js；请使用包含 npm 的 Node 24 安装包");
    const result = spawnSync(process.execPath, [npxCli, "--yes", "electron@44.7.2", helper, "--", join(desktopDir, "master.key"), output], {
      stdio: ["ignore", "inherit", "inherit"], timeout: 120_000, windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`旧主密钥导出失败（退出码 ${result.status ?? "未知"}）`);
    const key = readFileSync(output);
    if (key.length !== 32) throw new Error("导出的旧主密钥格式不正确");
    return { dir, key };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const adminPath = join(options.dataDir, "admin.sqlite");
  if (!existsSync(adminPath)) throw new Error("找不到 web 管理库；请先启动一次服务器创建管理员，然后停止服务器再导入");
  const admin = openAdminStore(adminPath);
  let user;
  try {
    user = options.username ? admin.findUserByUsername(options.username) : admin.listUsers().find((item) => item.role === "admin" && !item.disabled);
  } finally {
    admin.close();
  }
  if (!user) throw new Error(options.username ? `找不到用户：${options.username}` : "找不到可用管理员");
  if (user.disabled) throw new Error("不能向已停用用户导入数据");

  const exported = await exportDesktopKey(options.desktopDir);
  try {
    const result = await importDesktopData({ desktopDir: options.desktopDir, dataDir: options.dataDir, userId: user.id, oldKey: exported.key });
    console.log(`已导入到用户 ${user.username}（ID ${user.id}），重新加密 ${result.rekeyed} 个字段。`);
    if (result.backupDir) console.log(`导入前的空工作区保留在：${result.backupDir}`);
  } finally {
    exported.key.fill(0);
    rmSync(exported.dir, { recursive: true, force: true });
  }
}

const isDirect = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirect) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
