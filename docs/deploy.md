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

## 出站代理（Grist 等外部服务）

仅当服务器直连外部 HTTPS 服务被防火墙或 Cloudflare 拦截、但通过受信代理可以访问时才配置。Node 24 的 `fetch` 默认不会仅因存在 `HTTPS_PROXY` 就使用代理；必须在进程启动前设置 `NODE_USE_ENV_PROXY=1`，此后会读取 `HTTPS_PROXY` 并遵守 `NO_PROXY`。`NO_PROXY` 至少包含 `localhost,127.0.0.1`，避免本机请求绕到代理。参见 [Node.js 24 内置代理说明](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。

PowerShell：

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890" # 替换为实际代理
$env:NO_PROXY = "localhost,127.0.0.1"
npm start
```

Linux：

```bash
NODE_USE_ENV_PROXY=1 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npm start
```

Docker 可通过 Compose override 把同样的变量传入 `app` 容器：

```yaml
# compose.proxy.yml
services:
  app:
    environment:
      NODE_USE_ENV_PROXY: "1"
      HTTPS_PROXY: "http://proxy.example.com:8080"
      NO_PROXY: "localhost,127.0.0.1"
```

```bash
docker compose -f docker-compose.yml -f compose.proxy.yml up -d --build app
```

把示例代理地址替换为容器能够访问的地址；容器里的 `127.0.0.1` 指向容器自身，不是宿主机代理。

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

只有反向代理能够访问应用入口时才开启 `TRUST_PROXY=1`；此时代理必须覆盖 HTTPS 标记，并把 `X-Forwarded-For` 覆盖成单个有效客户端 IP，不能追加地址链。地址链或非法值会回退到 socket 地址。普通本机运行不要开启。上面的自动 ACME 方案仅用于直连源站，**不用于下面的 Cloudflare 部署**。

## 模型厂商地址限制

用户可以自建模型厂商并填写 Base URL，服务端会去请求它。为了不被用来探测服务器所在的内网（例如云主机的元数据地址），默认拒绝解析到本机、内网、链路本地地址的 Base URL。确实要接局域网里自建的模型（如 Ollama）时，由部署者设置 `ALLOW_PRIVATE_MODEL_HOSTS=1`。

## 实时推送与会话

每个用户的 SSE 重连会补发最近 1,000 条推送；服务重启或游标超出保留范围时，前端会重新读取持久化页面数据和日志。SSE 心跳不延长登录会话；实际 API 请求按 7 天滑动续期。改密码会注销其他会话，管理员重置密码或停用用户会注销该用户全部会话。

## 邮件出站网络

邮箱中心不需要新的入站端口，但运行 Node 服务或容器的网络必须允许以下 TCP 出站连接：

- `imap.hostinger.com:993`：IMAP over TLS，用于验证密码、同步文件夹与邮件、IDLE 监听、标记已读和移动到废纸篓；
- `smtp.hostinger.com:465`：SMTP over TLS，用于发信。

每个用户工作区最多保持 15 条 IMAP IDLE 连接；超出的邮箱每 2 分钟轮询。请相应设置容器连接数、NAT/防火墙空闲超时和文件描述符上限。邮件中的 URL、远程图片和跟踪像素不会产生任何出站请求；只有用户明确点击附件下载时，服务端才从已认证的 IMAP 会话读取该附件。

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

## 部署到 tool.aoeen.com（Cloudflare）

目标为 Ubuntu 22.04.4，`tiancheng@66.163.114.40`。以下命令由操作者执行；脚本不依赖服务器上的 Git/Node，不拉取远程仓库。本节使用独立的 `deploy/docker-compose.prod.yml`，**不要与根目录 compose 合并，不要运行 `down -v`、volume prune 或删除数据卷**。

### 0. 审阅与准备

- 本机需要 Git Bash、OpenSSH、Node 24（仅桌面导入需要）及已有项目依赖；服务器初始只需 SSH。
- 发布源严格为 **`git archive HEAD`**。新工具和客户端 IP 改动必须由仓库所有者审阅后纳入 HEAD；没有纳入时 `deploy.sh` 会拒绝发布。未提交的其他任务改动不会上传。不要提交 `deploy/.local-baseline/`、`deploy/.local-verification/`、证书、实际环境配置或数据。本工具不会执行 commit/reset/checkout。
- 本机先做静态检查（不会读取本机实际环境配置）：

```bash
bash deploy/check-scripts.sh  # bash -n includes all scripts AND their remote heredocs; optional ShellCheck
node --test --test-isolation=none "src/**/*.test.ts"
node --test --test-isolation=none deploy/backup-data.test.mjs
npx tsc --noEmit -p tsconfig.json
docker compose --project-directory . --env-file deploy/env.production.example -f deploy/docker-compose.prod.yml config --quiet
# 如已安装：
shellcheck -x deploy/*.sh scripts/deploy.sh scripts/import-desktop-to-server.sh
```

### 1. 一次性：sudo、Cloudflare、系统 bootstrap

由服务器管理员用 `sudo visudo -f /etc/sudoers.d/tiancheng` 配置：

```sudoers
tiancheng ALL=(ALL:ALL) NOPASSWD: ALL
```

这会授予完整 root 权限；Docker 组也等同 root 权限，只应给可信运维账号。另开 SSH 会话验证 `sudo -n true` 成功，保留原 SSH 会话，不要在尚未验证时关闭它。

Cloudflare 设置：

1. DNS 的 `tool` **A 记录**指向 `66.163.114.40`，开启橙云。不要配置指向本服务器的源站 AAAA：本方案刻意只发布 IPv4 Docker 端口；这不影响 IPv6 访客访问 Cloudflare 边缘。
2. SSL/TLS 选择 **Full** 或 **Full (strict)**，与服务器 `CF_SSL_MODE=full|strict` 一致；不支持 Flexible。
3. 保留 `CF-Connecting-IP`，关闭 Pseudo IPv4 的 **Overwrite Headers**（可选 Off/Add Header）；不要用 Worker/Transform Rule 删除或改写访客 IP。对 `/api/*` 设置绕过缓存，启用边缘 HTTPS 跳转。源站 SSE 不缓冲不等于边缘缓存规则已验证。

本机 Git Bash：

```bash
cd /f/projects/website-gen
export DEPLOY_HOST=66.163.114.40
export DEPLOY_USER=tiancheng
ssh "$DEPLOY_USER@$DEPLOY_HOST" 'sudo -n true'
scp deploy/server-bootstrap.sh deploy/cloudflare-firewall.sh "$DEPLOY_USER@$DEPLOY_HOST:/tmp/"
ssh "$DEPLOY_USER@$DEPLOY_HOST" 'sudo -n bash /tmp/server-bootstrap.sh'
# 必须新连接，令 docker 组生效；已有交互会话请退出后重新登录。
ssh "$DEPLOY_USER@$DEPLOY_HOST" 'id; docker compose version; docker info >/dev/null; sudo -n ufw status verbose'
```

bootstrap 可重跑，会更新/升级 apt、从 Docker 官方 apt 源安装 Engine/Compose、启用 UTC/安全更新与每日备份 cron。变更前的系统配置和防火墙快照保存在脚本打印的 `/var/backups/website-gen-bootstrap/` 子目录；不自动回灌全机 iptables，以免破坏 Docker/其他服务规则。系统升级后如需重启，选择维护窗口，重启后再查防火墙与服务。

Cloudflare 范围来自官方 [IPv4](https://www.cloudflare.com/ips-v4) 和 [IPv6](https://www.cloudflare.com/ips-v6)，脚本内含 15/7 段后备副本（本次核对日期 2026-10-15）。刷新失败会明确打印后备使用情况；范围变动后重跑 bootstrap，再重新启动 Caddy 加载新的信任列表。

**重要：Docker 发布端口绕过 UFW。** 除 UFW 的 SSH 22/tcp 全开放、80/443 仅 Cloudflare 外，还安装 `DOCKER-USER` 的 Cloudflare 源地址限制与 Docker 启动门禁。规则只匹配 DNAT 的入站 web 连接，不阻断 app 的 HTTPS、IMAP 993、SMTP 465 出站。只发布 `0.0.0.0:80/443` TCP，不发布 IPv6/UDP 或 app:8787。不要改为 `80:80` 通配发布，也不要增加应用的 host port。宿主机/服务商出站策略仍需允许 DNS、HTTPS、993/465；脚本无法验证供应商是否封锁邮件端口。参考 [Docker 官方防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

### 2. 首次发布与服务器配置

```bash
# 只需初次：创建 shared/.env 模板；密码未配置时预期失败，不激活发布。
bash scripts/deploy.sh
ssh -t "$DEPLOY_USER@$DEPLOY_HOST" 'nano /opt/website-gen/shared/.env'
```

只编辑服务器 `/opt/website-gen/shared/.env`，权限 `0600`，以后发布不会覆盖。使用简单的、不加引号的 `KEY=value`；至少保持：

```dotenv
HOST=0.0.0.0
PORT=8787
TRUST_PROXY=1
SITE_ADDRESS=tool.aoeen.com
CF_SSL_MODE=full
ADMIN_USERNAME=admin
ADMIN_PASSWORD=自行填写至少12字符的长随机密码
WEBSITE_GEN_MASTER_KEY=
ALLOW_PRIVATE_MODEL_HOSTS=0
```

可在服务器用 `openssl rand -hex 24` 生成密码并通过安全终端填入，**不要写进命令参数、提交记录或共享日志**。默认 `master.key` 保存在数据卷；如需桌面导入，必须留空 `WEBSITE_GEN_MASTER_KEY`，避免覆盖导入密钥。管理员首次登录必须改密码；已初始化数据库不会因修改环境变量而重设管理员密码。

- `CF_SSL_MODE=full`：Caddy `tls internal`，仅由内部 CA 签发/续期；Cloudflare 要选 **Full**。
- `CF_SSL_MODE=strict`：从 Cloudflare 控制台为 `tool.aoeen.com` 创建 Origin Certificate，把 PEM/私钥安全上传到服务器 `/opt/website-gen/shared/certs/origin.pem`、`origin.key`。目录 `0700`，私钥 `0600`，归 `tiancheng`。每个发布的 `deploy/certs` 都链接到这里，所以 `current/deploy/certs/origin.pem`/`origin.key` 是要求的证书入口；不打包进 Git，也不会随发布清理。Cloudflare 要选 **Full (strict)**。部署会检查有效期/域名及 Caddy 配置；Origin Certificate 不受普通浏览器信任是正常的。

两种模式都不使用 ACME HTTP-01/TLS-ALPN，也不需要 Cloudflare API Token。配置完成后：

```bash
bash scripts/deploy.sh
curl -I https://tool.aoeen.com
```

脚本打包 HEAD、上传、解压至 `/opt/website-gen/releases/<UTC时间>-<PID>`，验证 Compose/Caddy 后原子切换 `current`，使用固定 project `website-gen` 构建/启动，等待 app 健康及 Caddy HTTPS `/_origin_health`，输出容器状态和 Caddy 最后日志，保留 3 个发布及 `previous`。失败时尽力恢复原发布并返回非零；若恢复失败，必须人工处理，不会宣称成功。原始 app 日志可能含首次密码，不会自动倾倒。健康检查只证明源站本地就绪，不能证明公网 Cloudflare、证书模式、防火墙、真实访客 IP 或邮件出站均已通过。

持久化命名卷固定为 `website-gen-data`（不是旧示例的 project 前缀卷）；Caddy 两个卷同样使用固定名字。app 与 Caddy 只在 compose bridge 网络通信，app 没有发布端口；网络没有设置 `internal: true`，因为 app 必须出站联网。Caddy 只信任 Cloudflare CIDR，从 `CF-Connecting-IP` 解析真实访客地址；未解析成功时拒绝代理，避免按边缘地址限流。它覆盖 XFF 为单 IP、XFP 为 https，并删除原始访客转发头；`TRUST_PROXY=1` 因而只信任隔离网络内 Caddy 设置的值。SSE 使用 `flush_interval -1`，不启用代理响应缓冲。[Caddy 代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

### 3. 桌面数据导入

**会替换服务器数据，不能合并用户。** 在原 Windows 用户下备份 `%APPDATA%\\website-gen`；从托盘完全退出旧桌面程序，并确认进程已结束。本地需要 Node 24、已安装项目依赖、能下载 `electron@44.7.2`，DPAPI 解密必须由创建旧数据的 Windows 用户执行。

```bash
# 首次发布已产生 admin.sqlite，因此必须显式同意替换；先确认是要替换的服务器。
bash scripts/import-desktop-to-server.sh --desktop-quit-confirmed --force-replace
# 非默认桌面目录：追加 --desktop-dir 'C:\Users\你的用户\AppData\Roaming\website-gen'
```

不带 `--force-replace` 时，只要服务器卷里存在 `admin.sqlite` 就拒绝，且不停止 app。脚本在本机临时目录建立全新 `DATA_DIR`、`admin` 随机临时密码（仅显示一次）和 `master.key`，调用现有 `import-desktop-data.ts` 重加密，再把 QA 截图路径改为 Linux `/app/data/users/.../work/...`。不会读取/修改仓库的实际数据目录。上传仅包含 `admin.sqlite`、`users/`、`master.key`；本机临时文件退出时删除，不要把终端输出送入共享日志。

服务器验证上传内容、停止 app；强制替换先完整备份原卷（含 WAL/工作文件）到 `backups/pre-import-*.tar.gz` 并校验，再复制、修正 `1000:1000` 和密钥权限、启动/检查健康。失败尽力恢复原卷并返回非零。`pre-import-*` 是人工回滚备份，不受 14 天定时清理，确认无须回退后手工处理。导入后用显示的临时密码登录 `admin` 并立即改密；环境配置的初始密码不会覆盖已导入的管理员。

### 4. 后续发布、回滚、日志

```bash
bash scripts/deploy.sh
bash scripts/deploy.sh --rollback
```

`--rollback` 交换 `current`/`previous`，重建并健康验证旧发布，不回滚或删除数据。连续执行相当于在两个版本间切换。**代码回滚不是数据库迁移回滚**：有不兼容迁移时先评估并使用对应数据备份恢复。每个脚本会使用同一把 operations lock 防止部署/导入/备份同时运行。

服务器 SSH 会话：

```bash
cd /opt/website-gen/current
source deploy/production.sh
production_init "$PWD"
compose ps
compose logs --tail 100 caddy
compose logs --tail 100 app   # 仅可信终端；不要分享未经脱敏的日志
sudo ufw status verbose
sudo iptables -S DOCKER-USER
sudo iptables -S WEBSITE_GEN_CF
sudo systemctl status docker
```

Origin Certificate 不会自动续期；每日备份日志会在不足 30 天时警告，需监控该日志并提前轮换。更新 SSL 模式或 Origin Certificate 后重新运行 `deploy.sh`；仅替换相同路径的证书文件不会自动重新加载 Caddy，必须在维护窗口 `production_validate` 后执行 `compose up -d --force-recreate caddy`。证书与 shared 配置独立于代码回滚。

### 5. 每日备份与恢复

cron 每天 **03:15 UTC** 以 root 执行 `current/deploy/backup.sh`，日志 `/var/log/website-gen-backup.log`（轮转）。可立即执行：

```bash
sudo bash /opt/website-gen/current/deploy/backup.sh
sudo ls -lh /opt/website-gen/backups
```

不停止 app；Node 24 `node:sqlite.backup` 为 `admin.sqlite` 和每个数字用户目录的 `website-gen.sqlite` 创建一致快照，逐库 `integrity_check`，同时备份主密钥和 `pi/`/`work/`。在线快照限时 15 分钟，超时中止并释放锁；失败写入 cron 日志，需要监控。每个 SQLite 库单独一致，**多个库不是同一全局时点**；活动工作文件也不是原子快照，需要严格业务全局一致性时另做停机全卷备份。环境变量主密钥会私密导出为备份的 `master.key`，不会打印。完成后 gzip 校验、SHA-256、私有权限，清理超过 14 天的定时备份。密钥和数据库同包，备份必须加密离机保存并限制访问；只有本机备份无法抵御整盘损坏。

恢复步骤（服务器可信 root 终端；替换第一行文件名；仅恢复自己生成且校验匹配的归档）：

```bash
sudo -i
set -euo pipefail
umask 077
ROOT=/opt/website-gen
BACKUP="$ROOT/backups/website-gen-替换为时间戳.tar.gz"
cd "$ROOT/backups"
sha256sum -c "$BACKUP.sha256"
gzip -t "$BACKUP"
cd "$ROOT/current"
source deploy/production.sh
production_init "$PWD"
production_lock
IMAGE=$(compose images -q app)
test -n "$IMAGE"
compose stop app
# 先保存当前全卷（包括 SQLite WAL）；不要删除这份回滚快照。
SAFETY="pre-restore-$(date -u +%Y%m%dT%H%M%S).tar.gz"
docker run --rm --user 0 -v website-gen-data:/data:ro -v "$ROOT/backups:/backup" "$IMAGE" \
  sh -eu -c "umask 077; tar -czf /backup/$SAFETY -C /data ."
gzip -t "$ROOT/backups/$SAFETY"
# 仅固定命名卷内的文件会被替换；不删除卷。
docker run --rm --user 0 -v website-gen-data:/data -v "$BACKUP:/restore.tar.gz:ro" "$IMAGE" \
  sh -eu -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -xzf /restore.tar.gz -C /data; chown -R 1000:1000 /data; chmod 600 /data/master.key'
compose up -d app
production_health
exit
```

恢复必须包含同一份 `master.key`。如果 shared 配置设置了 `WEBSITE_GEN_MASTER_KEY`，恢复前确认它与备份密钥相同，或在停机期间清空该项改用恢复出的文件；不要打印密钥作比较。恢复失败保持维护状态，按同样步骤恢复 `pre-restore-*`；不要初始化新密钥。定期在隔离环境做恢复演练。

### 6. 故障定位与验收边界

| 现象 | 含义与检查 |
| --- | --- |
| Cloudflare **521** | 源站拒绝连接/不可达。查 DNS A、Caddy 是否运行、80/443、UFW 与 DOCKER-USER 的 Cloudflare 范围及服务商安全组；不是 app 的登录错误。 |
| **525** | Cloudflare 与源站 TLS 握手失败。查 Caddy TLS 日志、443 监听、证书与私钥匹配，确认没有 Flexible/错配配置。 |
| **526** | Full (strict) 校验证书失败。使用覆盖 tool.aoeen.com、有效且私钥匹配的 Origin Certificate；不要把 `tls internal` 搭配 strict。 |
| 源站 **400 Unresolved client IP** | 缺失/非法 CF-Connecting-IP，或不是 Cloudflare 来源；检查 Cloudflare 变换/Worker、代理范围并重新加载 Caddy。直接用源站 IP 访问被拒绝是设计行为。 |
| **502 / unhealthy** | 查 app 日志、构建结果、卷权限 1000:1000、主密钥、磁盘空间；`/api/me` 未登录 401 本身代表 app 正常。 |
| SSE 不实时 | 检查 Caddy flush 配置和 Cloudflare `/api/*` 不缓存规则；用真实登录会话验证事件及时抵达，不要把静态健康端点当 SSE 验证。 |
| Docker permission denied | 新开 SSH 会话确认 docker 组；检查 passwordless sudo，不要通过公开 app 端口绕过代理。 |

上线后必须由操作者验证：公网 HTTPS/Cloudflare SSL 模式、非 Cloudflare 直连被拒、app 无 host 端口、两个真实访客的登录限流相互独立、伪造 XFF 不改变限流地址、登录 cookie 带 Secure、真实 SSE、993/465 邮件及备份恢复演练。脚本的本地健康通过不能替代这些验收。Cloudflare 错误定义见 [521](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-521/)、[525](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-525/)、[526](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-526/)。
