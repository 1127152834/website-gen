# Web 版部署

阶段一去掉了 Electron。前端由 Vite 构建，Node 24 直接运行 TypeScript 服务端；业务数据按用户保存在 `data/users/<用户 ID>/`，登录与会话在 `data/admin.sqlite`。

## 本机运行（Windows / Linux）

要求：Node.js 24、npm。不要把服务直接暴露到公网；公网部署请使用下面的 Caddy HTTPS 方案。

```powershell
npm ci
npm run build
npm start
```

默认地址是 <http://127.0.0.1:8787>。可设置：

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "8787"
$env:DATA_DIR = "D:\website-gen-data"
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "请换成长随机密码"
npm start
```

Linux 使用同名环境变量。`ADMIN_PASSWORD` 没有设置时，首次启动会生成临时密码并只在控制台打印一次；管理员首次登录后必须修改密码。设置了 `ADMIN_PASSWORD` 也仍必须在首次登录时修改。

主密钥优先读取 `WEBSITE_GEN_MASTER_KEY`（32 字节 base64）；没有设置时首次启动生成 `DATA_DIR/master.key`，Linux 权限为 `0600`。这个密钥丢失后，所有用户保存的 API Token、模型 Key 和站点密码都无法恢复。

开发模式运行一个命令；它会同时启动 Node 后端和 Vite，Vite 把 `/api` 代理到 8787：

```powershell
npm run dev
```

## Docker

复制 `.env.example` 为 `.env`，至少决定管理员和主密钥策略，然后构建启动：

```bash
docker compose up -d --build app
docker compose ps
docker compose logs -f app
```

默认只把应用映射到宿主机 `127.0.0.1:8787`，数据在命名卷 `website-gen-data`。健康检查允许 `/api/me` 返回未登录的 `401`，这表示 HTTP 服务已就绪。

镜像基于 `node:24-bookworm-slim`，构建时用固定版本 `playwright@1.64.1` 安装 Chromium 和系统依赖；Linux QA 使用这个 Chromium。

## Docker + Caddy 自动 HTTPS

1. 把域名的 A/AAAA 记录指向服务器。
2. 防火墙开放 TCP 80、TCP/UDP 443。
3. 在 `.env` 设置 `SITE_ADDRESS=你的域名`、`TRUST_PROXY=1`，并设置强随机 `ADMIN_PASSWORD`。建议同时设置并安全保存 `WEBSITE_GEN_MASTER_KEY`。
4. 启动 HTTPS profile：

```bash
docker compose --profile https up -d --build
docker compose ps
docker compose logs -f caddy app
```

Caddy 自动申请和续期证书，并把请求转发到 `app:8787`。不要绕过 Caddy 把 8787 端口公开到互联网。

只有反向代理能够访问应用入口时才开启 `TRUST_PROXY=1`；此时服务端信任代理设置的 HTTPS 标记和 `X-Forwarded-For` 最后一段客户端 IP。普通本机运行不要开启。检查示例配置而不读取本机 `.env` 时，使用 `docker compose --env-file .env.example config --quiet`。

## 模型厂商地址限制

用户可以自建模型厂商并填写 Base URL，服务端会去请求它。为了不被用来探测服务器所在的内网（例如云主机的元数据地址），默认拒绝解析到本机、内网、链路本地地址的 Base URL。确实要接局域网里自建的模型（如 Ollama）时，由部署者设置 `ALLOW_PRIVATE_MODEL_HOSTS=1`。

## 实时推送与会话

每个用户的 SSE 重连会补发最近 1,000 条推送；服务重启或游标超出保留范围时，前端会重新读取持久化页面数据和日志。SSE 心跳不延长登录会话；实际 API 请求按 7 天滑动续期。改密码会注销其他会话，管理员重置密码或停用用户会注销该用户全部会话。

## 从旧桌面版导入

导入必须在保存旧数据的原 Windows 用户下进行，因为旧 `master.key` 受该用户的 DPAPI 保护。

1. 退出旧桌面应用（关窗口只会缩到托盘，要在托盘图标上右键「退出」，并确认任务管理器里没有「独立站 AI 工厂」进程），再复制整个 `%APPDATA%\website-gen` 做备份。
2. 启动 web 服务一次，完成管理员初始化，然后停止 web 服务。
3. 在源码目录执行（默认导入第一个启用的管理员）：

```powershell
node scripts/import-desktop-data.ts
# 指定用户或目录：
node scripts/import-desktop-data.ts --user alice --desktop-dir "$env:APPDATA\website-gen" --data-dir "D:\website-gen-data"
```

脚本通过 `npx --yes electron@44.7.2` 临时运行最小 DPAPI 辅助程序；Electron 不会加入项目依赖。明文旧密钥只写入系统临时目录，成功或失败都会删除。脚本在临时工作区复制数据库、`pi/`、`work/`，重新加密全部凭据并修正 QA 截图路径，全部完成后才切换目标目录。目标用户已有账号、批次、密钥、事件、聊天或工作文件时会拒绝覆盖；初始化生成的空工作区会保留为 `.before-desktop-import-*` 回滚目录。

## 备份与恢复

备份前停止服务，保证 SQLite WAL 已落盘：

```bash
docker compose --profile https stop
docker run --rm -v website-gen_website-gen-data:/data -v "$PWD/backup:/backup" alpine \
  tar czf /backup/website-gen-data.tgz -C /data .
```

非 Docker 部署直接复制整个 `DATA_DIR`。备份必须同时包含：

- `admin.sqlite`（用户、会话与登录记录）；
- `users/`（每个用户的数据库、聊天、QA 截图和工作文件）；
- `master.key`，或者部署所用的 `WEBSITE_GEN_MASTER_KEY`。

恢复时先停止服务，把完整数据目录恢复到原位置并使用同一主密钥，再启动服务。不要只恢复 SQLite、不恢复主密钥；也不要生成新主密钥覆盖旧文件。
