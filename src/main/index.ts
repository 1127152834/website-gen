// 主进程：只管窗口、托盘、单实例，以及拉起/重启后台进程；业务逻辑都在后台进程里。
import { join } from "node:path";
import {
  app, BrowserWindow, dialog, Menu, MessageChannelMain, nativeImage, shell, Tray, utilityProcess,
  type UtilityProcess,
} from "electron";
import backendPath from "../backend/index.ts?modulePath";
import iconPath from "../../resources/icon.png?asset";
import { loadMasterKey } from "./master-key.ts";

// 冒烟测试用临时数据目录，不碰真实的应用数据
if (process.env.WEBSITE_GEN_USER_DATA) app.setPath("userData", process.env.WEBSITE_GEN_USER_DATA);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let backend: UtilityProcess | null = null;
let quitting = false;
let masterKey: Buffer | null = null;

function startBackend() {
  backend = utilityProcess.fork(backendPath, [app.getPath("userData"), join(app.getAppPath(), "resources")], { serviceName: "website-gen backend" });
  // 第一条消息交付主密钥（不走命令行参数或环境变量，避免出现在进程列表里）
  backend.postMessage({ type: "init", masterKey: masterKey?.toString("base64") ?? null });
  backend.on("exit", (code) => {
    backend = null;
    if (quitting) return;
    console.error(`backend exited with code ${code}, restarting`);
    setTimeout(() => {
      startBackend();
      connectWindow();
    }, 1000);
  });
}

// 界面和后台之间建一条新通道：窗口每次加载、后台每次重启都要重建
function connectWindow() {
  if (!win || !backend) return;
  const { port1, port2 } = new MessageChannelMain();
  backend.postMessage(null, [port1]);
  win.webContents.postMessage("backend-port", null, [port2]);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "独立站 AI 工厂",
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-finish-load", connectWindow);
  // 界面只显示应用自带页面：新窗口一律拒绝，https 链接交给默认浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // 关窗口 = 最小化到托盘，后台任务继续跑；从托盘菜单「退出」才真正退出
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip("独立站 AI 工厂");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: showWindow },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]));
  tray.on("click", showWindow);
}

// 单实例：防止两个实例同时跑任务、同时写 SQLite
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  void app.whenReady().then(async () => {
    try {
      masterKey = await loadMasterKey();
    } catch (e) {
      // 没有主密钥时应用照常打开，但不能保存或读取任何凭据
      dialog.showErrorBox("无法解开本机密钥", `${(e as Error).message}\n\n已保存的账号凭据暂时不可用。`);
    }
    startBackend();
    createWindow();
    createTray();
  });
}
