# 客户、网关与通用壳：静态原型覆盖盘点

10/17/2026 · 只新增本盘点 Markdown 与 JSON；不修改原图、不写应用代码、不调用真实服务。

## 结论

- 当前客户图册 **54 张**，全部文件存在且 SHA-256 与 catalog 一致；另复用 1 个通用壳骨架。
- 本盘点共 **89 个屏幕/状态记录**：54 个现行图、1 个壳复用、**32 个必须补画**、2 个仅可复用状态模式（没有对应成图，不计完成）。
- 客户正常页/建档/归因/附件已充分覆盖，不重复重画；缺口以全局网关、申请定稿、纠正与邮件推进、真实交互入口及全局页面为主。
- 每屏完整的 required_content/actions/states/source_refs 见同目录 `customer-gateway-coverage.json`；有图不等于代码完成、可点击、外部服务验收或用户已批准全部新稿。

## 业务硬约束
- 无独立材料页；证明文件归客户当前资料，按所属页/申请补充证明入口管理，不以此次申请生成可编辑副本。
- 无无驾照建档；单张和批量都先上传正面，OCR失败可依原图人工转录，正式创建还需图片成功关联和人工确认。
- 准备材料不设客户负责人；开始网关申请时才指定申请负责人。操作人由登录身份记录，不可手选代填。
- 字段/每份附件只记录当前最后成功操作人；未变更、复制、取消、失败不刷新归因。C10不是中间变更历史。
- 一次申请保留不可变时点定稿：实际字段、实际文件内容、当时各项归因和当时负责人。当前资料变化不改既有定稿。
- 同客户正常只一条在办，首个有效获批即客户完成；后续申请与完成独立；误判获批纠正必须重算。
- 人工纠正后新邮件仍可推进；旧邮件重复处理不能反复覆盖人工纠正。AI结果须带原文依据，不猜下一步或缺件月份。
- 资料审核仅参考，未执行/失败/发现风险均可知悉后继续申请。系统记录开始不替代向支付平台人工申请。
- 一客户一企业一网站一商业邮箱；所有日期MM/DD/YYYY；州选项缩写与灰色全名；驾照正常页不显示缩略图。
- 同一G02业务记录被C09/G01/G03/M07等引用，不维护第二套客户获批状态。

## 现行图映射

| 页面/状态 ID | 名称 | 形态 | 有效图片 |
|---|---|---|---|
| C01 | 客户列表与速览 | page | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png) |
| C02 | 档案概览 | page | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v2.png) |
| C03 | 个人资料 | tab | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v3.png) |
| C04 | 企业资料 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C04-company-ui-v3.png) |
| C05 | 银行资料 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C05-bank-ui-v3.png) |
| C10-bank | 银行资料操作归属 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C10-bank-ui-v3.png) |
| O-C04-personal | 编辑个人资料 | drawer | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v3.png) |
| O-C04-company | 编辑企业资料 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/support/O-C04-company-edit-v2.png) |
| O-C04-bank | 编辑银行资料 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/support/O-C04-bank-edit-v2.png) |
| O-C05 | 企业办理状态 | modal | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v2.png) |
| O-C07 | 上传文件 | drawer | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v2.png) |
| O-C08 | 当前文件预览 | drawer | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v2.png) |
| O-C09 | 替换文件 | modal | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v2.png) |
| O-C10 | 移除文件 | modal | [打开](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v2.png) |
| C12 | 上传驾照建档 | page | [打开](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png) |
| C13 | 人工核对识别结果 | page | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/C13-recognition-review-v4.png) |
| C14 | 建档结果 | page | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/C14-creation-results-v3.png) |
| O-C02 | O-C02 重复线索处理 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/O-C02-duplicate-v2.png) |
| O-C03 | O-C03 字段差异确认 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/O-C03-differences-v2.png) |
| C12-upload-states | C12 上传混合状态 | state | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/C12-upload-states-v2.png) |
| C13-manual-transcription | C13 识别失败后的人工转录 | state | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/onboarding/C13-manual-transcription-v2.png) |
| C14-unknown-result | C14 提交结果未知 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/C14-unknown-result-v1.png) |
| C07 | C07 网站与邮箱 | tab | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C07-website-mail-v1.png) |
| O-C11 | O-C11 关联或更换已有网站 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/O-C11-link-site-v2.png) |
| O-C12 | O-C12 关联或更换商业邮箱 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/O-C12-link-mail-v2.png) |
| O-C13 | O-C13 解除关联确认 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/O-C13-unlink-confirm-v2.png) |
| O-C14 | O-C14 网站公开信息对照 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/O-C14-public-info-v2.png) |
| C08 | C08 材料审核 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/C08-review-v2.png) |
| O-G01 | O-G01 确认检查范围 | drawer | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G01-review-scope-v1.png) |
| O-G02 | O-G02 审核运行状态 | drawer | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G02-review-running-v1.png) |
| O-G03 | O-G03 审核发现详情 | drawer | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G03-finding-detail-v1.png) |
| C09-active | C09 网关申请：有在办申请 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/C09-applications-active-v2.png) |
| C09-idle | C09 网关申请：无在办申请 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/C09-applications-idle-v2.png) |
| O-G04 | O-G04 开始网关申请 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/links/O-G04-start-application-v2.png) |
| O-C07-upload-states | O-C07 附件上传混合状态 | state | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/support/O-C07-upload-states-v1.png) |
| O-C08-preview-unavailable | O-C08 预览读取失败 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C08-preview-unavailable-v1.png) |
| O-C08-preview-unsupported | O-C08 格式不支持预览 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C08-preview-unsupported-v1.png) |
| O-C09-replace-failure | O-C09 替换失败 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C09-replace-failure-v1.png) |
| O-C10-remove-failure | O-C10 移除失败 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C10-remove-failure-v1.png) |
| O-C04-save-failure | O-C04 编辑保存失败 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C04-save-failure-v1.png) |
| O-C15 | O-C15 删除客户影响确认 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/support/O-C15-delete-confirm-v1.png) |
| O-C16 | O-C16 删除执行结果 | drawer | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C16-delete-execution-v1.png) |
| C10-personal-page1 | C10 个人资料操作归属：第 1 页 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C10-personal-page1-ui-v2.png) |
| C10-personal-page2 | C10 个人资料操作归属：第 2 页 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C10-personal-page2-ui-v2.png) |
| C10-company | C10 企业资料操作归属 | tab | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C10-company-ui-v2.png) |
| C10-actor-detail | C10 字段操作归属详情 | drawer | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C10-actor-detail-ui-v2.png) |
| C01-empty | C01 尚无客户 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-empty-v1.png) |
| C01-search-empty | C01 搜索无结果 | state | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C01-search-empty-ui-v2.png) |
| C01-loading | C01 列表加载中 | state | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/C01-loading-ui-v2.png) |
| C01-read-failure | C01 客户速览读取失败 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-read-failure-v1.png) |
| C02-not-found | C02 档案不存在 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C02-not-found-v1.png) |
| C02-forbidden | C02 无权访问档案 | state | [打开](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C02-forbidden-v1.png) |
| O-A04 | O-A04 未保存离开确认 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/O-A04-unsaved-ui-v2.png) |
| O-A05 | O-A05 并发修改冲突 | modal | [打开](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected/O-A05-conflict-ui-v2.png) |
| A01 | 通用应用壳 | shared_shell | [打开](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png) |

## 真正缺页与必要状态

以下全部 existing_image 为 null；只写文档或在已有图中放一个入口链接，不算已经绘制。

### G01 · 网关申请工作台
- **形态/状态**：page；必须补画。
- **职责**：横向管理全部客户的单次申请，不重复维护客户状态。
- **内容**：每行一次申请；客户/企业/平台/当前负责人/状态/来源/更新日期；客户完成独立；当前与历史筛选。
- **动作**：筛选平台/负责人/状态；打开G02；选择客户开始O-G04。
- **关键状态**：正常多客户列表；当前与历史混合。

### G02 · 单次申请详情概览
- **形态/状态**：page；必须补画。
- **职责**：同一业务申请在客户、全局和邮箱入口中的统一详情。
- **内容**：客户/企业/网站/商业邮箱；平台/申请标识；当前负责人；状态和证据来源；开始时间；客户完成；定稿入口。
- **动作**：打开档案/邮箱/来源；人工纠正；结束；查看申请定稿。
- **关键状态**：当前待补件；获批/拒绝/结束按真实记录。

### G03 · 申请邮件与明确要求
- **形态/状态**：tab；必须补画。
- **职责**：仅汇集该申请有原文出处的邮件要求和处理证据。
- **内容**：邮件归属；原文片段与日期；明确要求；期限仅有依据时展示；逐项处理记录；当前证明不等于已提交。
- **动作**：查看原邮件；打开要求详情；人工关联；去邮箱回复；记录结果。
- **关键状态**：明确补件要求；来源不充分进入待确认。

### G04 · 申请状态与纠正记录
- **形态/状态**：tab；必须补画。
- **职责**：保存申请办理事实，展示AI推进和人工纠正的来源。
- **内容**：前后状态；操作/来源为人工或邮件AI；时间；理由；客户完成重算结果；原邮件入口。
- **动作**：查看来源；人工纠正；打开申请定稿。
- **关键状态**：人工纠正后新邮件再次合法推进。

### G02-snapshot · 申请时点定稿
- **形态/状态**：tab；必须补画。
- **职责**：读取该次申请保存的不可变字段、文件内容和归因。
- **内容**：平台/申请标识/定稿时间/确认操作人/当时负责人；当前负责人另列；字段值和每份文件最后操作人/来源；只读标签。
- **动作**：分类浏览；复制字段；预览/单文件下载。
- **关键状态**：既有定稿与当前档案已变化仍不回写。

### O-G-snapshot-preview · 申请定稿附件预览
- **形态/状态**：drawer；必须补画。
- **职责**：与可管理当前附件明确区别的只读时点文件。
- **内容**：本次申请定稿只读；申请标识/平台；定稿文件内容；当时归因；不是当前附件链接。
- **动作**：查看；下载；关闭。
- **关键状态**：正常只读预览；无替换/移除/恢复。

### O-G05 · 人工更新或纠正申请状态
- **形态/状态**：drawer；必须补画。
- **职责**：人工纠正事实并预览客户完成状态影响。
- **内容**：当前/目标状态；理由/证据；操作人；客户是否仍有其他有效获批；新邮件仍可推进说明。
- **动作**：预览影响；保存纠正；取消。
- **关键状态**：唯一获批纠正后客户变未完成；另有获批则仍完成。

### O-G06 · 结束本次申请确认
- **形态/状态**：modal；必须补画。
- **职责**：记录撤回或终止并释放正常在办名额。
- **内容**：平台/申请标识；当前状态；结束原因；仅内部记录不代表远端撤回。
- **动作**：确认结束；取消。
- **关键状态**：在办转结束；旧邮件不能复活。

### O-G07 · 邮件与申请关联确认
- **形态/状态**：drawer；必须补画。
- **职责**：先确认原邮件的正确归属再应用证据。
- **内容**：原文来源；客户/申请候选；平台/申请标识/站点核对；仅邮箱相同不足以归属。
- **动作**：确认关联；保持待核对；取消。
- **关键状态**：候选冲突/归属不明。

### O-G08 · 明确要求与处理记录
- **形态/状态**：drawer；必须补画。
- **职责**：一项有原文出处的要求及对应办理事实。
- **内容**：原邮件与原要求；可选明确期限；员工说明；材料/发信证据；上传与发送与平台确认区分。
- **动作**：关联当前证明；去邮箱回复；记录处理；保存。
- **关键状态**：已上传未发送；已发送未平台确认。

### O-G09 · 纠错后的在办冲突
- **形态/状态**：modal；必须补画。
- **职责**：纠正误判后出现两条在办时保护真实记录。
- **内容**：被纠正申请；已经开始的后续申请；客户状态重新计算；不得自动终止/删除任一条；禁止第三次开始。
- **动作**：查看两条申请；按已有规则人工处理或删除客户；关闭。
- **关键状态**：少见双在办冲突；保持纠错事实。

### O-G10 · 事项身份确认与误归组拆分
- **形态/状态**：modal；必须补画。
- **职责**：只调整选定邮件证据的归组。
- **内容**：原事项/目标事项；平台/申请标识/站点/客户；选择的事件；未关联仍可待核对。
- **动作**：确认身份；拆分所选；取消。
- **关键状态**：误归组；非全部同域名邮件搬迁。

### O-G11 · 分类或待办纠正与撤销
- **形态/状态**：drawer；必须补画。
- **职责**：修正邮件分析或人工处理的错误而不改原文。
- **内容**：原值/新值；分类/明确要求/期限/处理状态；理由；他人更新提示。
- **动作**：保存纠正；撤销错误人工决定；取消。
- **关键状态**：分类纠正；人工决定撤销；并发用O-A05。

### O-G12 · 待办结果记录
- **形态/状态**：modal；必须补画。
- **职责**：逐项记录已完成动作和实际证据。
- **内容**：待办原要求；结果类型；说明；发信/材料证据；未完成项目仍开放。
- **动作**：记录回复已发/动作完成/忽略/受阻；取消。
- **关键状态**：有证据完成；受阻；不全清其他义务。

### O-G04-concurrent · 申请开始并发冲突
- **形态/状态**：state；必须补画。
- **职责**：两个入口同时开始时仅接受一个正式在办。
- **内容**：已生效申请/负责人/开始时间；本次未重复创建；原输入安全返回。
- **动作**：打开已生效申请；返回。
- **关键状态**：并发失去资格；不能只靠禁用按钮。

### O-G04-unknown · 申请与定稿保存结果未知
- **形态/状态**：state；必须补画。
- **职责**：未知结果先核实，避免重复申请和缺定稿的半成功。
- **内容**：请求/目标；结果未知；申请与定稿原子成功边界；不能显示已开始。
- **动作**：核实状态；返回档案。
- **关键状态**：未知；核实前不重提。

### O-G05-approved-correction-result · 唯一获批被纠正后的结果
- **形态/状态**：state；必须补画。
- **职责**：把客户完成重算结果直接画出，不只文字承诺。
- **内容**：申请由获批变回有证据目标值；无其他有效获批时客户未完成；操作人/理由/来源；原邮件保存。
- **动作**：返回申请；查看纠正记录。
- **关键状态**：误判获批纠正完成。

### G04-new-email-after-correction · 人工纠正后的新邮件推进
- **形态/状态**：state；必须补画。
- **职责**：证明人工纠正不永久锁死状态且旧邮件不反复覆盖。
- **内容**：纠正时间；新邮件时间/标识；前后状态；客户完成联动；旧邮件已处理/重复不应用说明。
- **动作**：查看新原邮件；查看纠正；打开当前申请。
- **关键状态**：新证据可推进；不以旧邮件重放覆盖。

### A02 · 内部用户登录
- **形态/状态**：page；必须补画。
- **职责**：内部员工凭账号登录，无客户注册。
- **内容**：账号/密码；登录按钮；产品标识；无客户注册入口。
- **动作**：登录；显示隐藏密码。
- **关键状态**：正常；提交中；校验错误/认证失败。

### A03-forced · 首次必须修改密码
- **形态/状态**：page；必须补画。
- **职责**：完成强制改密后才能继续。
- **内容**：当前/新/确认密码；密码校验；强制模式说明；不提供绕过返回。
- **动作**：保存新密码；退出。
- **关键状态**：必须修改；保存失败保留输入。

### A03-voluntary · 主动修改密码
- **形态/状态**：page；必须补画。
- **职责**：从个人菜单主动修改密码。
- **内容**：当前/新/确认密码；校验；允许取消返回。
- **动作**：保存；取消。
- **关键状态**：主动改密；不与强制模式混同。

### A04 · 个人菜单
- **形态/状态**：popover；必须补画。
- **职责**：当前内部身份、主题、改密、退出。
- **内容**：姓名/角色；浅色/深色/跟随系统；修改密码；退出。
- **动作**：选择主题；改密；退出。
- **关键状态**：菜单展开。

### A05 · 全局无权限
- **形态/状态**：page；必须补画。
- **职责**：无法访问模块时说明原因并安全返回。
- **内容**：403；权限说明；无隐私内容；可访问入口。
- **动作**：返回首页/上一可访问位置。
- **关键状态**：全局权限拒绝。

### A06 · 全局页面不存在
- **形态/状态**：page；必须补画。
- **职责**：无效路由或对象已不存在。
- **内容**：404；安全返回；不读取旧对象资料。
- **动作**：返回首页。
- **关键状态**：路由不存在。

### A07 · 全局服务异常
- **形态/状态**：page；必须补画。
- **职责**：明确服务错误而不伪装空数据。
- **内容**：错误提示；重试/返回；不泄漏密钥或客户原文。
- **动作**：重试；返回。
- **关键状态**：服务异常。

### A08/O-A01 · 全局搜索
- **形态/状态**：modal；必须补画。
- **职责**：按页面、域名、客户和设置导航。
- **内容**：搜索输入；分组结果；客户/企业索引；键盘提示；非材料全文搜索。
- **动作**：输入搜索；选择结果；关闭。
- **关键状态**：有结果；无结果。

### A09 · 全局AI助手
- **形态/状态**：drawer；必须补画。
- **职责**：非阻塞对话和实际工具执行状态。
- **内容**：消息；工具进展；确认/拒绝；停止；新对话；错误；新增客户工具未实现不冒充。
- **动作**：发送；停止；展开工具；新对话。
- **关键状态**：对话/执行中/错误。

### O-A02 · 助手工具确认卡
- **形态/状态**：component；必须补画。
- **职责**：执行前明示具体动作和对象。
- **内容**：工具拟操作对象/参数；影响；允许或拒绝；不假定新客户工具可用。
- **动作**：允许；拒绝。
- **关键状态**：等待人工确认。

### O-A03 · 助手新对话确认
- **形态/状态**：modal；必须补画。
- **职责**：清空上下文不撤销已执行动作。
- **内容**：清空对话上下文范围；既有变更不撤销。
- **动作**：开始新对话；取消。
- **关键状态**：确认前。

### A01-session-expired · 会话失效或身份复核失败
- **形态/状态**：state；必须补画。
- **职责**：登录状态异常时不永久遮罩也不泄露资料。
- **内容**：会话失效/复核失败区别；未保存数据提示；重新登录或重试。
- **动作**：重新登录；重试身份复核。
- **关键状态**：会话失效或复核失败。

### A01-narrow-navigation · 窄屏菜单与主从切换
- **形态/状态**：state；必须补画。
- **职责**：展示窄屏不会硬挤列表、详情和抽屉。
- **内容**：收起导航；菜单入口；一次只读列表或详情；返回清楚。
- **动作**：打开菜单；切换列表/详情。
- **关键状态**：窄屏静态代表态。

### C09-current-proofs · 当前客户补充证明管理
- **形态/状态**：drawer；必须补画。
- **职责**：让履行协议、库存照片、其他证明的链接有实际目标而不重建材料独立页。
- **内容**：所属客户当前资料；证明类别；每份文件最后操作人；多份；已有定稿不变；不等于提交平台。
- **动作**：上传；查看；替换；移除；单文件下载。
- **关键状态**：当前证明列表；空分类复用附件规范。

### G01-empty · 网关申请真实空列表
- **形态/状态**：state；仅有可复用模式，未成图，不计独立覆盖。
- **职责**：区分尚无申请和筛选没有结果。
- **内容**：当前筛选；无记录原因；开始申请或清除条件。
- **动作**：开始；清除筛选。
- **关键状态**：真实空列表/筛选空分支。

### G02-read-failure · 申请详情部分读取失败
- **形态/状态**：state；仅有可复用模式，未成图，不计独立覆盖。
- **职责**：状态、定稿、邮件分区独立失败不串客户。
- **内容**：申请身份；失败区域；已读部分保留；重试。
- **动作**：重试当前区；返回。
- **关键状态**：局部读取失败。

## 共用覆盖层与不能用复用掩盖的空缺

- **O-C04-save-failure / O-A04 / O-A05** → 个人/企业/银行编辑、企业状态、关联更换、人工纠正和处理记录：复用保留输入、失败不记归因、未保存确认、并发冲突组件。**不可**：以通用保存失败代替O-G04申请定稿原子保存未知或单在办并发专有状态。
- **O-C07 / O-C07-upload-states / O-C08 / O-C08-preview-unavailable / O-C08-preview-unsupported / O-C09 / O-C10** → 客户所属资料、C09当前补充证明：复用同一文件记录与覆盖层。**不可**：定稿预览必须新画只读形态；不得复用带替换/移除按钮的当前文件图冒充定稿。
- **C02-not-found / C02-forbidden / C01-loading / C01-search-empty / C01-read-failure** → 业务列表/详情：空/加载/部分失败组件与安全返回原则可复用。**不可**：未绘制G01/G02等正常主体不能因为有通用状态图宣称已完成；全局A05/A06/A07也不能以客户页替代。
- **A01** → 所有新主页面：复用全局导航、配色、标题和身份布局。**不可**：壳中的菜单文字不是登录、个人菜单、搜索或助手已经画出的证据。

## 权限与未确定事项

- **申请负责人指定/改派**（旧规则未明确全部权限）：O-G04现图已有设置；新G02明确当前负责人及定稿当时负责人，不恢复客户负责人。暂不恢复O-C06或默认新增改派；如主设计决定补改派，需标为管理员场景设计假设并独立出图，不能写为已确认旧功能。
- **删除权限**（管理员已确认，非管理员边界待定）：新图使用管理员安全场景；不将最后操作人视为删除授权，不默授准备期员工删除权限。
- **当前补充证明**（C09现图已有落点提案，尚缺可管理列表）：本盘点提出C09-current-proofs抽屉补实际目标，仍是客户当前资料共用记录，不新增独立材料导航或多版本申请定稿。
- **审批词映射**（页面语言非后台枚举设计）：以已记录证据显示待补件/审核中/等待回复/获批/拒绝/结束；不推断平台实时状态。
- **授权与完成**（用户授权继续整个静态原型，不等于所有历史修图逐像素批准）：复用catalog current路径作为有效设计基线；新增画完后复核，不将设计文件存在称为已实现/上线。

## 已取消或暂挂，不恢复

- C06：独立材料页已取消。
- C11/O-C01：无驾照手工建档已取消。
- O-C06：固定客户负责人调整废止；申请改派未自动继承。

## 风格与只读样图检查

- 基准为用户提供的 C01 配色图：白底、深海军蓝按钮、近黑墨蓝标题、灰蓝辅助，不能将全部文字染成亮蓝。
- 当前申请与客户完成双状态；准备阶段无客户负责人；资料页只显示操作人。页签为概览/个人/企业/银行/网站与邮箱/材料审核/网关申请/资料操作归属，无独立材料。
- 本次只读查看 O-G04 开始申请、C09 有在办、C04 企业资料三张现行图，确认申请负责人、定稿摘要、无客户负责人和字段归因均有落点。未重新逐像素审查全部 54 张，不能声称全套视觉重验通过。
- O-G04 现图定稿仅摘要：它不能替代 G02 定稿完整浏览及定稿附件只读预览。
- 6 张 W02/W04布局备选由主任务管理，本盘点不修改或选定；W03不动。

## 证据与验证

- 来源优先级：最新范围调整 01–04 > 当前 catalog > 历史清单与完成记录。旧清单中的客户负责人/手工建档/材料独立页不照搬。
- [原页面清单](../../application-page-inventory-v1.md)、[模块分组](../../prototype-groups-v1.md)、[现行图目录](../../customer-ui-consistency-20261017/catalog.json)、[客户完成覆盖记录](../../customer-management-completion-v1/coverage-status.md)。
- 文件存在校验：54/54；catalog SHA-256 匹配：54/54。没有修改这些证据文件。
- 本文件和 JSON 都是新文件，无覆盖原文；如回退，仅移除这两份新增计划文件即可，原图与业务系统均不受影响。

