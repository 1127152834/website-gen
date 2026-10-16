# Grist 集成

## 使用：原生 Grist iframe

1. 设置 →「Grist 表格」保存 Grist 公网地址。API Key、测试连接和 MCP 令牌仍在此处管理；Key 留空不会覆盖旧值，只显示末 4 位提示。
2. 侧栏「表格」（`/tables`）直接嵌入当前用户 `grist.settings.get` 返回的 `baseUrl`。没有地址时显示配置引导；iframe 只需要地址，不要求 API Key 已配置。文档、页面、组件、单元格编辑、新增行和附件交互均由原生 Grist 提供，不再自绘或通过本应用的表格数据 RPC 代理。
3. 顶部提供「登录 Grist」「刷新」「在新标签页打开」。iframe 占满内容区剩余高度，允许 `clipboard-read; clipboard-write`，使用 `strict-origin-when-cross-origin` referrer policy，不加 sandbox。
4. iframe 使用浏览器的 Grist 会话，**不会把保存的 API Key 或 MCP 令牌放进 URL、iframe 或登录弹窗**。API Key 仍只供服务器上的全局助手、MCP 和连接测试使用。

### 弹窗登录

如果下面显示拒绝连接或登录页，先点「登录 Grist」在弹窗里登录，登录后关闭弹窗即可。关闭后页面自动重新加载 iframe；「刷新」也可手动重新加载。

- 登录入口是 `<baseUrl>/login?next=%2F`。已核对 [grist-core 的 `/login` 与 `getSigninUrl`](https://github.com/gristlabs/grist-core/blob/main/app/server/lib/FlexServer.ts)：`/login` 明确选择登录而非注册；`next` 经 [getOrgUrl](https://github.com/gristlabs/grist-core/blob/main/app/server/lib/requestUtils.ts) 作为本站路径处理，再传给身份提供方作为登录后的返回地址。`next=/` 回到 Grist 首页，不应传入本应用 URL 或绝对 Grist URL。
- 登录在顶层弹窗完成；弹窗被拦截时尝试普通新标签页。若浏览器也拦截新标签页，可允许弹窗或通过「在新标签页打开」进入 Grist 登录，返回后点「刷新」。
- 弹窗只轮询 `popup.closed`，不读取跨源页面内容；关闭只代表刷新时机，**不是登录成功证明**。若新标签页没有可用窗口句柄，请返回后手动刷新。
- 用户已实测部署：`https://tool.aoeen.com` 与 `https://wg.aoeen.com` 是同一个 site；Grist 的 `grist_core` Cookie 为 `SameSite=Lax; Secure`，在这组同 site 的 HTTPS iframe 中可携带。此前浏览器登录过 Grist，即可复用该会话。这不保证任意跨 site 的 Grist 地址都能复用 Cookie。
- 用户已实测当前 Grist 页面没有 X-Frame-Options / CSP 嵌入限制，但 Keycloak 登录页带 `frame-ancestors 'self'` 和 `X-Frame-Options: SAMEORIGIN`，不能直接在应用 iframe 内显示。因此默认使用弹窗登录；本轮不修改 Grist 或 Keycloak 服务配置。

如确实需要在 iframe 中直接登录，应由管理员在 **Keycloak 管理台 → Realm settings → Security defenses → Headers** 调整浏览器安全响应头：

- CSP 的 `frame-ancestors` 允许 `'self' https://tool.aoeen.com`，保留其他必要策略；反向代理若另加 CSP，也需同时核对。
- X-Frame-Options 不能继续保留阻止跨 origin 的 `SAMEORIGIN` / `DENY`；通过上述 CSP 精确限定可信父页面。不要使用已过时的 `ALLOW-FROM`，也不要无范围放开所有网站。
- 这会放宽该 Realm 的防点击劫持边界，应只允许可信应用并自行验证完整登录跳转链。弹窗方案不需要这种放宽。

### 本机开发、网络与白名单

- `http://127.0.0.1` 与 `https://wg.aoeen.com` 跨 site，iframe 不会携带该 Lax Cookie。即使顶层弹窗已登录，iframe 仍可能显示未登录或拒绝连接，属于预期限制；请在同 site HTTPS 部署上验证会话复用，本机可用新标签页访问 Grist。
- iframe、登录弹窗和新标签页由**用户浏览器直接请求 Grist / Keycloak**。Grist/前置防火墙的 IP 白名单对浏览器出口 IP 同样生效；仅允许应用服务器 IP 不够。服务器上的出站代理不会代理 iframe 请求。
- 本应用 CSP 放行 `frame-src 'self' https:`，以支持每用户配置的不同 HTTPS Grist 地址；自己的 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 不变。保存的 HTTP 地址仍可供服务器 API 使用，但跨源 HTTP iframe 不在此 CSP 放行范围内，HTTPS 页面也有混合内容限制；嵌入请配置 HTTPS。

## 设置与 MCP 接入

设置页生成 MCP 令牌并立即复制命令，明文只返回这一次：

```sh
claude mcp add --transport http grist https://<当前站点>/api/mcp --header "Authorization: Bearer <生成时的令牌>"
```

重新生成使旧令牌失效；撤销、停用用户、管理员重置密码会使其失效。令牌拥有该用户保存的 Grist API Key 的读写权限，包括删除数据/结构，只应提供给可信 AI 客户端。浏览器 iframe 会话与这些令牌是两套独立认证。

## 保留的 RPC（全部 `grist.` 前缀）

工作区 handlers 只保留以下三项：

| RPC | 参数与结果 |
|---|---|
| `grist.settings.get` | 无；`{baseUrl, apiKeyHint, configured}` |
| `grist.settings.save` | `{baseUrl, apiKey?}`；返回安全设置摘要 |
| `grist.testConnection` | `{baseUrl?, apiKey?}`；测试输入但不保存，返回 active-session profile |

HTTP 层在 Cookie 会话鉴权后附加管理库 RPC（身份只能来自当前会话，不能指定其他用户）：

- `grist.mcpToken.status` → `{createdAt, lastUsedAt}`；没有令牌时对应时间为 null。
- `grist.mcpToken.generate` → `{token, createdAt}`，仅这一次返回明文。
- `grist.mcpToken.revoke` → `{ok:true}`。

已删除仅供自绘表格的 RPC：`grist.listOrgs`、`grist.listWorkspaces`、`grist.listDocs`、`grist.getDocInfo`、`grist.getTables`、`grist.getTableColumns`、`grist.getDocStructure`、`grist.getAttachments`、`grist.getPageRecords`、`grist.listRecords`、`grist.addRecords`、`grist.updateRecords`。助手登记表也删除这些已不存在的 RPC 条目；助手和 MCP 仍通过下列共用工具直接调用客户端，不依赖这些包装。

## MCP 与全局助手工具（24 个，保持不变）

工具参数与描述集中在 `src/backend/grist-tools.ts`，`tools/list` 可查看完整 zod 参数 schema；同一份定义供全局助手和 `/api/mcp` 使用。

- 发现：`grist_help`、`grist_get_user_profile`、`grist_list_orgs`、`grist_list_workspaces`、`grist_list_docs`、`grist_get_doc_info`。
- 读取：`grist_get_tables`、`grist_get_table_columns`、`grist_list_records`、`grist_query_document`、`grist_list_snapshots`、`grist_list_attachments`、`grist_get_pages`、`grist_get_attachment_url`。
- 写入：`grist_add_records`、`grist_update_records`、`grist_remove_records`。
- 结构：`grist_create_doc`、`grist_create_table`、`grist_add_table_column`、`grist_update_table_column`、`grist_rename_table`、`grist_remove_table`、`grist_remove_table_column`。

records、SQL、attachments 返回默认 100、最大 1000 条，并在输出再次截断；附件也向 REST 传递 limit。SQL 以外的写入每次最多 1000 条。工具错误为 MCP `isError`，不抛到 HTTP 主循环。删除和改列等破坏性工具必须先由用户确认。

这是官方工具命名的 REST 子集，不是官方付费 MCP 的内部实现、完整兼容实现或 OAuth 连接器。SQL 只接受单条只读 SELECT（不支持 WITH、自然语言、多个语句），由服务端包裹 LIMIT。连接器不提供页面/组件修改、附件上传/删除、访问规则参考或自定义组件目录；iframe 内原生 Grist 的能力和权限由 Grist 自身决定，不受此连接器子集限制。

### 保留的文档结构契约

`grist_get_pages({docId})` 通过 `src/backend/grist-structure.ts` 的 `getGristDocStructure` 并行读取四组只读元数据：页面与视图名称、组件与表映射、表元数据、列与组件字段映射。虽然同名用途的 UI RPC 已删除，该 MCP/助手共用实现及测试继续保留。

- `pages[]`：`id, viewRef, name, indentation, pagePos, sections[]`，按 `pagePos`、页面 ID 排序。
- `sections[]`：`id, parentKey, title, displayTitle, tableRef, tableId, columns[]`，包括非 record 组件元数据。
- `columns[]`：`colRef, colId, label, type, isFormula, widgetOptions`；组件列另有 `parentPos`，按组件可见列顺序排列。
- `tables[]`：`tableRef, tableId, primaryViewId, rawViewSectionRef, columns[]`，包含每张表的全量列元数据。
- `rawTables[]`：未被任何实际页面组件引用的表；内部 raw section 和孤立 view 不算页面。

旧 UI 的跨组件记录/附件聚合、1001 行探针以及对应前端编辑/预览 helper 已删除；MCP 的记录限制和原生 Grist 页面不受此清理影响。

## 附件 HTTP 接口（保留）

| 接口 | 鉴权与用途 |
|---|---|
| `GET /api/grist/attachment?docId=…&id=…` | Cookie 会话认证；全局助手 `grist_get_attachment_url` 返回的站内下载地址，**不是仅供已删除的附件 UI 使用** |
| `GET /api/grist/attachment/signed?…` | MCP 生成的十分钟签名链接，不依赖 Cookie；验证 HMAC、有效期、用户状态与签发时的 MCP 令牌状态 |

- 下载按块转发并处理背压，不整体读入内存；100 MiB 上限，同时校验声明长度与实际流字节，超时/断开取消上游。继承 Grist 公网地址预检和禁止重定向规则。
- 返回上游 Content-Type、安全的 Content-Length（已知且适用时）、UTF-8 `filename*`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, max-age=86400`、`Vary: Cookie`。
- 只有 PNG、JPEG、GIF、WebP、PDF 允许 inline；其他类型（含 HTML、SVG、XML、JS）一律 attachment，并加 `Content-Security-Policy: sandbox`。不按扩展名扩大服务端白名单。
- 签名密钥由服务器主密钥经 HKDF-SHA256、label `grist-attachment-url` 派生；签名绑定用户 ID、文档 ID、附件 ID、过期时间和当前 MCP 令牌版本。令牌轮换/撤销、停用用户、强制改密阻止新的签名下载；已收到或缓存的文件无法追回。
- 下载链接 origin 使用当前请求 Host；仅 `TRUST_PROXY=1` 时信任 `X-Forwarded-Proto`，不信任 `X-Forwarded-Host`。

## 服务器数据与安全（与浏览器会话区分）

- 用户库迁移 012 添加 `workspace_settings`，地址为 `grist.baseUrl`；Key 通过 `setSecret/getSecret` 存为 `grist.apiKey`，只返回末 4 位 hint。
- `admin.sqlite` 的 `grist_mcp_tokens` 一用户一令牌，只存 SHA-256 摘要、用户 ID、创建及最近使用时间；令牌为 32 随机字节的 base64url 编码。
- `/api/mcp` 在 Cookie/CSRF 路由前独立处理，仅接受 Bearer。每个 HTTP 请求、每次数据工具调用重新核对用户和令牌状态。每请求新建 SDK server / Streamable HTTP transport，无会话 ID，JSON 响应；POST only、1 MiB 请求上限、响应 no-store，无效令牌 401。
- REST 每请求做公网地址预检，拒绝回环/私网/链路本地（含 IPv4 映射 IPv6），不使用 `ALLOW_PRIVATE_MODEL_HOSTS` 放行，不跟随重定向，超时 30 秒。
- REST 在 JSON 解析前流式限制成功响应 16 MiB、错误响应 64 KiB，同时校验 Content-Length 与实际字节；超限取消 reader 并中止请求。MCP 可减小 limit。
- 地址防护使用 DNS 预检，**不是连接 IP 钉扎，不能声称完全防御 DNS rebinding / DNS 校验与连接间的竞态**；公网部署宜再加出站网络策略。这些服务器 API 防护不是浏览器 iframe 的网络策略。
- 已开始的远端操作不能通过撤销令牌回滚；撤销只阻止新的请求/工具调用。

## 服务器经代理访问 Grist

以下只影响服务器上的 REST/MCP/助手和连接测试，不影响 iframe、登录弹窗或新标签页。Node 24 的 fetch 需要启用环境代理后才会使用 HTTPS_PROXY，并遵守 NO_PROXY。参见 [Node.js 24 内置代理说明](https://nodejs.org/docs/latest-v24.x/api/http.html#built-in-proxy-support)。

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890" # 替换为实际受信代理
$env:NO_PROXY = "localhost,127.0.0.1"
npm start
```

```bash
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 NO_PROXY=localhost,127.0.0.1 npm start
```

Docker 可通过 Compose override 为 app 服务设置相同变量。代理地址须能从容器内访问；容器的 127.0.0.1 不是宿主机。完整写法见 [部署文档](deploy.md#出站代理grist-等外部服务)。服务器出站 IP 和浏览器出口 IP 应分别满足 Grist 的白名单。

## 本轮验证与回滚

- 本轮仅修改 `grist-iframe` worktree，未提交、不改 `.env`，没有访问或写入真实 Grist / Keycloak。
- 本地检查：`npm run typecheck`、`npm test`；若沙箱创建测试子进程报 `spawn EPERM`，使用 `node --test --test-isolation=none "src/**/*.test.ts"` 跑完整同进程回归，在沙箱外仍需重跑标准命令。构建使用 `npm run build -- --configLoader native`。
- 本轮实际结果：类型检查通过；完整同进程测试 **569/569** 通过（0 失败/跳过）；native config loader 构建通过，只有既有大于 500 kB 的 chunk 警告。标准 `npm test` 和 Playwright Chrome 启动均被沙箱 `spawn EPERM` 阻断。CSP、已删除 RPC 与登记表的回归在旧 HEAD 上准确失败，在当前代码上通过；页面源码契约检查不等同于真实浏览器布局验收。
- popup helper 的测试和本地假 RPC/上游测试不等于真实 Grist/Keycloak 登录、Cookie、剪贴板或生产 iframe 验收。用户提供的既有部署实测与本轮代码验证分开记录。
- 修改前的干净 HEAD 归档位于 `.omx/grist-iframe-backup/baseline.zip`，基线为 `c060f2eab5d0b48c73e25331c24353f07967435a`；校验/交付记录保存在同目录。回滚前核对最终文件 hash，只恢复本轮文件，存在后续编辑则停止手工合并；不运行 git reset/clean，不回退数据库或删除密钥。

参考：[官方 MCP 工具目录](https://support.getgrist.com/mcp/)、[REST OpenAPI](https://raw.githubusercontent.com/gristlabs/grist-help/master/api/grist.yml)、[Grist 元数据 schema](https://raw.githubusercontent.com/gristlabs/grist-core/main/app/common/schema.ts)。
