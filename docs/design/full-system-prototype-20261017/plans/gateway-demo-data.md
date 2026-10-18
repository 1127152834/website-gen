# 网关模块 DEMO 数据与场景约定

日期：10/17/2026（America/Los_Angeles）  
范围：仅静态图提示词与场景数据。配套 [gateway-scenes.json](../prompts/gateway-scenes.json) 共 **21 条**，不含 A 全局模块；没有生成图片、应用代码或真实服务调用。

## 1. 基准与当前授权边界

- 此轮网关图采用下面明确的一套 DEMO 编号与日期；旧客户图中的 DEMO-PP-1048 等历史截图保留原件，不把旧快照混作本轮同一时间的数据。
- 一客户一企业一网站一商业邮箱；准备资料不设客户负责人，具体申请才有“申请负责人”。
- 只有一条正常在办；开始是系统保存申请记录和时点定稿，不是已向支付平台成功提交。
- AI材料审核仅参考，未审核/执行失败/有风险可人工知悉继续；权限和唯一在办约束仍有效。
- 原邮件依据、人工纠正、后续新邮件可推进三者并存。旧邮件重放不覆盖已有人工纠正。
- 当前字段、每份附件仅保留最后成功操作归因；表述一律“操作人”，不可在表单代填。
- 定稿只读，实际字段和文件内容连同当时归因固定；当前资料后续变化不重写。
- 不新增申请负责人改派，不恢复 O-C06。
- 不显示真实或完整 SSN；出现该项时用“未展示 · DEMO”。EIN仅用“DEMO-EIN”，所有文件预览使用明显DEMO占位内容。
- 日期显示 MM/DD/YYYY；所有时间 PT；“07/2026–09/2026”是原邮件明确的完整月份，不是自动推断。

## 2. Alex 主场景

| 项 | 固定值 |
|---|---|
| 客户 | Alex Morgan · C001 |
| 企业 | Northline LLC |
| 网站 | northline.example |
| 商业邮箱 | hello@northline.example |
| 企业地址 | 260 Demo Blvd, Austin, TX 78702 |
| 客户状态 | 已完成，依据有效获批 Stripe APP-001 |
| 后续在办 | PayPal APP-002，唯一正常在办 |
| 申请负责人 | APP-001：王芳；APP-002：李敏 |

### 申请

| 编号 | 平台 | 开始时间 | 当前状态 | 有效结果 |
|---|---|---|---|---|
| APP-001 | Stripe | 09/28/2026 10:00 PT | 已获批 | 10/12/2026 14:20 PT 获批仍有效（E-001） |
| APP-002 | PayPal | 10/16/2026 14:00 PT | 待补件 | 仍在办，无有效获批 |

APP-002状态历史：

1. 10/16/2026 14:00 PT：李敏保存内部申请和定稿。
2. 10/16/2026 17:00 PT：邮件 E-100 被错误识别为获批。
3. 10/16/2026 17:10 PT：李敏依据原文纠正为审核中。Alex仍有APP-001有效获批，客户仍已完成。
4. 10/17/2026 09:20 PT：新邮件 E-102明确请求对账单，推进为待补件。
5. 后续重复处理 E-100：未再次应用，不回退或覆盖纠正。
6. 10/17/2026 10:30 PT：OUT-201是单独的后续“已发送回复”处理示例，不代表平台认可、不把申请改获批。

### 明确邮件证据

| 邮件/事件 | 时间 | 原文或身份 |
|---|---|---|
| E-001 | 10/12/2026 14:20 PT | APP-001 的有效 Stripe 获批证据，独立保留；同邮件模块来源 B，见[共享邮件证据](shared-mail-evidence.md) |
| E-100 | 10/16/2026 17:00 PT | “Your documents have been received. Your application remains under review.” 不是获批 |
| E-101 | 10/17/2026 09:18 PT | 邮件模块来源 A：最近一期企业银行流水＋一张当前库存照片；与 E-102 是两封独立邮件，原文见[共享邮件证据](shared-mail-evidence.md) |
| E-102 | 10/17/2026 09:20 PT | 主题 “Additional statements for APP-002”；原文 “Please provide bank statements for July, August, and September 2026.” |
| REQ-01 | 来源E-102 | 提供07/2026–09/2026银行对账单；邮件未注明期限 |
| OUT-201 | 10/17/2026 10:30 PT | 由hello@northline.example发出的虚构回复记录，只用于“记录已发送”示例 |

E-101与E-102的原文、明确要求及处理记录独立保留；不得互换或用其中一封覆盖另一封。APP-001的09/28/2026 10:00 PT是申请开始时间，不是获批时间。

只显示来源已有明确要求，不推测下一步、缺哪月、平台获批概率。当前资料中有两份流水并不自动满足整项要求，也不能由文件份数推出审核结论。

## 3. APP-002 时点定稿及当前资料

- 定稿时间：10/16/2026 14:00 PT。
- 定稿确认操作人：李敏。
- 当时申请负责人：李敏。
- 当前申请负责人同为李敏，不绘制改派场景。
- 摘要：26项字段、9份附件。首屏仅展示所选分类，不伪装已经一次显示全部项目。
- 9份附件归类：驾照正面1、企业文件2、银行文件3、补充证明3。
- 银行文件：介绍信1、bank-statement-2026-07.pdf、bank-statement-2026-09.pdf。
- 预览示例文件 bank-statement-2026-07.pdf：当时文件操作人王芳，10/02/2026 10:30 PT；PDF为明显DEMO占位纸张，不模拟真实银行机构/真实身份证。
- 10/17/2026当前档案允许替换对应附件；旧定稿仍使用原文件内容和当时归因。不能只是一个指向可变当前附件的链接。
- 时点定稿没有编辑、上传、替换、移除、删除或恢复版本按钮；仅复制、查看、单文件下载。
- 客户当前补充证明抽屉可编辑当前文件，是共享客户资料记录，而非当前PayPal申请的独占副本。

当前补充证明三行：

| 文件 | 类别 | 当前操作人 | 日期 |
|---|---|---|---|
| fulfillment-agreement-demo.pdf | 履行协议 | 李敏 | 10/12/2026 |
| inventory-demo.jpg | 库存照片 | 王芳 | 10/15/2026 |
| other-proof-demo.pdf | 其他证明 | 陈杰 | 10/16/2026 |

上述王芳、陈杰属于既有记录的原始演示归因；不得为了与当前用户管理三人示例一致而替换成陈佳。当前用户列表示例不是所有历史操作人的全集。

## 4. Casey 正常纠正场景（与Alex分开）

| 项 | 固定值 |
|---|---|
| 客户 | Casey Parker · C005 |
| 企业 | Meadow Home LLC |
| 网站 | meadow-home.example |
| 商业邮箱 | hello@meadow-home.example |
| 申请 | Stripe APP-003 |
| 申请负责人/纠正操作人 | 李敏 |
| 误判 | 10/17/2026 11:00 PT被记为已获批 |
| 原邮件 | E-300：“Your documents have been received. Your application remains under review.” |
| 纠正 | 10/17/2026 13:20 PT，已获批→审核中 |
| 其他有效获批 | 0 |
| 其他在办 | 0 |
| 成功纠正后的客户状态 | 未完成 |

用于O-G05与O-G05-approved-correction-result。这个场景没有APP-004。不能把Casey“未完成”的结果套给Alex，因为Alex仍有APP-001有效获批。

## 5. Casey 在办冲突独立分支

仅用于O-G09，**不与第4节作为同一连续截图**：

- APP-003 Stripe在11:00被误判已获批。
- 后续APP-004 Zen Payments于10/17/2026 12:00 PT开始，申请负责人王芳，当前审核中，是已生效在办。
- 员工拟把APP-003纠正为审核中；提交前检查会产生两条在办。
- 当前图是**纠正预检查冲突，纠正尚未应用**：输入的理由和证据保留，但不声称已保存成功，也不静默改出第二条在办。
- 显示“纠正生效后客户状态将重算为未完成”的影响预览，不把它写成已发生结果。
- “应用纠正”禁用；明确查看现有在办申请，通过单独的人工终止/撤回确认或取消当前纠正处理冲突。
- 不自动结束、删除、改派任何申请；不允许第三次开始。此处不引入新负责人权限规则。
- 这一区分采用本轮明确的“先处理唯一在办约束”要求；历史coverage的“纠错后的冲突”标题不表示可以先静默制造双在办。

## 6. 开始过程的两个独立状态

### O-G04-concurrent

与APP-002创建时同一逻辑阶段：李敏的申请和定稿已先成功生效，另一个并发请求未创建第二条记录。显示既有APP-002，提供“打开已生效申请”，无立即重试/绕过。阻断原因是唯一在办，不是AI审核。

### O-G04-unknown

是APP-002创建的响应未知截面，不是已经在办后又发起第二次：

- 请求标识REQ-START-002；拟创建APP-002需明确“待核实”。
- 申请记录与资料定稿均“结果未知”；不报确定失败、成功或第二条在办。
- 先核实申请和定稿是否共同保存成功；核实前禁止重新开始。
- 不把客户当前资料原值/人员归因提前刷新成成功。

## 7. 有限公共状态取舍

- G01-empty本轮画**筛选无结果**，不是全系统无申请：选择“已拒绝”，两条Alex记录均不匹配，保留筛选、显示0条和清除筛选。这样不会与已存在APP-001/APP-002矛盾。
- G02-read-failure只让定稿摘要读取失败，客户/申请身份和已读取状态保留；不能把读取失败改写成“没有定稿”或“0附件”。
- 只画本清单明确的一个状态截面；不能以21张计划声称所有失败组合、所有平台、所有权限或全部移动端状态已经覆盖。

## 8. reference_kind 与生成时参考图

common-style.txt由主任务统一追加，JSON不重复整套配色、菜单和字号规则。所有屏均为1490×1056单独界面，非拼图。

| reference_kind | 参考用法 |
|---|---|
| gateway_workspace / gateway_workspace_empty | 先使用W03应用壳＋用户C01配色；G01完成后空状态引用G01 |
| gateway_detail / gateway_detail_state / gateway_detail_result / gateway_detail_partial_error | 首张G02使用C09现行申请头部；后续使用新G02，分别替换选中页签或独立客户身份 |
| gateway_drawer / correction_drawer / current_proofs_drawer | 复用现有O-C宽抽屉样式，背景为对应G02或C09；不能露出错误客户身份 |
| gateway_modal / gateway_conflict_modal / gateway_unknown_modal | 复用O-G04模态外观；每图一个前景覆盖层、背景对应同一对象 |
| snapshot_preview_drawer | 参考现有O-C08预览结构，但明确改为定稿只读，不能保留替换/移除入口 |

推荐参考实际文件：
- docs/design/group-02-customer-onboarding/references/C01-user-color-reference-20261017.png
- docs/design/group-03-website-management/W03-site-configuration-v1.png
- docs/design/customer-ui-consistency-20261017/corrected/links/C09-applications-active-v2.png
- docs/design/customer-ui-consistency-20261017/corrected/links/O-G04-start-application-v2.png
- docs/design/group-01-customer-dossier/O-C08-preview-v2.png

## 9. 提示词清单与校验

英文词数按拉丁词token计，中文确切文案另附；全部180–260词之内。

| ID | 标题 | reference_kind | 英文词数 |
|---|---|---|---:|
| G01 | 网关申请工作台 | gateway_workspace | 214 |
| G02 | 单次申请详情概览 | gateway_detail | 211 |
| G03 | 申请邮件与明确要求 | gateway_detail | 214 |
| G04 | 申请状态与纠正记录 | gateway_detail | 212 |
| G02-snapshot | 申请时点定稿 | gateway_detail | 223 |
| O-G-snapshot-preview | 申请定稿附件预览 | snapshot_preview_drawer | 222 |
| O-G05 | 人工更新或纠正申请状态 | correction_drawer | 229 |
| O-G06 | 结束本次申请确认 | gateway_modal | 233 |
| O-G07 | 邮件与申请关联确认 | gateway_drawer | 229 |
| O-G08 | 明确要求与处理记录 | gateway_drawer | 229 |
| O-G09 | 纠正前的在办冲突 | gateway_conflict_modal | 234 |
| O-G10 | 事项身份确认与误归组拆分 | gateway_modal | 235 |
| O-G11 | 分类与待办纠正 | gateway_drawer | 231 |
| O-G12 | 要求处理结果记录 | gateway_modal | 227 |
| O-G04-concurrent | 申请开始并发冲突 | gateway_conflict_modal | 233 |
| O-G04-unknown | 申请与定稿保存结果未知 | gateway_unknown_modal | 229 |
| O-G05-approved-correction-result | 唯一获批被纠正后的结果 | gateway_detail_result | 232 |
| G04-new-email-after-correction | 人工纠正后的新邮件推进 | gateway_detail_state | 224 |
| C09-current-proofs | 当前客户补充证明 | current_proofs_drawer | 230 |
| G01-empty | 网关申请筛选无结果 | gateway_workspace_empty | 235 |
| G02-read-failure | 申请详情部分读取失败 | gateway_detail_partial_error | 239 |

JSON每条仅包含id、title、prompt、reference_kind、required_states。覆盖21个当前缺失G/O-G/C09目标，没有恢复C06/C11/O-C01/O-C06，没有A模块任务。

## 10. 本次文件边界与回退

仅新增本文件与prompts/gateway-scenes.json。未修改coverage原文、已出图、common-style、应用源码或其它代理文件。两文件此前不存在；回退本次提示词工作只需移除这两份新增文件，原图和系统不受影响。

