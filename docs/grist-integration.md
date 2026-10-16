# Grist 集成

## 使用

1. 设置 →「Grist 表格」保存公网 HTTP(S) 地址和 Grist API Key；留空的 Key 不会覆盖旧值。测试连接显示 Grist 用户名和邮箱。
2. 侧栏「表格」选择团队站点 → 工作空间 → 文档 → 页面。标签按 Grist 页面顺序和缩进显示；同页的表格组件依次展示，只显示组件配置的可见列，表头使用 label。未放在任何页面上的表列在末尾「原始数据」分组。选择按登录用户存入 localStorage。
3. 支持 Text / Numeric / Int / Bool / Date / Choice 单元格保存和新增空行。日期按 UTC 日历日与 Unix 秒数转换。公式与复杂类型只读。附件显示文件名、大小和图片缩略图；图片/PDF 在新标签页打开，其他类型下载。点击行 ID 打开整行详情，编辑规则与表格一致；附件不提供上传和删除。
4. 设置页生成 MCP 令牌并立即复制命令，明文不再从服务器返回：

   ```sh
   claude mcp add --transport http grist https://<当前站点>/api/mcp --header "Authorization: Bearer <生成时的令牌>"
   ```

   重新生成使旧令牌失效；撤销、停用用户、管理员重置密码会使其失效。令牌拥有该用户保存的 Grist API Key 的读写权限，包括删除数据/结构，只应提供给可信 AI 客户端。

## 页面读取缓存

- `src/renderer/src/lib/backend.ts` 的 `useRpcData` 使用内存 stale-while-revalidate 缓存，key 为当前用户、方法名、规范化参数。再次进入页面同步读取旧数据，同时后台刷新；有缓存时不退回整页骨架屏，仅显示小型刷新提示。
- 同 key 的并发读取复用一个请求；`onConnect` 重连刷新，`onChanged` 连续推送按 200 ms 防抖。登出/身份切换清空缓存，旧身份尚未完成的请求不能写回。
- 写入仍直接 `call()`，写成功后刷新或使相关读缓存失效；设置页互不依赖的读取并行发出。用户管理沿用现有 REST 接口，共享相同读缓存机制，不新增用户管理 RPC。
- 团队站点、工作空间、文档列表和文档结构都缓存。文档选定后，首次读取最多两次 RPC：结构一次，当前页所有表格组件的数据一次。后者在服务器合并附件 ID，再一次 SQL 查询元数据，随同数据返回，不追加浏览器到服务器往返。附件文件的按需 GET 不计入数据 RPC。

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
| `grist.getDocStructure` | `{docId}`；`{pages,tables,rawTables}`，详见下方结构契约 |
| `grist.getPageRecords` | `{docId,tableIds,attachmentColumns?,limit?}`；`{tables:{[tableId]:{records,truncated}},attachments}`；最多 20 张表，默认/上限 1000 行，使用多 1 行探针；附件列映射为 `{[tableId]:colId[]}` |
| `grist.getAttachments` | `{docId,ids}`；按附件 ID 去重后一次参数化 SQL 返回 `{attachments}` |
| `grist.getTables` | `{docId}`；`{tables}` |
| `grist.getTableColumns` | `{docId, tableId}`；`{columns}` |
| `grist.listRecords` | `{docId, tableId, filter?, sort?, limit?}`；默认 1000，上限 1001，用多出的 1 行判断截断 |
| `grist.addRecords` | `{docId, tableId, records:[{fields}]}` |
| `grist.updateRecords` | `{docId, tableId, records:[{id, fields}]}` |

HTTP 层在 Cookie 会话鉴权后附加管理库 RPC（身份只能来自当前会话，不接受参数指定其他用户）：

- `grist.mcpToken.status` → `{createdAt, lastUsedAt}`，无令牌时为 null。
- `grist.mcpToken.generate` → `{token, createdAt}`，仅这一次返回明文。
- `grist.mcpToken.revoke` → `{ok:true}`。

## 文档结构契约

`grist.getDocStructure` 在服务器并行执行四条只读元数据 SQL：页面与视图名称、组件与表映射、表元数据、列与组件字段映射。

- `pages[]`：`id, viewRef, name, indentation, pagePos, sections[]`，按 `pagePos`、页面 ID 排序。
- `sections[]`：`id, parentKey, title, displayTitle, tableRef, tableId, columns[]`。`displayTitle` 在 title 为空时回退为 tableId；前端只渲染 `parentKey=record` 的组件。
- `columns[]`：`colRef, colId, label, type, isFormula, widgetOptions`；组件列额外有 `parentPos`，按组件字段的顺序排列，不加入被隐藏的列。
- `tables[]`：`tableRef, tableId, primaryViewId, rawViewSectionRef, columns[]`，包含每张表的全量列元数据。
- `rawTables[]`：未被任何实际页面组件引用的表；内部 raw section 和孤立 view 不算页面。
- 附件元数据：`id, fileName, fileSize, imageHeight, imageWidth, timeUploaded`。单元格值 `["L",12,13]` 表示附件 12 和 13；空/无效编码不当成附件 ID。
- 当前页记录读取限制服务器并发数为 2，并对所有组件数据与附件元数据设置合计 16 MiB JSON 上限；附件 ID 去重后最多 10000 个。超限返回错误并取消其他进行中的表读取，不静默丢列或截断附件 ID。

## 附件 HTTP 接口

| 接口 | 鉴权与用途 |
|---|---|
| `GET /api/grist/attachment?docId=…&id=…` | Cookie 会话认证，使用当前用户保存的 Grist 客户端 |
| `GET /api/grist/attachment/signed?…` | 不依赖 Cookie，验证 HMAC、有效期、用户状态及签发时的 MCP 令牌状态 |

- 下载按块转发并处理背压，不把文件整体读入内存；100 MiB 上限，同时校验声明长度和实际流字节，超时/断开会取消上游。继承 Grist 公网地址预检和禁止重定向规则。
- 返回上游 Content-Type、安全的 Content-Length（已知且适用时）、UTF-8 `filename*`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=86400` 和 `Vary: Cookie`，避免同一浏览器切换账号后复用另一会话的附件缓存。
- 只有 `image/png`、`image/jpeg`、`image/gif`、`image/webp`、`application/pdf` 允许 inline；其余类型（包括 HTML、SVG、XML、JS）一律 `attachment`，并设置 `Content-Security-Policy: sandbox`。不根据文件扩展名扩大服务端 inline 白名单。
- 签名密钥用服务器主密钥经 HKDF-SHA256、label `grist-attachment-url` 派生；签名绑定用户 ID、文档 ID、附件 ID、过期时间和当前 MCP 令牌版本。有效期 10 分钟，令牌重新生成/撤销、停用用户、强制改密均阻止新的签名下载请求。已收到或浏览器已缓存的文件无法追回。
- 下载链接 origin 使用当前请求 Host；只有 `TRUST_PROXY=1` 才信任 `X-Forwarded-Proto`，不信任 `X-Forwarded-Host`。

## MCP 工具（24 个）

工具参数及英文描述集中在 `src/backend/grist-tools.ts`，`tools/list` 可查看完整 zod 参数 schema。

- 发现：`grist_help`、`grist_get_user_profile`、`grist_list_orgs`、`grist_list_workspaces`、`grist_list_docs`、`grist_get_doc_info`。
- 读取：`grist_get_tables`、`grist_get_table_columns`、`grist_list_records`、`grist_query_document`、`grist_list_snapshots`、`grist_list_attachments`、`grist_get_pages`、`grist_get_attachment_url`。
- 写入：`grist_add_records`、`grist_update_records`、`grist_remove_records`。
- 结构：`grist_create_doc`、`grist_create_table`、`grist_add_table_column`、`grist_update_table_column`、`grist_rename_table`、`grist_remove_table`、`grist_remove_table_column`。

records、SQL、attachments 返回默认 100、最大 1000 条，并在输出再次截断；附件也向 REST 传递 limit。SQL 以外的写入每次最多 1000 条。工具错误为 MCP `isError`，不抛到 HTTP 主循环。

`grist_get_pages({docId})` 返回上面的文档结构，供外部 AI 将「页面 4」映射到真实表和列。`grist_get_attachment_url({docId,attachmentId})` 返回 10 分钟签名下载链接：先用 `grist_list_attachments` 或附件单元格中的 ID 定位文件，再取 URL 下载。`grist_help` 包含该流程及附件编码说明；不再把这两个读取工具列为 unsupported。

## 简化与验证边界

- 这是官方工具命名的 REST 子集，不是官方付费 MCP 的内部实现、完整兼容实现或 OAuth 连接器。
- SQL 只接收单条 SELECT（不支持 WITH、自然语言、多个语句）；调用 AI 自行编写 SQL。查询增加外层 LIMIT，并由 Grist REST 只读 SQL 端点执行。
- 提供页面/组件结构读取和附件签名下载，不提供页面/组件管理、附件上传/删除、访问规则参考或可用自定义组件目录。非 record 组件只返回元数据，不重现卡片/图表/自定义组件。支持列顺序/可见性，不复刻 Grist 的组件筛选、排序、链接选择和完整布局。
- UI 不提供删除行或结构编辑；只显示前 1000 行，使用 1001 行探针提示截断；没有分页/全量下载。
- 超过 16 MiB 的 JSON 响应会被拒绝，而非整包载入。大字段表可通过 MCP 减小 limit，或直接在 Grist 中查看。
- 文档链接 `<baseUrl>/o/<orgDomain>/<urlId>` 已由用户在沙箱外的真实实例验证可用；Grist 会自动以 302 重定向到带文档名的地址。无 org domain 时仍按实现走根文档路径。
- 用户已在沙箱外以真实 Grist 实例完成联调：22 个 MCP 工具、表格页单元格编辑和新增行均通过。本轮没有重复发起真实 Grist 请求。

## 历史：初始接入修改文件

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

初始接入没有修改 `mailbox-service.ts`、`mailbox-service.test.ts`、既有前端邮件文件或 `.env`。本轮缓存迁移涉及前端邮件页，见下方清单。

## 本地验证与回滚

- 旧版 Grist 接入曾完成 373/373 个本地测试和用户的真实实例联调；这不是本轮新增结构、附件、缓存的真实实例验证。本轮基线为 391/391；最终验证结果见下方本轮交付记录。
- 上一轮 Chrome CUA 本地假 RPC 界面检查覆盖空状态、设置提示/连接测试、一次性令牌/命令、层级切换、Text/Bool/Date 保存、新增行、复杂列只读与 1000 行截断；它与上面的真实实例联调是两组独立验证。
- 标准 `npm test` 在此沙箱受 Node 子进程 `spawn EPERM` 阻断；可用 `node --test --test-isolation=none "src/**/*.test.ts"` 跑同一套测试。在沙箱外仍应重跑原命令。
- 上一轮 native config loader 前端构建通过（存在既有 >500 kB chunk 警告）；沙箱内可用 `npm run build -- --configLoader native`，沙箱外可重跑标准构建。
- 回滚前停止使用该功能，只恢复对应修改前的文件，不做 `git reset/clean`，不碰其他人的改动。数据库新增表不要自动删除/降级。

## 本轮：页面提速、页面结构与附件（2026-10-16）

### 改动文件

- 缓存与首屏：`src/renderer/src/lib/backend.ts`、新增 `rpc-cache.ts` / `rpc-cache.test.ts` / `rpc-cache-regression.test.ts`；`src/renderer/src/App.tsx`；`pages/overview.tsx`、`new-batch.tsx`（可用域名/模板读取）、`batches.tsx`、`sites.tsx`、`accounts.tsx`、`mail.tsx`、`settings.tsx`、`grist-settings.tsx`、`users.tsx`、`tables.tsx`。
- 表格与附件 UI：新增 `src/renderer/src/pages/grist-attachments.tsx`；修改 `grist-table-helpers.ts` / `grist-table-helpers.test.ts`。抽屉先按组件顺序展示，再补齐该表其他字段；表格本身仍只显示组件可见列。
- 后端：新增 `src/backend/grist-structure.ts` / `grist-structure.test.ts`；修改 `grist-settings.ts`、`grist.ts` / `grist.test.ts`、`grist-tools.ts` / `grist-tools.test.ts`。
- HTTP / 签名：新增 `src/server/grist-attachment.ts` / `grist-attachment.test.ts`、`grist-attachment-signing.ts` / `grist-attachment-signing.test.ts`、`grist-attachment-http.test.ts`、`grist-attachment-origin.test.ts`、`grist-attachment-regression.test.ts`；修改 `http.ts`、`index.ts`、`grist-mcp.ts`、`grist-tokens.ts`、`grist-http.test.ts`。
- 文档：本文件。新增 3 个只读 RPC、2 个 GET 接口和 2 个只读 MCP 工具，名称与契约见上文。
- 未新增依赖、未修改 lockfile、未更改数据库结构、未 git commit。只在 `grist-ux` worktree 写入；未写入链接的 `node_modules` 或主仓库工作目录。

### 简化与待验证

- 缓存只驻留内存，不做跨刷新持久化；SWR 允许先显示旧值，失败时保留旧值和错误提示，不把缓存当成远端一致性证明。
- 同页表格组件按 section ID 稳定排列，不还原 Grist 的二维组件布局；列严格按组件字段的 parentPos 排序。只读结构仍包含非表格组件。
- 缩略图使用原附件下载流，而非服务器图片转码；可见性观察和 `loading="lazy"` 控制按需加载。文件名后缀只影响 UI 预览意图，能否 inline 最终由代理的 Content-Type 白名单决定。
- 未访问真实 Grist。页面名称/元数据权限、真实大附件、PDF 浏览器行为、反向代理配置和真实 MCP 客户端仍需联调。
- 已尝试启动用户测速脚本所用 Chromium，沙箱拒绝 `spawn EPERM`；**未验证 285 ms 延迟下第二次进入页面首帧 <50 ms，也未进行本轮浏览器截图验收**。请在沙箱外本地启动服务，用用户提供的 `perf.mjs <baseUrl> <user> <pass> 285` 复测。

### 回滚记录

修改前备份位于当前 worktree 的 `.grist-ux-backup/src` 和 `.grist-ux-backup/docs`，含 `HEAD.txt`、`status.txt`、`baseline-hashes.json` 与基线测试日志；最终变更与 SHA-256 清单写入同目录交付记录。回滚前先比对当前文件与最终 hash，存在后续编辑就停止并手工合并。仅恢复本轮修改的已有文件，移除本轮新增文件；不运行 `git reset/clean`，不删除数据目录或主密钥，不改主仓库。

### 本轮验证结果

- `npm run typecheck`：通过。
- `node --test --test-isolation=none "src/**/*.test.ts"`：**429/429 通过**，0 失败/跳过；覆盖缓存同步旧值、请求合并、失效排队、防抖、切换/退出清理、真实 SQLite 元数据 SQL、页面/隐藏列/原始表、多组件附件合并、Cookie 401/参数 400、安全响应头、流式限长/长度不符/首块转发/断连、签名过期/篡改/停用/撤销、Host/代理协议边界及聚合容量/并发/取消上限。
- 标准 `npm test` 已尝试，测试隔离创建子进程被沙箱以 `spawn EPERM` 拒绝；上面无隔离命令运行的是完整测试集，不是挑选的子集。
- `npm run build -- --configLoader native`：通过，保留既有大于 500 kB chunk 的构建警告；`git diff --check`：通过。
- 上述是本地类型/单元/假上游 HTTP/构建验证，不代表真实 Grist 或浏览器首帧性能已验收。

参考：[官方 MCP 工具目录](https://support.getgrist.com/mcp/)、[REST OpenAPI](https://raw.githubusercontent.com/gristlabs/grist-help/master/api/grist.yml)、[Grist 元数据 schema](https://raw.githubusercontent.com/gristlabs/grist-core/main/app/common/schema.ts)。
