# Grist 集成

## 使用

1. 设置 →「Grist 表格」保存公网 HTTP(S) 地址和 Grist API Key；留空的 Key 不会覆盖旧值。测试连接显示 Grist 用户名和邮箱。
2. 侧栏「表格」选择团队站点 → 工作空间 → 文档 → 表。选择按登录用户存入 localStorage。
3. 支持 Text / Numeric / Int / Bool / Date / Choice 单元格保存和新增空行。日期按 UTC 日历日与 Unix 秒数转换。公式与复杂类型只读。
4. 设置页生成 MCP 令牌并立即复制命令，明文不再从服务器返回：

   ```sh
   claude mcp add --transport http grist https://<当前站点>/api/mcp --header "Authorization: Bearer <生成时的令牌>"
   ```

   重新生成使旧令牌失效；撤销、停用用户、管理员重置密码会使其失效。令牌拥有该用户保存的 Grist API Key 的读写权限，包括删除数据/结构，只应提供给可信 AI 客户端。

## 经代理访问 Grist

服务器直连 Grist 被其前置防火墙（如 Cloudflare）拦截、但通过受信代理可以访问时，在启动 Node 24 进程前启用环境代理。Node 的 `fetch` 默认不会仅因存在 `HTTPS_PROXY` 就使用代理；设置 `NODE_USE_ENV_PROXY=1` 后才会读取 `HTTPS_PROXY` 并遵守 `NO_PROXY`。`NO_PROXY` 至少包含 `localhost,127.0.0.1`。参见 [Node.js 24 内置代理说明](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。

```powershell
# PowerShell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890" # 替换为实际代理
$env:NO_PROXY = "localhost,127.0.0.1"
npm start
```

```bash
# Linux
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1 npm start
```

Docker 部署可在 Compose override 中为 `app` 服务设置相同的三个变量，再启动服务：

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

代理地址必须能从容器内访问；容器里的 `127.0.0.1` 不是宿主机。完整启动写法见 [部署文档](deploy.md#出站代理grist-等外部服务)。

## 数据与安全

- 用户库迁移 012 添加 `workspace_settings`，地址为 `grist.baseUrl`；Key 通过 `setSecret/getSecret` 存为 `grist.apiKey`，只返回末 4 位 hint。
- `admin.sqlite` 的 `grist_mcp_tokens` 一用户一令牌，仅存 `token_hash`（SHA256）、`user_id`、创建时间和最近使用时间。生成使用 32 随机字节、base64url 编码。
- `/api/mcp` 在 Cookie/CSRF 路由之前独立处理，仅接受 Bearer；Cookie 和 `X-Requested-With` 均不能替代令牌。每个 HTTP 请求、每次数据工具调用重新核对用户与令牌状态。
- MCP 每请求新建 SDK server / Streamable HTTP transport，无会话 ID，JSON 响应；POST only、1 MiB 请求上限、响应 `no-store`，无效令牌 401。
- REST 每请求做严格公网地址预检，拒绝回环/私网/链路本地（包括 IPv4 映射 IPv6），不使用 `ALLOW_PRIVATE_MODEL_HOSTS` 放行，不跟随重定向，超时 30 秒。
- REST 在 JSON 解析前流式限制成功响应 16 MiB、错误响应 64 KiB，同时检查 Content-Length 与实际解压后字节；超限取消 reader 并中止请求，防止用户配置的远端返回无界响应占满多租户进程内存。
- 地址防护复用 `net-guard` 的 DNS 预检，不是连接 IP 钉扎；**不能声称完全防御 DNS rebinding / DNS 校验与实际连接之间的竞态**。公网部署宜再加出站网络策略。
- 已开始的远端操作无法通过撤销令牌回滚；撤销阻止新的请求/工具调用。

## RPC（全部 `grist.` 前缀）

工作区 handlers：

| 方法 | 参数 / 返回 |
|---|---|
| `grist.settings.get` | 无；`{baseUrl, apiKeyHint, configured}` |
| `grist.settings.save` | `{baseUrl, apiKey?}`；返回安全设置摘要 |
| `grist.testConnection` | `{baseUrl?, apiKey?}`；测试输入但不保存，返回 active-session profile |
| `grist.listOrgs` | 无；org 数组 |
| `grist.listWorkspaces` | `{orgId}`；workspace 数组 |
| `grist.listDocs` | `{workspaceId}`；从 workspace 响应提取 docs 数组 |
| `grist.getDocInfo` | `{docId}` |
| `grist.getTables` | `{docId}`；`{tables}` |
| `grist.getTableColumns` | `{docId, tableId}`；`{columns}` |
| `grist.listRecords` | `{docId, tableId, filter?, sort?, limit?}`；默认 1000，上限 1001，用多出的 1 行判断截断 |
| `grist.addRecords` | `{docId, tableId, records:[{fields}]}` |
| `grist.updateRecords` | `{docId, tableId, records:[{id, fields}]}` |

HTTP 层在 Cookie 会话鉴权后附加管理库 RPC（身份只能来自当前会话，不接受参数指定其他用户）：

- `grist.mcpToken.status` → `{createdAt, lastUsedAt}`，无令牌时为 null。
- `grist.mcpToken.generate` → `{token, createdAt}`，仅这一次返回明文。
- `grist.mcpToken.revoke` → `{ok:true}`。

## MCP 工具（22 个）

工具参数及英文描述集中在 `src/backend/grist-tools.ts`，`tools/list` 可查看完整 zod 参数 schema。

- 发现：`grist_help`、`grist_get_user_profile`、`grist_list_orgs`、`grist_list_workspaces`、`grist_list_docs`、`grist_get_doc_info`。
- 读取：`grist_get_tables`、`grist_get_table_columns`、`grist_list_records`、`grist_query_document`、`grist_list_snapshots`、`grist_list_attachments`。
- 写入：`grist_add_records`、`grist_update_records`、`grist_remove_records`。
- 结构：`grist_create_doc`、`grist_create_table`、`grist_add_table_column`、`grist_update_table_column`、`grist_rename_table`、`grist_remove_table`、`grist_remove_table_column`。

records、SQL、attachments 返回默认 100、最大 1000 条，并在输出再次截断；附件也向 REST 传递 limit。SQL 以外的写入每次最多 1000 条。工具错误为 MCP `isError`，不抛到 HTTP 主循环。

## 简化与验证边界

- 这是官方工具命名的 REST 子集，不是官方付费 MCP 的内部实现、完整兼容实现或 OAuth 连接器。
- SQL 只接收单条 SELECT（不支持 WITH、自然语言、多个语句）；调用 AI 自行编写 SQL。查询增加外层 LIMIT，并由 Grist REST 只读 SQL 端点执行。
- 不提供页面/组件管理、附件下载 URL、访问规则参考、可用自定义组件目录；`grist_help` 明确列出。
- UI 不提供删除行或结构编辑；只显示前 1000 行，使用 1001 行探针提示截断；没有分页/全量下载。
- 超过 16 MiB 的 JSON 响应会被拒绝，而非整包载入。大字段表可通过 MCP 减小 limit，或直接在 Grist 中查看。
- 文档链接 `<baseUrl>/o/<orgDomain>/<urlId>` 已由用户在沙箱外的真实实例验证可用；Grist 会自动以 302 重定向到带文档名的地址。无 org domain 时仍按实现走根文档路径。
- 用户已在沙箱外以真实 Grist 实例完成联调：22 个 MCP 工具、表格页单元格编辑和新增行均通过。本轮没有重复发起真实 Grist 请求。

## 修改文件

新增：

- `src/backend/grist.ts`、`grist.test.ts`
- `src/backend/grist-settings.ts`、`grist-settings.test.ts`
- `src/backend/grist-tools.ts`、`grist-tools.test.ts`
- `src/server/grist-tokens.ts`、`grist-tokens.test.ts`
- `src/server/grist-mcp.ts`、`grist-mcp.test.ts`、`grist-http.test.ts`
- `src/renderer/src/pages/grist-settings.tsx`、`tables.tsx`、`grist-table-helpers.ts`、`grist-table-helpers.test.ts`
- 本说明文档。

修改：

- `package.json`、`package-lock.json`：仅增加直接依赖 `zod: 4.6.7`，没有升级其他包；以 `npm install --ignore-scripts --no-audit --no-fund --offline` 更新 lock。
- `src/backend/index.ts`、`migrations.ts`：工作区 Grist 服务、RPC、迁移与工具生命周期跟踪。
- `src/backend/mail-migration.test.ts`：仅把固定版本 11 断言改为 `MIGRATIONS.length`，以支持追加迁移。
- `src/server/admin-db.ts`、`http.ts`：令牌表、停用/重置撤销、Bearer 路由和安全令牌 RPC。
- `src/renderer/src/App.tsx`、`lib/routes.ts`、`lib/routes.test.ts`、`pages/settings.tsx`：入口、路由与设置分区。

没有修改 `mailbox-service.ts`、`mailbox-service.test.ts`、既有前端邮件文件、`.env`，没有 git commit。

## 本地验证与回滚

- 本轮 `npm run typecheck` 通过；沙箱内同进程命令完成 **373/373** 个测试。用户在修正前已于沙箱外完成 371 个测试和真实 Grist 联调。
- 上一轮 Chrome CUA 本地假 RPC 界面检查覆盖空状态、设置提示/连接测试、一次性令牌/命令、层级切换、Text/Bool/Date 保存、新增行、复杂列只读与 1000 行截断；它与上面的真实实例联调是两组独立验证。
- 标准 `npm test` 在此沙箱受 Node 子进程 `spawn EPERM` 阻断；可用 `node --test --test-isolation=none "src/**/*.test.ts"` 跑同一套测试。在沙箱外仍应重跑原命令。
- 上一轮 native config loader 前端构建通过（存在既有 >500 kB chunk 警告）；沙箱内可用 `npm run build -- --configLoader native`，沙箱外可重跑标准构建。
- 回滚前停止使用该功能，只恢复对应修改前的文件，不做 `git reset/clean`，不碰其他人的改动。数据库新增表不要自动删除/降级。

参考：[官方 MCP 工具目录](https://support.getgrist.com/mcp/)、[REST OpenAPI](https://raw.githubusercontent.com/gristlabs/grist-help/master/api/grist.yml)。
