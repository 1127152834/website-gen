// 开发时前后端一起运行；不经 shell 启动，Windows / Linux 使用相同入口。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "vite";

const backend = spawn(process.execPath, ["--watch", "src/server/index.ts"], {
  cwd: resolve(import.meta.dirname, ".."), stdio: "inherit", env: process.env,
});
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let stopping = false;
const stop = async (code: number) => {
  if (stopping) return;
  stopping = true;
  await vite?.close();
  backend.kill("SIGTERM");
  process.exitCode = code;
};
backend.once("error", (error) => { console.error(error.message); void stop(1); });
backend.once("exit", (code) => void stop(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop(0));
try {
  vite = await createServer();
  if (stopping) await vite.close();
  else { await vite.listen(); vite.printUrls(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}
