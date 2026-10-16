import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** 防止服务端与桌面数据导入器同时修改同一个数据目录。 */
export function acquireServerLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "server.lock");
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    // 容器里每次启动的 PID 都相同：记录的是自己的 PID 说明是上次没释放的残留锁。
    if (pid !== process.pid && processExists(pid)) throw new Error(`数据目录已被进程 ${pid} 使用`);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, `${process.pid}\n`);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}
