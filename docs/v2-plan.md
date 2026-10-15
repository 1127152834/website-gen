# 独立站 AI 工厂 v2 计划（web 版、多用户、UI 重做、AI 主导建站与复核）

> 2026-10-15。实现由 Codex 分阶段完成，Claude 负责拆任务、审查、在沙箱外跑测试和实测、提交。
> 每个阶段结束都要：`npm run typecheck`、`npm test` 全过；有界面改动时截图自检；不提交 `.env`、`data/`、密钥。

## 0. 已定的决策

| 决策 | 结论 |
|---|---|
| 形态 | **只做 web 版**，去掉 Electron（主进程、预加载、托盘、safeStorage、NSIS 安装包） |
| 部署 | **Windows 和 Linux 都支持**：本机 `npm start` 直接跑；Linux 提供 Docker（含 Playwright Chromium），公网部署时前面放 Caddy 自动 HTTPS |
| 登录 | 用户名 + 密码。首次启动初始化管理员；管理员可添加用户、设置初始密码、重置密码、停用用户；用户首次登录必须改密码 |
| 数据隔离 | **每个用户一个独立目录和 SQLite 文件**（`data/users/<userId>/`），账号、批次、站点、模型 Key、CJ Key、对话、截图全部分开；管理员也看不到别人的业务数据 |
| 密钥 | 服务器主密钥来自环境变量 `WEBSITE_GEN_MASTER_KEY`（base64，32 字节），没有就首次启动生成 `data/master.key`（Linux 权限 600）。每个用户的数据密钥 = HKDF(主密钥, "user:<id>")；现有 `seal/unseal` 格式不变 |
| 模型 | 自定义厂商：任意 OpenAI 兼容或 Anthropic 兼容接口（名称、协议、Base URL、Key、模型列表），DeepSeek 只作为一键预设之一 |
| 网站质量 | 让 AI 更多参与内容、样式和整站复核；以 `release/2026-10-15-binessentials独立站深度审核.md` 列出的问题为验收清单 |

## 1. 阶段一：web 版 + 登录 + 多用户隔离（后端核心重构）

### 1.1 服务端

- 新入口 `src/server/index.ts`（Node 24，`node --experimental-strip-types` 不需要，Node 24 直接跑 .ts；生产用 `npm start`）。
- **只用 Node 内置模块**：`node:http` 提供 HTTP；`node:crypto` 的 `scrypt` 做密码哈希、`hkdfSync` 派生用户密钥、`randomBytes` 做会话令牌；推送用 **SSE**（`text/event-stream`），不引入 express/ws。
- 接口：
  - `POST /api/login {username, password}` → 设置会话 Cookie（`HttpOnly; SameSite=Strict; Path=/`，HTTPS 时加 `Secure`；支持 `TRUST_PROXY=1` 读 `X-Forwarded-Proto`）
  - `POST /api/logout`、`GET /api/me`、`POST /api/password {old, new}`
  - `POST /api/rpc {method, params}`：沿用现有 `handlers` 表和 `handleRequest`；要求请求头 `X-Requested-With: website-gen`（防 CSRF，配合 SameSite）
  - `GET /api/events?afterSeq=`：SSE，按用户推送现有的 `Push`（event / changed / chat）
  - 其余路径：静态文件（Vite 构建的前端），SPA 回退到 `index.html`；`/api/*` 未登录一律 401
- 安全：登录失败按 IP + 用户名限速（例如 5 次/10 分钟后锁 10 分钟）；会话 7 天滑动过期，存管理库；改密码后注销该用户其他会话；响应加 `Content-Security-Policy`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`；日志不记密码和 Token。
- 监听地址默认 `127.0.0.1:8787`，`HOST`/`PORT` 环境变量可改（Docker 里 `0.0.0.0`）。

### 1.2 用户与管理

- 管理库 `data/admin.sqlite`：`users(id, username UNIQUE, password_hash, role 'admin'|'user', must_change_password, disabled, created_at, last_login_at)`、`sessions(token_hash, user_id, expires_at, created_at)`、`login_attempts`。
- 首次启动没有用户时：用 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 环境变量建管理员；没给就生成随机密码，**只在控制台打印一次**，并标记首次登录必须改密码。
- 管理员页面：用户列表、添加用户（用户名 + 初始密码）、重置密码（标记必须改）、停用 / 启用。不能停用自己、不能删最后一个管理员。

### 1.3 每用户工作区（关键重构）

- 把 `src/backend/index.ts` 里的模块级单例（db、hostinger 连接池、任务队列、pi 对话、定时同步、定时恢复、handlers）收进 `createWorkspace({ userDir, key })`，返回 `{ handlers, push 订阅, close }`。
- `WorkspaceManager`：服务启动时为每个启用的用户打开工作区（后台任务不依赖用户在线）；新建用户时创建；停用时关闭。
- 每个工作区自己的：`website-gen.sqlite`（同一套迁移）、`work/`（QA 截图、插件副本）、`pi/`（对话）。
- `sites.qa` 读截图仍限制在本用户的 `work/qa` 下。

### 1.4 去掉 Electron

- 删除 `src/main`、`src/preload`、`electron-builder.yml`、托盘和 safeStorage 代码；`package.json` 去掉 electron、electron-vite、electron-builder 依赖和 `dist` 脚本；前端改用普通 Vite（`vite.config.ts`，`@` 别名、React、Tailwind 不变）。
- `src/backend/hostinger.ts`：MCP 子进程直接用 `process.execPath`（就是 node），去掉 `ELECTRON_RUN_AS_NODE`。
- `src/backend/qa-browser.ts`：Windows 用 Edge（`channel: "msedge"`）；其他系统用 Playwright 的 Chromium，路径可用 `QA_CHROMIUM_PATH` 指定；都不可用时照旧降级为提醒。
- 前端 `lib/backend.ts`：`call()` 改为 fetch `/api/rpc`；推送改为 `EventSource('/api/events')`，断线自动重连并按 seq 补发；401 跳登录页。
- 新页面：登录页、首次登录改密码页、「用户管理」（仅管理员）、右上角用户菜单（改密码、退出）。

### 1.5 旧桌面数据导入

- `scripts/import-desktop-data.ts`：把 `%APPDATA%\website-gen` 的桌面版数据导入某个 web 用户（默认管理员）。桌面版主密钥受 Windows DPAPI 保护，只能用 Electron 的 safeStorage 解开：保留一个最小的 `scripts/desktop-key-export.cjs`（用 `npx electron@44.7.2` 临时运行，不进依赖），把旧主密钥写到导入脚本的临时文件，导入脚本用旧密钥解开、用新用户密钥重新加密以下字段后删除临时文件：`hostinger_accounts.token_ciphertext`、`model_providers.api_key_ciphertext`、`secrets.ciphertext`、`sites.wp_admin_ciphertext / enroll_ciphertext / companion_ciphertext / mailbox_ciphertext`。pi 对话目录和 `work/` 原样复制。

### 1.6 部署

- `npm run build`（Vite 构建前端）→ `npm start`（`node src/server/index.ts`）。Windows 和 Linux 同一套命令。
- `Dockerfile`（`node:24` + `npx playwright install --with-deps chromium`）、`docker-compose.yml`（`app` + 可选 `caddy` 自动 HTTPS；`data` 卷；`WEBSITE_GEN_MASTER_KEY`、`ADMIN_*` 环境变量）、`.env.example` 补充说明。
- `docs/deploy.md`：本机运行、Linux + Docker + Caddy、备份（整个 `data/` + 主密钥，主密钥丢了数据就解不开）。

### 1.7 验收

- 现有 70 个单元测试全过（必要时改为不依赖 Electron）；新增：密码哈希与校验、登录限速、会话过期、两个用户数据互不可见（A 的 RPC 读不到 B 的账号）、未登录 401、缺 CSRF 头 403、首次启动初始化管理员。
- `scripts/smoke.ts` 改为浏览器测 web 版：启动服务 → 登录 → 强制改密码 → 各页面空状态 → 设置页假 Key 测试被拒 → 管理员添加用户 → 用新用户登录看不到管理员数据 → 退出。

## 2. 阶段二：自定义模型厂商 + 设置页重做

- 数据：`model_providers` 改为用户自建：`name、protocol(openai|anthropic)、base_url、api_key(加密)、models[]`；每个模型：`id、显示名、上下文长度、最大输出、是否支持图片、支持的思考强度、单价（可选）`。
- 预设：DeepSeek（两种协议）、OpenAI、Anthropic、OpenRouter、硅基流动、Moonshot、智谱、通义千问兼容模式等常见厂商一键填好 Base URL；用户只填 Key 再选模型。OpenAI 兼容接口支持「从 /v1/models 拉取模型列表」。
- 用途路由不变（建站与对话 / 看截图 / 批量文案 / 合规审查），任意厂商的任意模型都可选；看截图只能选支持图片的模型。阶段三会真正用上「看截图」和「合规审查」。
- 设置页重做：左侧分区导航（模型厂商、用途、商品资料、邮箱、账户安全），厂商卡片 + 编辑抽屉、连接测试结果、Key 只显示末 4 位；整体按阶段四的设计规范。
- 同一厂商的 Key 不再跨厂商「共用」（之前是同主机共用，改为每个厂商自己的 Key）。

## 3. 阶段三：AI 主导建站 + 整站 AI 复核（按审核报告整改）

审核报告的问题和对应改法（全部要做；括号里是报告编号）：

| 问题 | 改法 |
|---|---|
| 商品页「Shipping and returns」折叠是主题里写死的另一套规则（$50、1–2 天、Express）（01） | 主题商品模板里的这段改为由伴侣插件短代码按店铺规则输出（与政策页同一来源）；不提供的服务（Express）不写 |
| 商品页「Materials and care」写死了负责任采购、手工加工（05） | 删掉主题里的写死文案；由 AI 按每个商品的 CJ 资料写「材质与保养」，只用资料里的事实，没有就不写 |
| 商品图库不显示、所有变体同一张图（02、12） | 修主题的图库渲染；上架时把 CJ 的 `variantImage` 设为每个变体的图片；AI（看截图用途）从候选图里挑最清楚展示完整商品的主图 |
| 6/7/8 件套混在一个商品里、标题与变体不符、套装内容不清（03） | 上架前 AI 结构化分析变体：每个变体的件数/组件/颜色；标题和描述必须覆盖所有变体；说不清实际交付内容的变体不上架；变体名用买家能懂的颜色/款式名 |
| 尺寸 `27m` 这类单位错误（04） | 代码先做合理范围校验（包类长度 > 3m 等明显异常），AI 复核尺寸单位；有疑问的数值不发布 |
| 隐私政策说只用必要 Cookie，实际有 WooCommerce 订单归因 Cookie（06） | 建站时关闭 WooCommerce 订单来源归因（`woocommerce_feature_order_attribution_enabled = no`）；政策按实际在用的功能生成 |
| 退货流程、延迟/取消/丢件流程不完整（07、08） | 政策提示词补上：申请→批准→寄回→检查→退款各步骤和时限、30 天的起算口径；延迟发货通知与取消退款、丢件处理；代码检查这些要点都写到了 |
| 未接支付却显示 Stripe/PayPal 和卡组织 Logo（09） | 文案只写「支持的支付方式以结账页为准」，接入支付后再按实际改；主题购物车 / 结账的「We accept」Logo 改为只在对应网关启用时显示 |
| 商店页显示「0 items」（10） | 修主题 product-results-count 区块 |
| 搜索结果是博客样式（11） | 主题搜索模板改为商品结果（图、价格、标题），只搜商品 |
| WordPress 默认内容（Hello world、默认评论、Uncategorized、作者归档）（13） | 建站时删除示例文章和评论、示例页面；未分类改名或隐藏；作者归档 noindex 并从站点地图去掉 |
| 首页和分类弱（14） | AI 按商品实际用途建分类（旅行/通勤/健身…）；AI 设计首页区块（用真实商品图、分类入口、卖点），移动端首屏要看到商品 |
| 没有 meta description（15） | AI 为首页、商店、分类、每个商品写独立的 meta description 和 OG 描述，伴侣插件输出到 `<head>` |
| 满足包邮时仍显示收费 Standard（16） | 有免费配送可用时隐藏收费配送（伴侣插件过滤 `woocommerce_package_rates`） |

AI 参与的范围扩大：

- **样式**：AI 按品类和商品图提出配色、字体组合、圆角等，生成 Obel 的全局样式（代码检查文字对比度 ≥ 4.5:1），不再只在 3 个预设里选。
- **整站 AI 复核（QA 的一部分）**：爬取站内全部页面和商品（文字 + 截图）。「合规审查」模型逐页对照店铺规则和商品资料找矛盾（政策 vs 商品页 vs 结账运费、标题 vs 变体、单位错误、无依据的声明、默认内容、计数错误等），「看截图」模型检查页面观感（主图、空白、溢出、模板残留）。输出带证据的问题清单（页面、原文、为什么错、建议改法、级别）。
- **自动修复循环**：能用现有工具修的（文案、政策、商品文字、主图选择、分类）由 AI 修，修完再复核，最多 2 轮；修不了的（需要真实资料：实际尺寸、套装组件、材质证明）列为「待你补充」，阻断级问题不过就不算建完。
- 复核报告在批次页展示，格式参照审核报告（P1/P2/P3、证据、整改动作）。

## 4. 阶段四：整体 UI / 交互重做

- 现在像 demo：信息层级平、表格堆叠、缺少状态反馈和引导。重做为成熟的运营后台：
  - 统一设计规范（颜色 token、字号层级、间距、圆角、阴影、暗色模式），基于 shadcn/ui；中文界面、信息密度适中
  - 布局：可折叠侧边栏 + 顶栏（当前用户、全局搜索/快捷操作）；页面标题区 + 主操作；面包屑
  - 新增「总览」首页：站点数、进行中批次、待你操作（连接支付、开通邮箱、QA 问题）、域名即将到期
  - 建站：分步向导（经营主体 → 站点 → 确认），主体信息可保存为模板复用，CSV 导入
  - 批次 / 站点：卡片 + 详情抽屉；步骤时间线、日志筛选（级别、类型）、复核报告分级展示
  - 站点：每个站一个详情页（概况、对话、邮箱、变更记录、复核报告分页签）
  - 全局：加载骨架屏、空状态引导、操作反馈 toast、确认弹窗统一、键盘可达、窄屏可用
- 每个页面改完截图自检，不能只看代码。

## 5. 执行顺序

1. 阶段一（单独做，改动面最大）。
2. 阶段二 + 四（前端为主）与阶段三（流水线、主题、伴侣插件为主）可以并行，在不同 worktree 里做，最后合并。
3. 每阶段：Codex 实现 → Claude 跑测试/构建/冒烟/截图审查 → 有问题回给 Codex → 通过后提交。
