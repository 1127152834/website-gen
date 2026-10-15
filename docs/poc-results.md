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

## 第七轮：流水线后半段在 shopunitycart.com 上实测（2026-10-15，经你同意）

临时库里用真实账号续跑：前半段 8 步（主题升到 1.1.0、伴侣插件升到 0.3.1 并重新注册）→ 从 CJ 选品 → AI 撰写文案与政策 → 配置商店 → 创建页面 → 上架 3 个商品 → QA。脚本没有入库。

| 项 | 结论 |
|---|---|
| 从 CJ 选品 | ✅ 「dog beds」搜到 50 个，规则排除 + AI 筛查后 23 个可用，按热度备选 7 个；约 48 秒（主要是 AI 筛查） |
| AI 文案与政策 | ✅ 文案、4 个政策页一次就通过事实核对（处理/运输时效、$49 / $4.99、30 天退货、5–7 个工作日退款、邮箱、主体名称）和禁用说法检查；约 50 秒 |
| 配置商店 | ✅ 店名、标语、不让搜索引擎收录、USD、不收税、游客结账、「Contiguous US」配送区域（48 州 + DC，满 $49 包邮 / $4.99）；约 6 秒 |
| 页面 | ✅ 8 个页面 + 首页设置；⚠️ 见下面「隐私政策页」 |
| 上架商品 | ✅ 3 个（1 个单规格、2 个多规格），价格由代码算（例如 $14.99–$42.99），分类「Dog Beds」；每个约 20 秒（AI 改写约 10 秒 + 建商品约 8 秒） |
| QA | ✅ 11 项通过、3 个提醒（没连支付、support@ 邮箱没开、图片来自 CJ）；Edge 截了 7 张图，加购到结账走通 |
| 费用 | DeepSeek 合计约 $0.036（选品筛查 $0.009、文案 $0.0065、政策 $0.0059、每个商品约 $0.004） |

**这一轮发现并修好的问题**
1. **隐私政策页店长改不了**：被设为隐私政策页的那一页需要 `manage_privacy_options`（管理员权限），店长在 REST 编辑列表里根本看不到它，流水线就新建了一页，结果 slug 变成 `privacy-policy-2`。QA 当场拦下（必需页面缺 privacy-policy）。改为由伴侣插件（0.3.1）的 `/site-agent/v1/privacy-page` 在服务端发布并设置；误建的那页已移到回收站
2. **购物车、结账是 Woo 区块，`load` 之后才用 JS 拉内容**：截图时还是骨架，结账页找不到商品名。改为先等要检查的文字出现（最多 20 秒）
3. **网络抖动**：本机代理（198.18.x.x 是代理的虚拟地址）偶尔超时，Hostinger、站点 REST、浏览器导航都遇到过。流水线里这类错误都按临时错误处理，由任务队列自动重试；QA 的检查不再把超时记成「没通过」
4. CJ 的商品 ID 不全是数字，也有 UUID 格式；SKU 取后 10 位，两种都能用
5. CJ 详情接口的 `productKeyEn`（如 `Color-Size`）和 `variantKey`（如 `Light Grey-S`）能直接拆出规格属性，不需要 AI

**还没处理（记下来）**
- Hostinger 默认装的 AI Assistant 会在管理员打开结账页时弹出侧边栏，挡住截图（访客看不到）。方案里本来就要按白名单卸载这三个插件，下一步做
- QA 每跑一次都往管理员的购物车里加一件；不影响访客，以后 QA 结束时清空

## 第八轮：卸载默认插件、QA 清空购物车、一键上线（2026-10-15，经你同意）

| 项 | 结论 |
|---|---|
| 卸载多余插件 | ✅ `wordpress_plugins_uninstall` 一次提交三个（AI Assistant、Easy Onboarding、Reach），不用先停用；异步任务，约 20 秒后列表里消失。Hostinger Tools 保留（维护模式靠它） |
| QA 清空购物车 | ✅ 加购前在购物车页用 `wp.apiFetch` 调 Store API 清空（自带登录和 nonce），结账页只剩这一件；检查完再清空一次。AI 助手侧边栏不再挡结账页截图 |
| 一键上线 | ✅ 约 33 秒：关 Hostinger 维护模式（返回后再查状态）→ 伴侣插件 0.3.2 关掉 Woo「即将上线」（`woocommerce_coming_soon`）并打开搜索引擎收录 → 以访客身份请求首页，看到的是真实首页 |
| 恢复 | ✅ 测完立即把维护模式、Woo「即将上线」、不收录都恢复，访客重新看到维护页；对外可见约 40 秒 |

注意：WooCommerce 9.1 起新店默认开着自己的「即将上线」模式（只对店铺页面生效），和 Hostinger 的维护模式是两套，上线时两个都要关。

## 第九轮：pi 对话改站点内容（2026-10-15）

在桌面应用的「站点」页和 pi 对话（DeepSeek `deepseek-v4-pro`，思考强度 high），对象是 shopunitycart.com（维护模式中），改完在界面上回滚。

| 项 | 结论 |
|---|---|
| 改公告栏 + 定时恢复 | ✅ 约 20 秒：pi 先 `get_site`，再 `update_announcement`（记为变更 #1，线上公告随即变化），再 `schedule_revert` 到本地时间 12 月 1 日 00:00 |
| 不存在的折扣 | ✅ 「改成全场 8 折的黑五促销」被拒绝：pi 先查了商品价格，说明公告不能宣称店里没有的折扣、聊天里也改不了价格，没有产生任何变更 |
| 界面回滚 | ✅ 点「回滚」后线上公告恢复为 "Free US shipping on orders over $49"，变更显示「已回滚」 |
| 会话与密钥 | 会话存在本机（每个站一个目录），模型 Key 只在内存里（`InMemoryCredentialStore`），pi 只能用 13 个站点工具，内置 read/bash/edit/write 全关 |

**这一轮发现并修好的问题**
1. **时区**：第一次 pi 说按美国中部时间 12 月 1 日 00:00 恢复，实际传的时间换算成本地是 11 月 30 日 22:00，两边对不上。改为工具只收本地时间 `YYYY-MM-DD HH:mm`，由代码按这台电脑的时区解析；系统提示词里写明当前本地时间
2. **Markdown**：回复里的 `**加粗**` 原样显示。提示词要求纯文本，界面也把 `**…**` 渲染成加粗
3. **虚假折扣**：如果直接按要求写「全场 8 折」，而店里没有这个价格，就是误导性广告。系统提示词加了一条：店里没有的折扣、优惠券、赠品一律不写进公告

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
