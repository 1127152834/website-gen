import { ipcRenderer } from "electron";

// 主进程送来连接后台的 MessagePort。contextIsolation 下不能直接把端口交给页面，用 window.postMessage 转交。
ipcRenderer.on("backend-port", (e) => {
  window.postMessage("backend-port", "*", e.ports);
});
