// 用 Electron 可执行文件以 Node 模式运行 poc/electron-node.mjs（Windows 上设置环境变量的跨平台写法）
import { spawnSync } from "node:child_process";
import electron from "electron";
const r = spawnSync(electron, ["poc/electron-node.mjs"], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
process.exit(r.status ?? 1);
