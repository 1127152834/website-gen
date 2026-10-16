# 全局 pi 小助手

## 架构与隔离

- 每个用户工作区只有一个全局助手对象（`assistant.ts`），与每站点对话分开。会话持久化到 `data/users/<id>/pi/assistant/sessions`；新对话保留旧 JSONL，重启继续最近会话。
- `agent-session.ts` 共用建会话、空资源加载器、事件转换与 `toChatItems`。pi 版本为 1.2.0；`noTools: "builtin"` 加显式 `tools` 白名单，不加载磁盘扩展、技能、上下文、提示模板或用户 MCP 配置；不修改 `~/.pi`。Key 只通过本用户内存 credential store 使用。
- 模型沿用设置页“建站与对话”（agent）用途；无可用模型时返回中文设置引导。已打开会话的模型配置在新对话/重新打开会话时生效。
- HTTP 会话鉴权、CSRF、workspaceManager 和 SSE 隔离保持不变；新增 `Push {kind:"assistant",event}`。前端每次发送附上当前 pathname，消息上下文记录页面，显示历史时隐藏技术前缀。
- `assistant-tools.ts` 显式登记 RPC 的真实参数 schema、中文用途和风险。注册仅绑定本用户 guarded handlers，不做自动接口发现。覆盖测试遍历全部工作区 handlers，新增未分类接口即失败。
- `grist-tools.ts` 是 22 个 Grist 工具唯一的定义来源：MCP 用同一 Zod schema 注册；内嵌助手用该 schema 转换出的 TypeBox JSON schema，并仍由原 Zod schema 校验执行。转换时只复制 JSON Schema 自有字段，不把 Zod `~standard` 元数据送入模型。所有调用懒读取该用户设置页配置；未配置时返回中文提示，不崩溃。
- `read_user_manual` 只读仓库固定路径 `docs/user-manual.md`，不接受文件路径；可按标题/关键词查章节，空查询返回目录。手册旧桌面版的安装/托盘/密钥位置等描述明确标为历史参考，当前接口与 web 多用户架构优先。Docker 使用 `COPY . .`，ignore 未排除 docs；测试锁定手册打包条件。

### RPC 与推送

| 方法 | 参数 / 返回 |
| --- | --- |
| `assistant.history` | 无参数；返回 `{items,busy,pending}` |
| `assistant.send` | `{text,page?}`；异步开始回复，流式结果经 SSE 推送 |
| `assistant.abort` | 停止当前回复，取消全部待确认动作 |
| `assistant.reset` | 停止旧会话、取消确认，创建新会话，保留旧文件 |
| `assistant.confirm` | `{id,approve:boolean}`；只处理当前用户当前待确认 ID；返回 `{ok}` |

事件包括 text / thinking / tool_start / tool_end / error / settled，以及 confirm（id、工具名、中文说明、净化参数、expiresAt）和 confirm_resolved。断线按既有 SSE 游标恢复，重连后读取历史和挂起确认。

## 风险与确认

- read：业务查询，不强制记工具审计。本用户邮件查询沿用自动更新缓存的行为；跨用户查询则强制 SQLite 只读连接和邮件 cache-only 路径，绝不更新目标缓存或同步状态。
- write：普通修改直接执行并记审计。
- confirm：删除/移除、资源占用/可能收费、发信、放弃、上线、重置密码，以及 Grist 删除与改列。描述和关键参数在对话卡片呈现，模型不能调用确认 RPC 自行批准。
- 确认窗口默认 10 分钟；取消、超时、停止、新对话、工作区关闭均不执行并返回“用户未确认，没有执行”。审批时再次检查真实 expiresAt；重复或过期 ID 不生效。
- 会话代际与生命周期屏障阻止旧会话发出工具动作/流事件，旧会话退出后才能重开。停止不能撤回已经提交给外部服务的请求。
- `assistant_tool_audit` 由用户 SQLite 迁移追加，记录时间、工具、净化参数、risk、confirmed、success 和净化错误。非 read 动作在执行前先写 pending 行（success=0,error="pending"），预写失败就不执行；动作结束后更新成功/失败状态。若动作已经成功但审计状态更新失败，保留真实成功结果并附 auditWarning 明确提示“请勿重复执行”，不把已发信/删除伪报为可重试失败。pending 只表示结果尚未完成记录，不代表可以安全重试。失败、用户取消也记录。此表是调用审计，不是所有远端写入的可逆快照。
- RPC 工具成功结果进入模型前深度清理 password / token / apiKey / secret / ciphertext / credential / authorization 等字段；共用 Grist 工具的成功结果按原结构传递，避免误删业务列。两条路径的错误文本、确认参数及审计参数始终净化。仅 Hint 提示类字段可保留字符串，状态标志只保留布尔/数字；RPC JSON 字符串也递归净化，二进制不进模型。会收/返明文密钥的接口直接排除，而非依赖清理兜底；Grist 单元格中的自由文本仍是数据而非指令，请勿把真实密钥存入或粘贴到模型可见内容。

## 管理员跨用户规则

- backend 助手不访问管理库/服务器；`http.ts` 在打开工作区时通过 `setAssistantAdminCapability` 注入 server 层 `assistant-access.ts` 的窄能力。普通用户会话不注册任何 admin 工具；直接调用服务端能力也被拒绝。
- `admin_list_users` 只返回 ID 和用户名。`admin_query_user_data` 对指定 userId 或全部用户执行登记表 risk=read 的 RPC 或共用 Grist 只读工具；method 参数使用 RPC 原方法名（如 sites.all）或 Grist 工具名（如 grist_query_document），schema 明确列出允许方法。结果为 `[{userId,username,result|error}]`；RPC 成功结果继续净化，共用 Grist 成功结果保留原结构，所有错误文本仍净化。
- 每次调用、每个用户读取前、异步读取后及最终返回前均重查管理员仍启用且 role=admin；被降权/停用的旧能力即时失效。
- 不接受跨用户写入或 confirm；管理员自己的普通业务工具仍只绑定自己的 handlers，不能借 userId 参数越权（schema 拒绝多余参数）。各页面仍只显示当前用户业务数据，没有全局数据开关。
- 所有目标（包括在线和停用用户）通过 `WorkspaceManager.withReadOnly` 使用独立 `DatabaseSync({readOnly:true})` 连接、finally 关闭，不复用其可写工作区。不创建目录/数据库、不迁移、不记目标运行日志、不进入活动工作区列表、不启动同步、监听、任务恢复或定时回滚，只允许登记 read handlers。跨用户邮件仅返回已缓存内容/文件夹；缓存未命中会明确提示，而不是代替该用户同步。目标数据库不存在或旧 schema 不支持时返回该用户的查询错误，不为了查询写库。

## 全部 RPC 工具登记表（55 个）

参数的唯一执行依据是 `src/backend/assistant-tools.ts` 中逐方法显式 schema；它们与 handler 参数逐项核对，禁止未声明字段。

| RPC | 工具名 | 风险 | 中文用途 |
| --- | --- | --- | --- |
| `overview.get` | `system_overview` | read | 查看当前用户的运营总览、待办和站点统计。 |
| `templates.list` | `entity_templates_list` | read | 列出当前用户保存的经营主体模板。 |
| `templates.save` | `entity_template_save` | write | 新增或更新经营主体模板。 |
| `templates.remove` | `entity_template_remove` | confirm | 删除一个经营主体模板。 |
| `sites.all` | `sites_all` | read | 查看当前用户全部站点及其完整状态。 |
| `sites.get` | `site_get` | read | 按站点编号查看站点详情。 |
| `sites.history` | `sites_history` | read | 查看已经放弃的站点历史。 |
| `system.info` | `system_info` | read | 查看 Node、SQLite 和工作区数据库版本。 |
| `accounts.list` | `hostinger_accounts_list` | read | 列出当前用户的 Hostinger 账号摘要，不返回 Token。 |
| `accounts.domains` | `hostinger_account_domains` | read | 查看一个 Hostinger 账号下已同步的域名。 |
| `accounts.sync` | `hostinger_account_sync` | write | 立即同步一个 Hostinger 账号的资源快照。 |
| `accounts.remove` | `hostinger_account_remove` | confirm | 从系统移除一个 Hostinger 账号连接及其本地关联。 |
| `models.presets` | `model_presets` | read | 查看可用的模型厂商预设。 |
| `models.providers` | `model_providers` | read | 查看已配置的模型厂商和模型摘要，不返回 API Key。 |
| `models.roles` | `model_roles` | read | 查看建站、对话、截图和复核等用途当前绑定的模型。 |
| `models.delete` | `model_provider_delete` | confirm | 删除一个模型厂商配置。 |
| `models.fetch` | `model_provider_fetch_models` | read | 从已配置厂商刷新可用模型列表。 |
| `models.setRole` | `model_role_set` | write | 修改一个系统用途所使用的模型和思考强度。 |
| `models.test` | `model_test` | confirm | 向已配置模型发送极短测试请求；可能产生少量模型调用费用。 |
| `domains.free` | `domains_free` | read | 查看可用于新建站点的空闲域名。 |
| `batches.list` | `batches_list` | read | 列出建站批次。 |
| `batches.sites` | `batch_sites` | read | 查看一个批次内尚未放弃的站点。 |
| `batches.create` | `batch_create` | confirm | 创建建站批次并启动资源占用和自动建站任务。 |
| `sites.steps` | `site_steps` | read | 查看一个站点的流水线步骤。 |
| `sites.events` | `site_events` | read | 查看一个站点的运行事件。 |
| `sites.qa` | `site_qa_report` | read | 查看一个站点的 QA 报告和本地截图数据。 |
| `qa.runs` | `site_qa_runs` | read | 查看一个站点的复核与修复任务记录。 |
| `qa.recheck` | `site_qa_recheck` | confirm | 对一个站点重新整站复核；会调用模型，产生费用。 |
| `qa.fixIssue` | `site_qa_fix_issue` | confirm | 按复核报告自动修复单个问题，会直接修改线上站点内容。 |
| `qa.fixAll` | `site_qa_fix_all` | confirm | 按复核报告自动修复全部问题，会直接修改线上站点内容。 |
| `sites.list` | `sites_ready_list` | read | 列出已经建完且未放弃的站点。 |
| `sites.launch` | `site_launch` | confirm | 把一个站点正式上线。 |
| `sites.retry` | `site_retry` | confirm | 重新排队失败的建站任务，可能继续占用 Hostinger 或外部资源。 |
| `cj.status` | `cj_status` | read | 查看 CJ API Key 是否已配置及其安全提示。 |
| `mail.status` | `site_mail_status` | read | 检查站点客服邮箱和邮件 DNS 状态。 |
| `mail.fix` | `site_mail_fix` | confirm | 创建或修复站点客服邮箱、DNS 和交易邮件配置。 |
| `mail.defaultPassword.status` | `mail_default_password_status` | read | 查看默认邮箱密码是否已在设置页配置。 |
| `mail.list` | `mailboxes_list` | read | 列出邮箱摘要和未读状态，不返回密码。 |
| `mail.sync` | `mailboxes_sync` | write | 同步邮箱清单和邮件缓存。 |
| `mail.folders` | `mail_folders` | read | 列出一个邮箱的文件夹。 |
| `mail.messages` | `mail_messages` | read | 分页查询邮箱中的邮件摘要。 |
| `mail.message` | `mail_message` | read | 读取一封邮件的正文与附件元数据。 |
| `mail.credential.retryDefault` | `mail_credential_retry_default` | write | 用设置页保存的默认邮箱密码重新尝试登录一个邮箱，不返回密码。 |
| `mail.credential.reset` | `mail_credential_reset` | confirm | 重置一个邮箱的密码并保存新凭据。 |
| `mail.monitor` | `mail_monitor_set` | write | 开启或关闭一个邮箱的新邮件监听。 |
| `mail.seen` | `mail_seen_set` | write | 标记一封邮件为已读或未读。 |
| `mail.trash` | `mail_message_trash` | confirm | 把一封邮件移入垃圾箱。 |
| `mail.delete` | `mailbox_delete` | confirm | 永久删除一个远端邮箱及本地记录。 |
| `mail.send` | `mail_send` | confirm | 通过一个已配置邮箱发送邮件。 |
| `smtp.status` | `smtp_status` | read | 查看一个站点的交易邮件发信状态。 |
| `smtp.resetPassword` | `smtp_reset_password` | confirm | 重置站点邮箱密码并启用交易邮件发信。 |
| `smtp.test` | `smtp_test` | confirm | 向指定地址发送一封交易邮件测试。 |
| `smtp.disable` | `smtp_disable` | write | 关闭一个站点的交易邮件发信。 |
| `changes.list` | `site_changes_list` | read | 查看站点内容变更和定时恢复状态。 |
| `changes.revert` | `site_change_revert` | confirm | 立即回滚一条站点内容变更。 |
| `changes.cancelSchedule` | `site_change_cancel_schedule` | write | 取消一条变更已安排的定时恢复。 |
| `abandon.start` | `site_abandon_start` | confirm | 启动不可逆的站点放弃流程，删除远端邮箱和网站并关闭域名续费。 |
| `abandon.status` | `site_abandon_status` | read | 按任务、域名、站点或账号查看放弃任务状态。 |
| `abandon.retry` | `site_abandon_retry` | confirm | 重试失败的站点放弃任务并继续远端删除。 |
| `grist.settings.get` | `grist_settings_status` | read | 查看当前用户的 Grist 地址、配置状态和 Key 提示，不返回 Key。 |

## 共用 Grist 工具（22 个）

助手强制执行本页 confirm 规则；外部 MCP 客户端维持既有 MCP 语义，提供 readOnlyHint / destructiveHint，是否交互确认由外部客户端负责，不冒充远端授权结果。

| 工具名 | 助手风险 | 中文用途 |
| --- | --- | --- |
| `grist_help` | read | 说明 Grist 工具的发现顺序、行数限制、SQL 查询、单元格编码和未支持能力。 |
| `grist_get_user_profile` | read | 查看当前 Grist 会话的用户名、邮箱和可用组织上下文。 |
| `grist_list_orgs` | read | 列出当前 Grist API Key 可见的团队站点（组织）及其 ID、名称和域名。 |
| `grist_list_workspaces` | read | 列出指定 Grist 团队站点中的工作空间和访问摘要。 |
| `grist_list_docs` | read | 列出指定 Grist 工作空间中的文档 ID、名称和元数据。 |
| `grist_get_doc_info` | read | 查看指定 Grist 文档的元数据、工作空间和访问摘要，不读取表格行。 |
| `grist_get_tables` | read | 列出指定 Grist 文档中的表和表 ID。 |
| `grist_get_table_columns` | read | 列出指定 Grist 表的列 ID、类型、标签、公式和控件选项；写入前应先调用。 |
| `grist_list_records` | read | 读取一个 Grist 表的记录；支持按列过滤、排序，默认 100 行，最多 1000 行。 |
| `grist_query_document` | read | 对指定 Grist 文档执行一条只读 SQL SELECT；调用方必须提供 SQL，默认 100 行，最多 1000 行。 |
| `grist_list_snapshots` | read | 列出指定 Grist 文档的快照或备份元数据，不执行恢复。 |
| `grist_list_attachments` | read | 列出指定 Grist 文档的附件文件名、类型和大小，不返回内容或下载地址。 |
| `grist_add_records` | write | 向指定 Grist 表追加 1–1000 条记录；不能写公式列。 |
| `grist_update_records` | write | 按数字行 ID 更新指定 Grist 表中的 1–1000 条记录；未给出的列保持不变。 |
| `grist_remove_records` | confirm | 永久删除指定 Grist 表中的 1–1000 行；这是破坏性操作。 |
| `grist_create_doc` | write | 在指定 Grist 工作空间中新建文档。 |
| `grist_create_table` | write | 在指定 Grist 文档中新建表，可同时提供列定义。 |
| `grist_add_table_column` | write | 向指定 Grist 表新增一列，可设置类型、标签、公式和控件选项。 |
| `grist_update_table_column` | confirm | 更新指定 Grist 列的类型、标签、公式或控件选项；改类型或公式可能改变数据。 |
| `grist_rename_table` | write | 使用 Grist RenameTable 操作重命名指定表。 |
| `grist_remove_table` | confirm | 永久删除指定 Grist 表及其中全部记录；这是破坏性操作。 |
| `grist_remove_table_column` | confirm | 永久删除指定 Grist 列及其数据；这是破坏性操作。 |

另有 read 级 `read_user_manual`，以及仅管理员可见的 `admin_list_users` / `admin_query_user_data`。

## 不暴露的接口与原因

下表含工作区内部 RPC 及 HTTP 层 MCP 令牌管理 RPC；没有任何通配符自动豁免。

| 接口 | 原因 |
| --- | --- |
| `events.since` | SSE 推送内部接口，不是业务工具。 |
| `accounts.add` | 参数包含 Hostinger Token，只能在设置页面输入，凭据不得经过模型。 |
| `models.create` | 参数可包含模型 API Key，只能在设置页面配置密钥。 |
| `models.update` | 参数可包含模型 API Key，只能在设置页面配置密钥。 |
| `models.setKey` | 参数包含模型 API Key，只能在设置页面输入。 |
| `cj.setKey` | 参数包含 CJ API Key，只能在设置页面输入。 |
| `chat.history` | 站点对话内部接口；全局助手不能递归调用另一个对话。 |
| `chat.send` | 站点对话内部接口；全局助手不能递归发起模型对话。 |
| `chat.abort` | 站点对话内部控制接口。 |
| `chat.reset` | 站点对话内部控制接口。 |
| `mail.defaultPassword.set` | 参数包含默认邮箱密码，只能在设置页面输入。 |
| `mail.password` | 返回邮箱明文密码，绝不暴露给模型。 |
| `mail.credential.save` | 参数包含邮箱密码，只能在邮箱页面输入。 |
| `smtp.enable` | 参数可包含邮箱密码，只能在站点页面输入凭据。 |
| `grist.settings.save` | 参数可包含 Grist API Key，只能在设置页面输入。 |
| `grist.testConnection` | 参数可包含 Grist API Key，只能在设置页面测试。 |
| `grist.mcpToken.status` | MCP 令牌页面内部接口；助手不需要读取令牌状态。 |
| `grist.mcpToken.generate` | 返回一次性的明文 MCP Token，只能由用户在设置页面生成并立即复制。 |
| `grist.mcpToken.revoke` | MCP 令牌撤销只能由用户在设置页面明确操作。 |
| `assistant.history` | 全局助手对话内部接口，不能递归调用自身。 |
| `assistant.send` | 全局助手对话内部接口，不能递归调用自身。 |
| `assistant.abort` | 全局助手内部停止接口。 |
| `assistant.reset` | 全局助手内部新对话接口。 |
| `assistant.confirm` | 全局助手高风险确认回传接口，不能由模型自行确认。 |

HTTP 登录、改密码、用户管理和附件下载不是 workspace RPC；只保留原页面专用入口，模型不接触登录密码或管理令牌。

## 前端与简化

- 所有完成登录/首次改密的页面共用右下角 SVG 团子。待机浮动/眨眼、悬停挥手、忙碌轨道点、完成跳跃、收起新回复红点；prefers-reduced-motion 关闭动效。深浅色沿用主题变量，手机是底部全宽面板。
- 面板支持流式文本、中文折叠工具状态、确认/取消、停止、新对话、示例、设置引导、Esc 收起、输入框及按钮无障碍标签。站点对话与全局助手复用 `ChatMessage / LiveChatMessage / ToolLine`，不渲染原始 HTML。
- 一次只显示当前对话，旧会话保留磁盘但不做会话选择列表；确认只驻留内存，服务重启不会执行旧确认，重连可恢复当前进程中的待确认。
- 不新增依赖，不修改各业务页面的数据可见范围，不将全部系统接口无条件开放；不新增任意文件/命令/SQL 执行入口。Grist SQL 仍是受限单条 SELECT（默认100、最大1000行）；保持既有 MCP 能力边界。
- “先查后改”由系统提示要求，风险确认由服务器强制；普通 write 不新增自动回滚机制，原有站点变更快照机制保持不变。高风险动作应先检查结果/备份，确认后不保证所有外部服务都能撤销。

## 验证、交付与回滚

### 第 1 轮审查修正

- 修复经营主体天数范围的元组 schema；新测试取真实工作区 RPC、共用 Grist、手册及管理员工具登记结果，检查 pi 的 OpenAI Completions / Anthropic Messages 适配器最终序列化 payload，递归禁止元组关键字与非 JSON Schema 字段。
- 共用 Grist 结果（含管理员跨用户读取）保留全部业务列和单元格；错误中的系统 Grist Key 仍隐藏，RPC 结果维持原清理。去除 9 个重复 Grist RPC 工具，保留配置状态查询。示例问题点击直接发送。
- `npm run typecheck` 通过；`node --test --test-isolation=none "src/**/*.test.ts"` **427/427 通过**，无跳过；`npm run build -- --configLoader native` 通过。标准 test/build 仍受上述沙箱限制，真实 DeepSeek 待沙箱外复测。
- 本轮基线与备份：`.omx/assistant-round1-backup/`；文件哈希及回滚记录：`.omx/assistant-round1-evidence/`；验证日志：`.omx/assistant-round1-*.log`。本轮未进行真实模型调用、浏览器点击验证或部署。

### 初始实现验证（修正前）

- `npm run typecheck`：通过；`git diff --check`：通过。
- 同进程全量 `node --test --test-isolation=none "src/**/*.test.ts"`：**416/416 通过**，exit 0。
- `npm run build -- --configLoader native`：通过，exit 0（既有 >500 kB chunk 警告）。
- 标准 `npm test`：exit 1，沙箱 `spawn EPERM`；标准 `npm run build`：exit 1，链接 node_modules 的 oxide 原生模块/配置打包受限。未将替代命令结果冒充标准命令通过。
- 独立复核发现的“跨用户缓存写入”和“审计失败误报业务失败”均已修复并定点复验通过；新增停止后的旧确认工具不得重新弹卡回归测试。
- 变更文件与 SHA-256：`.omx/assistant-evidence/SHA256SUMS.json`；回滚映射与基线：`.omx/assistant-evidence/rollback.md`、`.omx/assistant-backup/`。

测试使用 node:test、假会话/假服务或假 fetch，不调用真实模型、Hostinger、Grist、IMAP/SMTP。覆盖：全 RPC 分类、敏感清理与严格参数、确认/取消/超时/停止/新对话、普通用户无 admin 工具、跨用户分组和隔离、禁止写入、降权/停用/在途撤权、停用工作区只读关闭、MCP 与助手共用定义、缺配置、页面上下文与手册打包条件。最终测试和构建结果见交付说明及 `.omx/assistant-*-test*.log`。

- 标准 `npm test` 在当前沙箱遇到 spawn EPERM；替代命令为 `node --test --test-isolation=none "src/**/*.test.ts"`。
- 标准 `npm run build` 的 Vite 配置打包在当前沙箱遇到 spawn EPERM；使用 `npm run build -- --configLoader native` 可完成构建，仍有已有的大 chunk 警告。
- 还需沙箱外重跑标准 test/build；未做真实模型/外部服务联调、Docker 镜像实际构建、线上部署或真实多浏览器并发验收。UI 假 RPC 检查不代表真实业务已上线。
- Chrome 假 RPC 检查覆盖浅/暗色、确认卡、工具折叠、输入、键盘 Tab/Esc 焦点恢复、390×844 与 390×500。截图在 `.omx/assistant-evidence/assistant-{light,dark,mobile}.png`；浏览器 console 无 warning/error。减动画通过 CSS 和静态测试验证，未声称浏览器已模拟该媒体偏好。
- 修改前文件保存在当前 worktree 的 `.omx/assistant-backup`（保留结构或以双下划线编码路径），HEAD 已记录。回滚前停止服务、备份 `data/users` 和主密钥，核对文件哈希后只恢复本任务文件/移除本任务新增文件；禁止 git reset/clean。数据库追加审计表可保留，不自动删表或降级；恢复数据必须使用迁移前完整备份。
- 未 git commit、未改 .env、未写主目录；没有真实部署，因此不声称生产验证完成。
