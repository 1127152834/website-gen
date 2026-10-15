import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WorkspaceManager } from "../backend/workspaces.ts";
import { createApp } from "./http.ts";
import { loadMasterKey } from "./keys.ts";
import { acquireServerLock } from "./lock.ts";

export { createApp } from "./http.ts";
export { loadMasterKey, deriveUserKey } from "./keys.ts";
export { acquireServerLock } from "./lock.ts";

export async function startServer(env = process.env) {
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const dataDir = resolve(env.DATA_DIR || resolve(repoRoot, "data"));
  const distDir = resolve(env.DIST_DIR || resolve(repoRoot, "dist"));
  const host = env.HOST || "127.0.0.1", port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT 必须是 1 到 65535 之间的整数");
  const releaseLock = acquireServerLock(dataDir);
  let app: Awaited<ReturnType<typeof createApp>>;
  try {
    const masterKey = loadMasterKey(dataDir, env.WEBSITE_GEN_MASTER_KEY);
    const workspaceManager = new WorkspaceManager({ dataDir, masterKey, resourcesDir: resolve(repoRoot, "resources") });
    app = await createApp({ dataDir, distDir, workspaceManager, env, releaseLock });
  } catch (error) {
    releaseLock(); throw error;
  }
  try {
    await new Promise<void>((resolveListen, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, host, () => { app.server.off("error", reject); resolveListen(); });
    });
  } catch (error) {
    await app.close(); throw error;
  }
  console.log(`website-gen 已启动：http://${host}:${port}`);
  return app;
}

const isDirect = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  startServer().then((app) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void app.close().then(() => { process.exitCode = 0; }).catch((error) => { console.error(error); process.exitCode = 1; });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }).catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
