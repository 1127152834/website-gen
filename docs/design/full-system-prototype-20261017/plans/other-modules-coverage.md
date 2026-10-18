# 其他模块一期静态原型覆盖计划

日期：10/17/2026（America/Los_Angeles）  
范围：M01–M08、O-M01–O-M09、R01–R04、O-R01–O-R03、T01–T03、S01–S10、O-S01–O-S10、A01–A09、O-A01–O-A05。  
状态：可直接交给后续出图执行；本文件不表示页面代码或真实服务已实现。

## 全局绘制约束

- 统一使用白底、深蓝主色；所有可见日期使用 `MM/DD/YYYY`。
- 只有网关申请显示“负责人”；其他资料与系统动作显示“操作人”，不得给邮箱、设置、资源或全局页面新增负责人。
- 邮件按域名 → 邮箱 → 文件夹 → 通知/待确认 → 跟进/事项分层；不把这些层级混成一张列表。
- 邮件 AI 只处理安全的本地纯文本正文，不访问正文链接或远程图片；译文/摘要不能替代原文，必须保留来源证据和人工纠正。
- Grist 使用原生 iframe；不绘制自制表格编辑器，不增加客户导入。
- 不增加独立材料页、主体模板、无驾照建档、测试支付或后续代运营。
- `existing_image` 全部为 `null`：本批次没有可作为完成证据的旧图；客户模块通用错误稿只能作状态参考。
- `alias_of` 只标注同一界面/表单的真实复用；独立设置页、确认弹窗和状态面板均保留自己的条目。

## 数量与批次

| 模块 | 主界面 | 覆盖层 | 合计 |
|---|---:|---:|---:|
| 邮件 | 8 | 9 | 17 |
| 账号与域名 | 4 | 3 | 7 |
| Grist | 3 | 0 | 3 |
| 设置与用户 | 10 | 10 | 20 |
| 全局体验 | 9 | 5 | 14 |
| **总计** | **34** | **27** | **61** |

## 逐条执行清单

### M01 邮箱管理主页面

- [ ] **形态**：`page`
- [ ] **目的**：按域名和邮箱分层管理连接、监听与同步，并进入具体文件夹。
- [ ] **现有图**：`null`
- [ ] **必画内容**：白底深蓝应用壳；域名分组；邮箱地址；凭据、监听、同步状态；客户关联标识；最近同步与错误
- [ ] **动作**：同步邮箱；打开邮箱；进入凭据；开始或停止监听；按客户定位
- [ ] **状态稿**：首次加载；空邮箱；未保存凭据；监听中/已停；同步中；认证失败；网络失败；无权限
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:133`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-management-page.tsx`；`src/renderer/src/features/mail/mailbox-pane.tsx`

### M02 文件夹／邮件列表

- [ ] **形态**：`subview`
- [ ] **目的**：在选定邮箱内浏览文件夹、搜索与分页，并安全切换邮件。
- [ ] **现有图**：`null`
- [ ] **必画内容**：邮箱地址；文件夹树；未读数；发件人/主题/日期；搜索；分页；选中态；MM/DD/YYYY
- [ ] **动作**：切换文件夹；搜索；上一页/下一页；选择邮件；标记已读/未读
- [ ] **状态稿**：未选邮箱；无凭据；加载中；空文件夹；搜索无结果；翻页中；读取失败；选中邮件失效
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:134`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mailbox-pane.tsx`；`src/renderer/src/features/mail/message-list-pane.tsx`

### M03 邮件阅读

- [ ] **形态**：`subview`
- [ ] **目的**：安全阅读单封邮件原文、附件与译文，并发起人工邮件动作。
- [ ] **现有图**：`null`
- [ ] **必画内容**：发件人/收件人/抄送；主题与MM/DD/YYYY时间；纯文本原文；附件清单；预审建议与严格来源证据；原文/译文明确区分
- [ ] **动作**：回复；回复全部；转发；翻译/查看原文；下载附件；已读/未读；移到废纸篓；查看关联申请
- [ ] **状态稿**：未选邮件；正文加载；正文失败；无正文；翻译中/失败；附件下载失败；邮件已删除；来源待确认
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:135`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/message-reader-pane.tsx`；`src/renderer/src/features/mail/mail-body.ts`

### M04 撰写／回复／转发

- [ ] **形态**：`dialog`
- [ ] **目的**：由员工明确编辑并发送纯文本邮件，保留申请义务交接上下文。
- [ ] **现有图**：`null`
- [ ] **必画内容**：发件邮箱；收件/抄送/密送；主题；纯文本正文；附件；原邮件引用；关联申请/所选回复义务
- [ ] **动作**：添加/移除附件；编辑；取消；提交发送；查看引用原文
- [ ] **状态稿**：新邮件/回复/回复全部/转发；校验失败；附件超限；发送确认；发送中；SMTP已接受待核对；已发送副本确认；发送失败；未保存离开
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:136`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/compose-dialog.tsx`

### M05 邮件预审与关联结果

- [ ] **形态**：`embedded-panel`
- [ ] **目的**：展示本地安全正文的分类建议、证据与关联候选，供人工纠正。
- [ ] **现有图**：`null`
- [ ] **必画内容**：分析状态；短标签；摘要；严格来源片段；关联申请候选；明确要求；不确定项；人工纠正信息
- [ ] **动作**：展开/收起；查看来源原文；查看申请；更正标签与原因；送人工确认
- [ ] **状态稿**：未启用；排队；分析中；证据完整；需人工核对；无关联；冲突；失败；人工已纠正
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:137`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/message-reader-pane.tsx`；`src/renderer/src/features/mail/mail-triage-client.ts`

### M06 待人工确认

- [ ] **形态**：`subview`
- [ ] **目的**：集中处理归属不清、证据不足或冲突的真实邮件事项。
- [ ] **现有图**：`null`
- [ ] **必画内容**：待确认计数；邮件摘要；邮箱/站点/平台候选；原因；来源时间；原文入口；申请候选
- [ ] **动作**：筛选未关联/未预审/失败；打开原邮件；打开候选申请；确认归属；纠正；加载更多
- [ ] **状态稿**：空队列；加载中；无关联；未预审；预审失败；候选冲突；并发更新；处理成功/失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:138`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-board-page.tsx`；`src/renderer/src/features/mail/mail-review-page.tsx`

### M07 邮件申请事项工作视图

- [ ] **形态**：`page`
- [ ] **目的**：按邮件义务查看需要处理、等待平台和结果回执，不复制业务申请状态。
- [ ] **现有图**：`null`
- [ ] **必画内容**：三列看板；平台/站点/邮箱/客户；事项身份；来源证据；开放义务；最后更新时间MM/DD/YYYY；未关联标识
- [ ] **动作**：筛选站点/邮箱/平台；搜索；切换移动端列；打开事项；查看原邮件；进入申请；加载更多
- [ ] **状态稿**：加载；空列；筛选无结果；未关联；未预审；失败；等待平台；结果回执；读取失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:139`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-board-page.tsx`；`src/renderer/src/features/mail/mail-case-drawer.tsx`

### M08 历史邮件补审

- [ ] **形态**：`operation-page`
- [ ] **目的**：先预览本地缓存范围，再明确确认进入低优先级补审队列。
- [ ] **现有图**：`null`
- [ ] **必画内容**：7天/30天范围；授权邮箱；专用模型/授权摘要；预览数量；单批200上限；队列进度；失败与待核对
- [ ] **动作**：选择范围；生成预览；确认入队；取消；重试失败项；打开待核对项
- [ ] **状态稿**：未启用；无授权邮箱；预览中；预览有效/过期；配置变化；入队中；运行中；部分失败；完成；取消
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:140`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-triage-settings-page.tsx`

### O-M01 邮箱凭据弹窗

- [ ] **形态**：`dialog`
- [ ] **目的**：验证并加密保存单邮箱凭据，区分拒绝与网络故障。
- [ ] **现有图**：`null`
- [ ] **必画内容**：邮箱地址；密码输入；已保存状态；敏感信息提示；验证结果
- [ ] **动作**：验证并保存；取消；显示/隐藏已保存密码；进入重置
- [ ] **状态稿**：空输入；验证中；成功；凭据拒绝；网络失败；邮箱不存在；关闭
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:254`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/credential-dialog.tsx`

### O-M02 密码显示／重置确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：保护邮箱密码显示和远端重置等敏感动作。
- [ ] **现有图**：`null`
- [ ] **必画内容**：明确邮箱对象；本次动作；共享屏幕提醒；远端立即失效影响；不可撤销提示
- [ ] **动作**：确认显示；隐藏；确认重置；取消
- [ ] **状态稿**：默认隐藏；二次确认；显示中；重置中；成功；失败；过期
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:255`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/credential-dialog.tsx`

### O-M03 撰写窗口

- [ ] **形态**：`dialog`
- [ ] **目的**：承载 M04 的同一撰写、回复、回复全部和转发界面。
- [ ] **现有图**：`null`
- [ ] **必画内容**：与M04完全相同的发件邮箱、地址、正文、附件、引用与申请义务
- [ ] **动作**：与M04相同
- [ ] **状态稿**：与M04相同
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:256`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/compose-dialog.tsx`
- [ ] **真实复用**：`alias_of: M04`；不得另画第二套语义。

### O-M04 邮件移到废纸篓确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认把明确的一封邮件移入废纸篓，不等同永久删除邮箱。
- [ ] **现有图**：`null`
- [ ] **必画内容**：邮箱；文件夹；邮件主题/发件人；移动影响
- [ ] **动作**：确认移入废纸篓；取消
- [ ] **状态稿**：待确认；处理中；成功；失败；邮件已被移动/删除
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:257`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/message-reader-pane.tsx`

### O-M05 删除邮箱确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认永久删除远端邮箱及本地索引，阻止误伤客户沟通关联。
- [ ] **现有图**：`null`
- [ ] **必画内容**：邮箱地址；远端删除影响；本地凭据/索引/正文缓存影响；客户/申请关联警告
- [ ] **动作**：查看关联；取消；输入确认；永久删除
- [ ] **状态稿**：无关联；有关联被阻止/需先处理；删除中；部分失败；成功；权限不足
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:258`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-management-page.tsx`

### O-M06 邮件翻译展开区

- [ ] **形态**：`embedded-panel`
- [ ] **目的**：在保留原文证据的前提下展示单封邮件译文。
- [ ] **现有图**：`null`
- [ ] **必画内容**：原文/译文标签；目标语言；翻译时间；当前邮件身份；免责声明
- [ ] **动作**：开始翻译；查看译文；切回原文；重试
- [ ] **状态稿**：未翻译；翻译中；成功；失败；切换邮件后清空；原文已变化
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:259`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/message-reader-pane.tsx`

### O-M07 监听／同步详情面板

- [ ] **形态**：`drawer`
- [ ] **目的**：解释邮箱连接模式、最近同步和失败原因并提供安全重试。
- [ ] **现有图**：`null`
- [ ] **必画内容**：邮箱；轮询/实时模式；凭据状态；最近同步MM/DD/YYYY时间；监听状态；错误详情
- [ ] **动作**：开始/停止监听；立即同步；重试；进入凭据
- [ ] **状态稿**：未凭据；监听中/已停；同步中；认证失败；网络失败；服务不可用；恢复
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:260`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-management-page.tsx`

### O-M08 发信前确认弹窗

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：在外发前复核发件身份、收件范围、附件和本次回复义务。
- [ ] **现有图**：`null`
- [ ] **必画内容**：发件邮箱；收件/抄送/密送人数及地址；主题；附件；已选择回复义务；SMTP接受不等于送达提示
- [ ] **动作**：返回编辑；确认发送；取消
- [ ] **状态稿**：可发送；地址变化需重算；发送中防重复；SMTP接受待核对；成功；失败；结果未知
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:261`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/compose-dialog.tsx`

### O-M09 补审预览／入队确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认 M08 的范围、数量、专用模型和授权版本后入队。
- [ ] **现有图**：`null`
- [ ] **必画内容**：范围；邮箱清单；预览数量；200上限；模型与授权版本；预算影响；预览有效期
- [ ] **动作**：取消；重新预览；确认入队
- [ ] **状态稿**：预览中；有效；空结果；已过期；配置变化；入队中；成功；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:262`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-triage-settings-page.tsx`

### R01 账号与域名主页面

- [ ] **形态**：`page`
- [ ] **目的**：管理 Hostinger 接入账号及同步状态，并进入账号域名区域。
- [ ] **现有图**：`null`
- [ ] **必画内容**：账号列表；Token尾号；状态；订单/网站/域名/邮箱数量；上次同步；错误；白底深蓝
- [ ] **动作**：添加账号；选择账号；同步；删除接入记录
- [ ] **状态稿**：加载；空账号；首次同步；正常；Token无效；同步错误；刷新中；删除失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:152`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/accounts/accounts.tsx`

### R02 选中账号的域名区域

- [ ] **形态**：`subview`
- [ ] **目的**：展示域名事实状态、到期和网站/邮箱/客户占用关系。
- [ ] **现有图**：`null`
- [ ] **必画内容**：域名；状态；到期MM/DD/YYYY；网站；邮箱；客户关联；占用来源；同步时间
- [ ] **动作**：搜索/筛选；打开域名详情；进入站点/邮箱/客户；发起既有放弃操作
- [ ] **状态稿**：未选择账号；未同步；空域名；加载；正常；待设置；待验证；过期；关联未知；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:153`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/accounts/accounts.tsx`

### R03 域名详情

- [ ] **形态**：`drawer`
- [ ] **目的**：只读汇总域名所属账号及资源关联，避免推断远端可用性。
- [ ] **现有图**：`null`
- [ ] **必画内容**：域名；账号；同步状态；到期；网站/邮箱/客户关联；最后核对时间；事实来源
- [ ] **动作**：进入站点；进入邮箱；进入客户；刷新；关闭
- [ ] **状态稿**：加载；无关联；部分关联；同步过期；读取失败；域名不存在
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:154`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/accounts/accounts.tsx`

### R04 放弃站点／域名资源

- [ ] **形态**：`execution-panel`
- [ ] **目的**：保留高风险资源清理流程，逐步呈现网站、邮箱与续费影响。
- [ ] **现有图**：`null`
- [ ] **必画内容**：目标域名；账号；影响清单；客户关联阻止；输入域名确认；步骤进度；失败明细；回滚边界
- [ ] **动作**：输入确认；开始；继续执行；重试失败步骤；取消未执行部分；返回资源
- [ ] **状态稿**：未确认；有关联被阻止；执行中；部分成功；失败可重试；完成；结果未知
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:155`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/components/abandon-site.tsx`

### O-R01 添加 Hostinger 账号弹窗

- [ ] **形态**：`dialog`
- [ ] **目的**：验证并保存账号名称与 API Token。
- [ ] **现有图**：`null`
- [ ] **必画内容**：账号名称；API Token密码框；生成位置说明；加密且不回显提示
- [ ] **动作**：验证并添加；取消
- [ ] **状态稿**：空输入；校验错误；验证中；成功并同步；Token拒绝；网络失败；重复名称
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:263`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/accounts/accounts.tsx`

### O-R02 删除账号确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：只删除本地接入记录和同步快照，不冒充远端资源删除。
- [ ] **现有图**：`null`
- [ ] **必画内容**：账号名称；本地Token/快照影响；远端网站域名邮箱不变；客户关联影响
- [ ] **动作**：查看关联；取消；确认删除
- [ ] **状态稿**：无关联；有关联警告；删除中；成功；失败；并发已删除
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:264`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/accounts/accounts.tsx`

### O-R03 放弃资源确认和执行面板

- [ ] **形态**：`execution-panel`
- [ ] **目的**：承载 R04 的同一域名确认、步骤、失败与重试界面。
- [ ] **现有图**：`null`
- [ ] **必画内容**：与R04完全相同
- [ ] **动作**：与R04相同
- [ ] **状态稿**：与R04相同
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:265`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/components/abandon-site.tsx`
- [ ] **真实复用**：`alias_of: R04`；不得另画第二套语义。

### T01 Grist 内嵌外壳

- [ ] **形态**：`page`
- [ ] **目的**：在应用中加载已配置的原生 Grist，并提供登录、刷新和设置入口。
- [ ] **现有图**：`null`
- [ ] **必画内容**：白底深蓝宿主工具栏；登录；刷新；新标签打开；设置入口；原生iframe；跨源状态说明
- [ ] **动作**：登录Grist；刷新iframe；新标签打开；前往设置；重试读取
- [ ] **状态稿**：读取设置；未配置；设置读取失败；iframe加载；登录弹窗被阻止；跨源拒绝未知；已配置
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:161`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/tables/tables.tsx`；`src/renderer/src/features/tables/grist-iframe.ts`

### T02 Grist 原生文档与表格

- [ ] **形态**：`external-embed`
- [ ] **目的**：由原生 Grist 承担文档、页面、组件和单元格编辑，不重画客户导入。
- [ ] **现有图**：`null`
- [ ] **必画内容**：原生Grist界面；宿主只保留iframe边界；无客户导入入口；无伪造内部错误诊断
- [ ] **动作**：使用Grist原生导航与编辑；必要时新标签打开
- [ ] **状态稿**：由Grist控制的登录/加载/文档/权限状态；宿主仅能说明无法确认跨源内部原因
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:162`；`docs/design/prototype-groups-v1.md:40`；`src/renderer/src/features/tables/tables.tsx`

### T03 Grist 连接设置

- [ ] **形态**：`settings-section`
- [ ] **目的**：复用 S06 的同一 Grist 地址、凭据、测试与 MCP 集成设置。
- [ ] **现有图**：`null`
- [ ] **必画内容**：与S06完全相同
- [ ] **动作**：与S06相同
- [ ] **状态稿**：与S06相同
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:163`；`docs/design/prototype-groups-v1.md:44`；`src/renderer/src/features/tables/grist-settings.tsx`
- [ ] **真实复用**：`alias_of: S06`；不得另画第二套语义。

### S01 设置／模型厂商

- [ ] **形态**：`settings-section`
- [ ] **目的**：管理模型服务商、密钥状态、模型能力和已保存模型连接测试。
- [ ] **现有图**：`null`
- [ ] **必画内容**：厂商卡；协议/Base URL；Key尾号；模型/能力/价格；用途引用；连接测试结果
- [ ] **动作**：添加；编辑；删除；测试已保存模型；刷新
- [ ] **状态稿**：加载；空厂商；Key缺失；可用；测试中/成功/失败；被用途引用；删除失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:171`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### S02 厂商编辑及模型列表

- [ ] **形态**：`drawer`
- [ ] **目的**：编辑厂商连接草稿并获取或手工维护模型列表。
- [ ] **现有图**：`null`
- [ ] **必画内容**：预设；名称；协议；Base URL；API Key；模型ID/名称/视觉/推理级别/价格；草稿提示
- [ ] **动作**：选择预设；获取模型；添加/删除模型；保存；关闭
- [ ] **状态稿**：新增/编辑；获取中；获取失败；目的地变化需新Key；校验失败；未保存；保存中/成功/失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:172`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### S03 设置／用途分配

- [ ] **形态**：`settings-section`
- [ ] **目的**：为各任务选择模型及推理参数，同时把邮件预审导向专用授权。
- [ ] **现有图**：`null`
- [ ] **必画内容**：用途说明；厂商；模型；推理强度；就绪问题；驾照识别/材料审核占位；邮件预审专用入口
- [ ] **动作**：更换厂商/模型/推理；进入邮件AI设置
- [ ] **状态稿**：加载；未分配；Key缺失；模型不支持能力；保存中；成功；失败；邮件预审不可通用修改
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:173`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### S04 设置／商品资料 CJ

- [ ] **形态**：`settings-section`
- [ ] **目的**：管理只读商品资料 Key，不扩展到店铺授权或履约。
- [ ] **现有图**：`null`
- [ ] **必画内容**：Key是否设置与尾号；只读用途说明；验证提示
- [ ] **动作**：设置/更换Key；验证并保存
- [ ] **状态稿**：未设置；输入；验证中；成功；失败；网络错误
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:174`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### S05 设置／邮箱

- [ ] **形态**：`settings-section`
- [ ] **目的**：配置默认邮箱密码并报告自动验证摘要。
- [ ] **现有图**：`null`
- [ ] **必画内容**：密码状态；新密码输入；安全说明；成功/失败/稍后重试数量；不影响既有邮箱的清除说明
- [ ] **动作**：保存/更换；清除；查看结果摘要
- [ ] **状态稿**：读取；随机密码；已设置；验证中；部分成功；失败；稍后重试；清除成功/失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:175`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### S06 设置／Grist

- [ ] **形态**：`settings-section`
- [ ] **目的**：管理 Grist 服务地址、API Key、连接测试和 MCP Token。
- [ ] **现有图**：`null`
- [ ] **必画内容**：Base URL；Key状态；测试身份；保存/清除；MCP命令；一次性Token状态
- [ ] **动作**：保存；测试连接；清除Key/设置；生成/撤销Token；复制命令
- [ ] **状态稿**：加载；未配置；校验失败；测试中/成功/失败；保存中；Token未生成/已生成/已使用/撤销
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:176`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/tables/grist-settings.tsx`

### S07 设置／账户安全

- [ ] **形态**：`settings-section`
- [ ] **目的**：在设置内复用 A03 的改密表单与规则。
- [ ] **现有图**：`null`
- [ ] **必画内容**：当前密码；新密码；确认密码；会话影响；返回行为
- [ ] **动作**：修改密码；取消/返回
- [ ] **状态稿**：普通改密；首次强制改密；校验失败；保存中；成功；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:177`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/auth/change-password.tsx`；`src/renderer/src/features/settings/settings.tsx`
- [ ] **真实复用**：`alias_of: A03`；不得另画第二套语义。

### S08 内部用户管理

- [ ] **形态**：`page`
- [ ] **目的**：管理员管理内部账号、角色、启停与密码重置，不创建客户。
- [ ] **现有图**：`null`
- [ ] **必画内容**：用户表；用户名；角色；状态；必须改密；创建时间MM/DD/YYYY；操作入口
- [ ] **动作**：创建用户；重置密码；启用/停用；搜索/筛选
- [ ] **状态稿**：加载；空；无权限；启用；停用；必须改密；操作中；成功；失败；并发变化
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:178`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/users/users.tsx`

### S09 设置／邮件 AI 预审

- [ ] **形态**：`page`
- [ ] **目的**：专门授权本地安全正文发送到明确模型服务并配置范围、预算与提醒。
- [ ] **现有图**：`null`
- [ ] **必画内容**：默认关闭；专用厂商/模型；邮箱范围；外发目的地同意；每日上限；本地提醒；补审入口；人工评估批准状态
- [ ] **动作**：启停；选择模型/邮箱；同意范围；保存；预览补审；导入脱敏评估；批准当前版本
- [ ] **状态稿**：关闭；未授权；blocked_config；enabled；paused_budget；paused_audit；版本变化需重授权；保存失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:179`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-triage-settings-page.tsx`

### S10 设置／邮件关联规则

- [ ] **形态**：`settings-section`
- [ ] **目的**：维护经人工核对的发件线索和关联候选，不把域名当作结论。
- [ ] **现有图**：`null`
- [ ] **必画内容**：发件地址/域名；平台；邮箱；站点；客户/申请；人工理由；版本与操作人
- [ ] **动作**：新增；编辑；移除；查看影响；打开来源
- [ ] **状态稿**：空规则；候选；已确认；冲突；并发版本变化；保存中；成功；失败；移除确认
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:180`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/contact-mapping-pane.tsx`

### O-S01 厂商与模型编辑抽屉

- [ ] **形态**：`drawer`
- [ ] **目的**：承载 S02 的同一厂商连接和模型草稿编辑。
- [ ] **现有图**：`null`
- [ ] **必画内容**：与S02完全相同
- [ ] **动作**：与S02相同
- [ ] **状态稿**：与S02相同
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:266`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`
- [ ] **真实复用**：`alias_of: S02`；不得另画第二套语义。

### O-S02 删除厂商确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：展示用途引用和删除影响，禁止静默改用其他模型。
- [ ] **现有图**：`null`
- [ ] **必画内容**：厂商；Key/模型删除影响；引用用途；不可撤销提示
- [ ] **动作**：查看引用；取消；确认删除
- [ ] **状态稿**：无引用；有引用需阻止/处理；删除中；成功；失败；并发变化
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:267`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### O-S03 CJ 凭据弹窗

- [ ] **形态**：`dialog`
- [ ] **目的**：验证并保存新的 CJ API Key。
- [ ] **现有图**：`null`
- [ ] **必画内容**：API Key密码框；生成位置；只读用途；验证失败不保存
- [ ] **动作**：验证并保存；取消
- [ ] **状态稿**：空输入；校验失败；验证中；成功；失败；网络错误
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:268`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### O-S04 邮箱默认密码清除确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：说明清除默认值只影响以后新建或待验证邮箱。
- [ ] **现有图**：`null`
- [ ] **必画内容**：当前状态；未来随机密码；已有邮箱不变；不批量重置远端
- [ ] **动作**：取消；确认清除
- [ ] **状态稿**：待确认；清除中；成功；失败；并发已清除
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:269`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/settings/settings.tsx`

### O-S05 Grist 凭据／集成操作确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：保护 Grist 凭据清除和 MCP Token 等敏感操作。
- [ ] **现有图**：`null`
- [ ] **必画内容**：动作对象；Base URL；Key/Token影响；一次性Token提示；不可回显边界
- [ ] **动作**：保存/清除；生成/撤销Token；复制一次性值；取消
- [ ] **状态稿**：待确认；处理中；成功；失败；Token已存在/已撤销/已使用
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:270`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/tables/grist-settings.tsx`

### O-S06 创建内部用户弹窗

- [ ] **形态**：`dialog`
- [ ] **目的**：创建内部员工账号和初始密码，不创建客户。
- [ ] **现有图**：`null`
- [ ] **必画内容**：用户名；角色；初始密码；下次强制改密说明
- [ ] **动作**：创建；取消
- [ ] **状态稿**：校验失败；创建中；成功；重复用户名；权限不足；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:271`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/users/users.tsx`

### O-S07 重置用户密码弹窗

- [ ] **形态**：`dialog`
- [ ] **目的**：对已确定的内部用户设置新初始密码并说明会话影响。
- [ ] **现有图**：`null`
- [ ] **必画内容**：只读用户；新初始密码；确认密码；会话失效；下次强制改密
- [ ] **动作**：重置；取消
- [ ] **状态稿**：校验失败；重置中；成功；用户已停用/删除；权限不足；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:272`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/users/users.tsx`

### O-S08 启用／停用用户确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认内部账号访问变化且不删除其业务记录。
- [ ] **现有图**：`null`
- [ ] **必画内容**：用户；当前角色/状态；访问影响；客户记录保留；负责人交接另行处理
- [ ] **动作**：确认启用/停用；取消
- [ ] **状态稿**：启用确认；停用确认；处理中；成功；失败；并发状态变化
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:273`；`docs/design/prototype-groups-v1.md:41`；`src/renderer/src/features/users/users.tsx`

### O-S09 邮件 AI 授权／配置变更确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认哪些邮箱正文交给哪个服务商及当前版本和额度。
- [ ] **现有图**：`null`
- [ ] **必画内容**：厂商/Base URL；模型与配置修订；邮箱范围；每日上限；不可撤回说明；同意复选框
- [ ] **动作**：返回修改；确认授权；关闭预审
- [ ] **状态稿**：未勾选；范围为空；Key缺失；版本变化；确认中；成功；失败；保持未启用
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:274`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/mail-triage-settings-page.tsx`

### O-S10 关联规则新增／编辑／移除抽屉

- [ ] **形态**：`drawer`
- [ ] **目的**：人工核对关联线索、理由和影响，不篡改历史结果。
- [ ] **现有图**：`null`
- [ ] **必画内容**：发件地址/域名；平台；邮箱；站点；客户/申请；理由；现有版本；历史不回写提示
- [ ] **动作**：新增/编辑；移除；保存；取消；查看来源
- [ ] **状态稿**：新增；编辑；冲突；校验失败；保存中；成功；失败；移除确认；并发版本变化
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:275`；`docs/design/prototype-groups-v1.md:39`；`src/renderer/src/features/mail/contact-mapping-pane.tsx`

### A01 应用框架

- [ ] **形态**：`shared-shell`
- [ ] **目的**：为全部业务页提供分组导航、连接状态、搜索、主题、用户和助手入口。
- [ ] **现有图**：`null`
- [ ] **必画内容**：白底深蓝；可收起侧栏；分组导航；页面标题；后台连接；身份复核；邮件未读；搜索；主题；用户；助手；窄屏菜单
- [ ] **动作**：切换导航；折叠侧栏；搜索；切主题；打开用户菜单/助手；重连
- [ ] **状态稿**：已连接；连接中；身份失效；页面切换；新邮件通知；窄屏；深色模式；导航权限过滤
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:62`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/layout/authenticated-layout.tsx`；`src/renderer/src/components/layout/header.tsx`；`src/renderer/src/components/layout/app-sidebar.tsx`

### A02 登录页

- [ ] **形态**：`page`
- [ ] **目的**：供内部账号登录，不提供客户注册或营销入口。
- [ ] **现有图**：`null`
- [ ] **必画内容**：品牌；用户名；密码；登录按钮；内部使用说明；服务状态
- [ ] **动作**：提交登录
- [ ] **状态稿**：空输入；校验失败；提交中；凭据错误；账户停用；服务不可用；登录成功；必须改密跳转
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:63`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/features/auth/login.tsx`

### A03 修改密码页

- [ ] **形态**：`page`
- [ ] **目的**：处理首次强制改密和主动改密并区分返回路径。
- [ ] **现有图**：`null`
- [ ] **必画内容**：当前密码；新密码；确认密码；密码规则；会话影响；返回入口
- [ ] **动作**：保存新密码；返回/退出
- [ ] **状态稿**：首次强制；主动修改；校验失败；保存中；成功；失败；会话失效
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:64`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/features/auth/change-password.tsx`

### A04 个人菜单

- [ ] **形态**：`dropdown`
- [ ] **目的**：展示当前内部用户并提供改密、主题和退出操作。
- [ ] **现有图**：`null`
- [ ] **必画内容**：用户名/角色；修改密码；浅色/深色/跟随系统；退出
- [ ] **动作**：打开/关闭；切主题；进入改密；退出
- [ ] **状态稿**：默认；键盘焦点；主题切换；退出中；身份过期
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:65`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/profile-dropdown.tsx`；`src/renderer/src/components/theme-switch.tsx`

### A05 403 无权限页

- [ ] **形态**：`page-state`
- [ ] **目的**：明确访问被拒绝并返回可访问位置，不用空表伪装。
- [ ] **现有图**：`null`
- [ ] **必画内容**：403；对象/页面说明；当前身份；安全返回入口
- [ ] **动作**：返回首页；返回上一页；重新登录
- [ ] **状态稿**：无权限；权限刚变化；身份失效；返回失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:66`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/features/errors/index.tsx`

### A06 404 不存在页

- [ ] **形态**：`page-state`
- [ ] **目的**：处理无效地址或已不存在对象且不显示旧资料。
- [ ] **现有图**：`null`
- [ ] **必画内容**：404；页面/对象不可用说明；不缓存旧详情；返回入口
- [ ] **动作**：返回首页；返回上一页；打开列表
- [ ] **状态稿**：无效地址；对象已删除；链接过期；返回
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:67`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/features/errors/index.tsx`

### A07 500 异常页

- [ ] **形态**：`page-state`
- [ ] **目的**：安全展示服务异常与恢复入口，不输出密钥或客户原文。
- [ ] **现有图**：`null`
- [ ] **必画内容**：500；通用错误摘要；请求标识占位；重试/返回；隐私边界
- [ ] **动作**：重试；返回首页；返回上一页
- [ ] **状态稿**：服务异常；重试中；恢复；持续失败；离线
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:68`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/features/errors/index.tsx`

### A08 全局搜索

- [ ] **形态**：`command-dialog`
- [ ] **目的**：按页面、域名、设置及拟新增客户索引快速导航。
- [ ] **现有图**：`null`
- [ ] **必画内容**：分组结果；页面；站点域名；设置；客户姓名/企业索引；键盘提示；无结果
- [ ] **动作**：输入搜索；键盘选择；打开结果；关闭
- [ ] **状态稿**：初始；输入中；加载站点/客户；有结果；无结果；读取失败；权限过滤
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:69`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/search.tsx`

### A09 全局 AI 助手

- [ ] **形态**：`nonmodal-panel`
- [ ] **目的**：提供对话、工具进展与人工确认，不虚构未实现的客户工具。
- [ ] **现有图**：`null`
- [ ] **必画内容**：消息历史；流式文本；工具进展；确认卡；参数；输入；停止；新对话；错误；设置入口
- [ ] **动作**：发送；停止；允许/拒绝工具；开始新对话；关闭；前往模型设置
- [ ] **状态稿**：空对话；加载历史；生成中；等待确认；确认过期；已停止；错误；未读；模型缺失
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:70`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/global-assistant.tsx`

### O-A01 搜索弹窗

- [ ] **形态**：`command-dialog`
- [ ] **目的**：承载 A08 的同一全局搜索界面。
- [ ] **现有图**：`null`
- [ ] **必画内容**：与A08完全相同
- [ ] **动作**：与A08相同
- [ ] **状态稿**：与A08相同
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:276`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/search.tsx`
- [ ] **真实复用**：`alias_of: A08`；不得另画第二套语义。

### O-A02 助手工具确认卡

- [ ] **形态**：`embedded-card`
- [ ] **目的**：在执行有副作用的助手工具前展示动作、对象和参数。
- [ ] **现有图**：`null`
- [ ] **必画内容**：工具显示名；动作描述；对象/参数；10分钟过期；允许/拒绝
- [ ] **动作**：确认执行；取消
- [ ] **状态稿**：待确认；处理中；已允许；已拒绝；已过期；执行失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:277`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/global-assistant.tsx`

### O-A03 助手开始新对话确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：确认清空对话上下文但不撤销已执行操作。
- [ ] **现有图**：`null`
- [ ] **必画内容**：将清空的上下文；已执行操作不回滚；待确认工具处理说明
- [ ] **动作**：确认新对话；取消
- [ ] **状态稿**：无进行中操作；生成中需先停止；有待确认；重置中；成功；失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:278`；`docs/design/prototype-groups-v1.md:42`；`src/renderer/src/components/global-assistant.tsx`

### O-A04 未保存离开确认

- [ ] **形态**：`confirm-dialog`
- [ ] **目的**：为编辑抽屉、向导和撰写统一提供未保存保护。
- [ ] **现有图**：`null`
- [ ] **必画内容**：离开的界面；未保存内容摘要；不会自动保存说明
- [ ] **动作**：继续编辑；放弃并离开
- [ ] **状态稿**：有未保存改动；保存失败后；上传/发送中阻止；确认离开；并发关闭
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:279`；`docs/design/prototype-groups-v1.md:44`；`src/renderer/src/features/mail/compose-dialog.tsx`

### O-A05 并发修改提示

- [ ] **形态**：`conflict-dialog`
- [ ] **目的**：说明记录已被同事更新、删除或改派，避免静默覆盖。
- [ ] **现有图**：`null`
- [ ] **必画内容**：对象；本地编辑摘要；远端变化摘要；操作人；MM/DD/YYYY时间；比较/重新读取选项
- [ ] **动作**：比较；重新读取；复制本地内容；取消；按权限重试
- [ ] **状态稿**：远端更新；远端删除；申请负责人变更；版本冲突；重载成功；重载失败
- [ ] **依据**：`docs/design/application-page-inventory-v1.md:280`；`docs/design/prototype-groups-v1.md:44`；`docs/design/application-page-inventory-v1.md:280`

## 出图验收顺序

1. 先画每个主界面的正常桌面态，再补对应覆盖层；主界面不能因覆盖层已画而省略。
2. 每项至少核对必画内容、动作和状态稿；同一状态只可复用布局，不可省略本 ID 的入口与语义。
3. 最后做跨模块回归：邮件层级、Grist iframe、角色/权限、全局搜索/助手、未保存与并发冲突。
4. 对照 JSON 做机器校验：61 个唯一 ID、34 个主界面、27 个覆盖层、6 个真实别名、所有 `existing_image` 为 `null`。

## 回滚记录

- 本次两份目标文件此前均不存在；回滚方式为删除本批次新增的 `other-modules-coverage.md` 与 `other-modules-coverage.json`。
- 未修改应用代码、现有清单、旧图或真实数据。
