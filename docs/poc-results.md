# P0 技术验证结果

> 2026-10-14 · 对应 [solution-design.md](solution-design.md) 第 12 节。脚本在 `poc/`，原始输出在 `poc/out/`（已被 git 忽略）。

## 已验证

| 项 | 结论 | 证据 |
|---|---|---|
| DeepSeek 两种格式的多轮工具调用 | ✅ OpenAI 格式和 Anthropic 格式下，`deepseek-v4-pro` 和 `deepseek-flash` 都能多轮调用工具（思考模式开启）并给出正确答案；按「错误写在结果正文里」的约定，失败结果在两种格式下都能被模型正确理解和转述 | `npm run poc:deepseek` |
| `deepseek-flash` 看 QA 截图 | ✅ 两种格式都正确读出商品名和价格，并主动指出「商品图加载失败」 | 同上，截图 `poc/out/qa.png` |
| DeepSeek 实测花费 | 一次 3–4 轮的工具调用：pro 约 $0.0023，flash 约 $0.001；看一张截图约 $0.0002 | 同上 |
| pi SDK 嵌入：只开放自定义工具 | ✅ 用 `tools` 白名单后，活动工具只有我们的两个，内置 bash/read/write/edit 等一个都不在 | `npm run poc:pi` |
| pi：L2 工具「待确认」流程 | ✅ 两种格式下，pi 提交 L2 操作后都停下等确认、没有自行重试；批准结果送回后 pi 继续并向你汇报 | 同上 |
| pi：流式事件做 AI 日志 | ✅ `message_update`（文本增量）、`tool_execution_start/end`、`message_end` 足够拼出「AI 输出 + 工具调用」日志 | 同上 |
| Hostinger MCP 本机进程 | ✅ `@hostinger/mcp` 2.16.0 以 stdio 方式启动正常，暴露 `search` / `execute` / `multi-execute` | `npm run poc:hostinger` |
| Hostinger 操作 schema | ✅ 方案用到的 32 个操作全部用 `search` 拿到参数 schema。`search` 纯本地运行，不需要 Token | `poc/out/hostinger-ops.json` |

## 第二轮（拿到 Hostinger 和 CJ 密钥后，全部只读）

| 项 | 结论 | 证据 |
|---|---|---|
| Hostinger Token + MCP `execute` | ✅ `hosting_orders_list`、`hosting_websites_list`、`domains_portfolio_list`、`mail_orders_list` 都成功，每次 0.5–0.8 秒 | `npm run poc:hostinger` |
| 账号现状 | 1 个主机订单（`hostinger_unlimited_v6`）；9 个已有 WordPress 网站；10 个域名，其中 **shopunitycart.com 还没有网站**；10 个域名都有邮箱订单（多为 Starter Business Email 免费试用） | `poc/out/hostinger-main-*.json` |
| CJ REST 鉴权 | ✅ `POST /authentication/getAccessToken`（body 只要 `apiKey`）；accessToken 有效期 180 天，24 小时内重复调用返回同一个；请求头 `CJ-Access-Token` | `npm run poc:cj` |
| CJ 选品 `/product/listV2` | ✅ `countryCode=US` + 价格区间可用；**关键词相关性一般**（搜 dog bed 混进风铃、床垫），pi 需要二次筛选或改用类目 ID；价格按变体是区间 | `poc/out/cj-products.json` |
| CJ MCP 连接 | ✅ 地址是 `https://developers.cjdropshipping.com/mcp/<accessToken>`（accessToken 本身就是 `API@<userId>@CJ:…` 格式，原样拼接、不要 URL 编码）。「API Key 拼地址」的旧方式已下线（服务端返回） | 同上 |
| CJ MCP 工具 | ✅ 实际有 **70 个工具**，远多于文档列出的，包括：`get_authorize_url`（生成店铺授权链接）、`publish_product_async` / `query_publish_status`（刊登到 Woo 等店铺）、`create_product_connection`（商品关联）、`get_product_inventory`、`calculate_freight`、`get_logistics_timeliness`。每个工具都带只读/写入/破坏性标注 | `poc/out/cj-mcp-tools.json` |
| CJ MCP 限速 | 读 10 次/秒，写 2 次/秒，认证 1 次/秒，全局 20 次/秒，并发 5 | `get_rate_limit_status` |

## 第三轮：Electron 桌面端（方案 v0.7）

| 项 | 结论 | 证据 |
|---|---|---|
| Electron 版本 | 44.7.2（2026-10-13 发布），自带 Node 24.21.0、Chromium 152 | `npx electron --version` |
| `node:sqlite` | ✅ 在 Electron 自带的 Node 下可直接使用，不需要编译原生模块 | `npm run poc:electron-node` |
| Hostinger MCP 子进程 | ✅ 用 Electron 可执行文件 + `ELECTRON_RUN_AS_NODE=1` 启动，`search` / `execute` / `multi-execute` 正常 | 同上 |
| pi | ✅ `pi-coding-agent`、`pi-ai` 在 Electron 自带的 Node 下正常加载 | 同上 |
| 待验证 | 打包成安装包后：MCP 子进程（依赖 `runAsNode` 功能开关）、`resources/` 目录部署、`safeStorage` 异步加解密 | — |

## 第四轮：shopunitycart.com 实际建站（2026-10-14，经你同意）

| 步骤 | 结果 | 耗时 | 备注 |
|---|---|---|---|
| 建网站 + 装 WordPress（`hosting_websites_start-setup`，带域名） | ✅ | 约 45 秒 | 装的是 **WordPress 7.1.3**、PHP 8.3.35；管理员 `sucadmin`，密码在本机 `poc/out/secrets.json` 的 `wp_admin` |
| SSL | ✅ 自动签发 | 0 | Hostinger 终身证书，HTTPS 跳转已开；建站后立刻可用 |
| 维护模式 | ✅ 已开启 | — | **新站默认就是开启状态**；再调用「开启」返回 HTTP 500。访客看到「Coming Soon」（HTTP 200，**没有 noindex**），REST API 和后台登录不受影响 |
| WooCommerce | ✅ 11.2.1 已装并激活 | 约 11 秒 | 安装接口返回 HTTP 500，但实际已完成 |
| Fifty / Obel 主题 | ✅ 已部署并激活 | 55 秒 | 精简后 58 个文件、846KB，逐个上传约 1 秒/个；PHP 代码已审，无外部请求、无动态执行；Obel 标注只测到 WP 6.9，**WP 7.1 下的渲染还没目测** |
| 伴侣插件部署 + 激活 | ✅ | 11 秒 + 5 秒 | 从本机目录部署 |
| 本机拉取注册 | ✅ | <1 秒 | 一次性令牌换到应用密码；健康检查 200；同一令牌重放被拒（403） |
| support 邮箱 | ✅ 已存在，复用 | 0 | 10 月 4 日已建好；该邮箱订单只有 1 个席位，已被它占用；发信上限 1000 封/天 |
| CJ 店铺授权链接 | ✘ 接口报错 | — | `get_authorize_url` 实际还要求文档里没写的 `email`、`userName`，补了也仍报 `userName must be not empty`；你的 CJ 账号显示名是「CJ Temporary user name」，可能是资料没补全。**改为在 CJ 后台手动授权** |
| 刊登 1 个商品 | 待授权后进行 | — | — |

### 第五轮：按新定位（CJ 只当商品资料库，自己供货发货）建 1 个商品

| 步骤 | 结果 |
|---|---|
| CJ 读商品详情（`get_product_detail`，只读） | ✅ 拿到标题、26 张图、HTML 描述、材质、重量、类目，以及 8 个规格（颜色 × 尺码，各自成本价 $17.89–33.54、尺寸、规格图） |
| DeepSeek（`deepseek-flash`）改写 + 拆分规格 | ✅ 约 $0.007。第一次校验没通过：AI 把「Brown xl」规范成了「XL」，按原文比对对不上 → 改为按顺序一一对应 |
| Woo REST 建可变商品（伴侣插件的应用密码） | ✅ 商品 #15，8 个规格 $44.99–83.99，4 张图，约 12 秒；公开商店接口可查到 |
| 规格属性问题 | 发现并修复：AI 把材质、洗涤说明等也放进了属性列表，全部设为可选规格会让顾客必须选「洗涤说明」→ 改为只有颜色、尺码是可选规格，其余作为参数展示 |
| 商品页目测（管理员视角，1440 宽） | ✅ 排版正常：图库、标题、价格区间、简介、颜色/尺码下拉、加入购物车 |
| 商品页目测（窄宽度） | ⚠️ 管理员视角下，Hostinger AI 助手面板把内容区压到约 525 像素，导致信息栏被挤成一列字。主题用的是 WordPress 自带两栏（图库 55%，小于 782 像素才变单栏），真实访客应不受影响，但**要在卸载该插件后，按 390 / 900 / 1440 三个宽度复测** |
| 一次性登录链接 | `wordpress_login_create-links` 返回不带协议头的地址（`域名/create_autologin_….php`），需要自己补 `https://` |

### 这一轮带来的设计修正

0. **CJ 只当商品资料库**：不做 CJ 店铺授权、刊登、商品关联、下单，站点不装 CJ 插件；表单新增必填「发货时效」（你们自己发货，只有你知道）；CJ 图片的版权要在正式上线前处理
1. **Hostinger 写操作返回 500 ≠ 失败**：维护模式、装插件两次都是约 10 秒后返回 `HTTP 500 [Hosting:9999] Request failed`，但操作其实都完成了。网关对写操作一律采用「先查状态 → 执行 → 失败时再查状态确认」，**绝不盲目重试**
2. **新站默认开启维护模式**：流水线直接复用，不再调用开启；上线时再关闭。建站期间同时把 WordPress 的「允许搜索引擎索引」关掉，上线时打开（Coming Soon 页面没有 noindex）
3. **新站默认带 4 个 Hostinger 插件**（AI Assistant、Easy Onboarding、Reach、Hostinger Tools）：按插件白名单，前三个在流水线里卸载
4. **按域名过滤 WordPress 安装列表查不到新站**：改为按 Hostinger 用户名列出，再在本地按域名匹配，拿到安装 ID（`software`）
5. **MCP 调用超时要调大**：部署主题、插件是逐个文件上传，58 个文件用了 55 秒，已经接近 MCP SDK 默认的 60 秒超时。部署包只保留运行需要的文件
6. **伴侣插件注册方式定稿**：激活时只建 `site-agent` 账号（商店经理 + 编辑主题设置权限）；应用密码在 `POST /wp-json/site-agent/v1/enroll` 时当场生成并只返回一次，数据库不暂存明文；令牌只存哈希、15 分钟过期、只能用一次
7. **邮箱和其他资源都要「已有就复用」**：建站前先查，存在就记录下来，不重复创建
8. **CJ 授权要有手动兜底**：`get_authorize_url` 失败时，「待你操作」里显示 CJ 后台的手动授权步骤；建议先在 CJ 补全账号资料，再重试接口

## 第六轮：建站流水线前半段在 shopunitycart.com 上续跑（2026-10-15）

在临时内存库里用真实 Hostinger 账号跑 `provisionSite`（脚本没有入库，过程见下）。

| 项 | 结论 |
|---|---|
| 预检 | ✅ 实时查 `hosting_websites_list` 发现该域名已有网站，直接永久失败，没有调用建站接口 |
| 从「安装 WordPress」续跑 | ✅ 8 步全部完成，共 45 秒：按用户名找到安装 ID 31100468；维护模式已开、SSL 有效至 2027-01-02；WooCommerce 11.2.1 已启用（跳过） |
| Obel 主题 | ⚠️ 已安装但**未启用**（POC 之后被切走了），流水线发现后重新启用；说明「已安装」不能当作「已就绪」，必须看启用状态 |
| 伴侣插件 0.2.0 | ✅ 覆盖部署旧版后仍是启用状态；按新代数注册成功，旧的应用密码被轮换；健康检查返回 WordPress 7.1.3、WooCommerce 11.2.1、obel 1.0.0 |
| 耗时 | `wordpress_maintenance_show-status` 一次约 8.7 秒，插件/主题列表约 4 秒，部署插件约 12 秒 |
| 日志 | 只记操作名、耗时、成败；管理员密码、注册令牌、应用密码都不进日志（单元测试也在检查） |

单元测试用模拟的 Hostinger 覆盖了另外两种情况：建站要轮询两次才完成；装插件返回 500 但实际已装好（以列表为准）；注册令牌被拒时退回「部署伴侣插件」，换更高代数重新部署后注册成功。

## POC 带来的设计修正（已同步进方案 v0.6）

1. **批准后唤醒 pi 要用 `sendCustomMessage(..., { triggerTurn: true })`**。会话空闲时调用 `followUp()` 只会排队，不会开启新一轮（实测）。
2. **邮箱依赖邮箱订单**：`mail_mailboxes_create-mailbox` 的域名取自邮箱订单（参数是 `orderId` + `local_part`）。只有已经买了 Hostinger 邮箱套餐的域名才能自动建 support@，预检要查这一点，没有就改用表单里填的邮箱。
3. **Hostinger 操作自带读写标注**：每个操作都带 `readOnly` / `destructive` 标注，可直接作为风险分级的初始依据（只读 → L0，destructive → 至少 L2）。
4. **两种套餐的建站参数**：
   - Business/Cloud 用 `hosting_websites_start-setup`：`order_id`、`type: "wordpress"`、`domain`，以及 `wordpress.admin{user,password,email}`、`language`，一次调用即可带域名建站并装好 WP
   - Agency 用 `agency-hosting_website-setups_create`：额外必填 `datacenter_code`、`flavor`（WP 版本，如 `wp-6.8`）、`settings.php.version`
   - WP 管理员密码要求 8–50 位、大小写加数字，并且不能是泄露过的密码 → 由系统随机生成并加密保存
5. **插件部署**：`hosting_deploy-wordpress-plugin` 的参数是 `domain`、`slug`、`pluginPath`（本机目录）。它逐个文件上传到临时目录，再按 `slug` 部署到正式位置。
6. **CJ 上架走 MCP**（第二轮修正了第一轮的判断）：
   - 店铺授权：`get_authorize_url(shopType: "woocommerce")` 生成授权链接
   - 刊登：`publish_product_async` 刊登，`query_publish_status` 查结果
   - 刊登**不是幂等的**：重复调用会重复刊登，所以要先用 `query_shop_publish_info` 检查商品是否已刊登，并把 `listedId` 记进数据库
   - 美国仓商品必须显式传 `sourceCountryCode=US` 和对应仓库，默认值是 CN
   - **永远不传 `scoreList`**：这个参数会把 CJ 的买家评价导入 WooCommerce，违反 FTC 评价规则
   - MCP 地址里放的是 accessToken，按密钥对待：只在内存里拼接，不写日志
7. **DeepSeek 默认协议**：两种格式表现一致，默认用 OpenAI 格式（pi 内置提供方，少一层自定义配置），Anthropic 格式保留为备选。

## 待验证

| 项 | 需要什么 |
|---|---|
| 创建邮箱 | 同上，在 shopunitycart.com 的邮箱订单上建 support@ |
| CJ 店铺授权 + 刊登 1 个商品 + 查询刊登状态 | 同上；授权链接需要你在浏览器里点一次同意 |
| 同账号并行建 3 个站 + 限流实测 | 3 个可以随意改动的域名 |
| Agency 建站路径 | Agency 账号的 Token |
| 跨账号绑定 + SSL | 第二个账号的 Token，以及一个可以随意改 DNS 的测试域名 |
