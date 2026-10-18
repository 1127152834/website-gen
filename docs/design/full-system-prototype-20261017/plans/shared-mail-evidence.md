# 跨模块共享邮件证据与历史操作人

日期：10/17/2026（America/Los_Angeles，所有时间为 PT）  
范围：静态 DEMO 的网关 G 模块与邮件 M 模块对齐；不是实际邮件、服务商结果或平台提交证据。

## 1. 唯一编号与对应关系

| 证据 ID | 对应模块来源 | 申请 | 收件时间 | 身份与主题 |
|---|---|---|---|---|
| E-001 | 邮件模块来源 B；网关有效获批证据 | Stripe · APP-001 | 10/12/2026 14:20 PT | decisions@stripe-demo.example；Decision for APP-001 |
| E-101 | 邮件模块来源 A | PayPal · APP-002 | 10/17/2026 09:18 PT | review@paypal-demo.example；Additional documents requested for APP-002 |
| E-102 | 网关模块后续独立来信 | PayPal · APP-002 | 10/17/2026 09:20 PT | 主题 Additional statements for APP-002；不凭空补发件人 |

三封均关联 Alex Morgan · C001 / Northline LLC / hello@northline.example。网站 northline.example。**E-101 与 E-102 是两封邮件，不是同一封邮件的两个版本或两套译文。**

## 2. E-001：同一份 Stripe 有效获批依据

- 来源 B 与 G 模块 E-001 是同一证据；首次有效获批/证据时间统一为 **10/12/2026 14:20 PT**。
- 原文逐字保留：

> Application APP-001 has been approved effective 10/12/2026. No additional documents are requested.

- 该证据支撑 APP-001 已获批，以及 Alex 客户已完成；不表示 PayPal APP-002 获批。
- **09/28/2026 10:00 PT 是 APP-001 开始时间，保持不变**，不是获批时间。
- 页面只显示 10/12/2026 日期可接受；若显示时间，必须是 14:20 PT，不能沿用已纠正的 10:00 PT。
- 材料附件自身的 10/12/2026 日期、其他客户获批及人工操作时间不因本次对齐而改变。

## 3. E-101：M 模块来源 A，09:18

主题：Additional documents requested for APP-002

原文逐字保留：

> For application APP-002, please reply with the most recent business bank statement and one current inventory photo. We will continue review after receipt.

只可提取：
1. 最近一期企业银行流水。
2. 一张当前库存照片。

不补月份、格式、截止日期、获批概率或提交入口。不能把 E-102 的 July–September 要求挪进 E-101 原文、译文或这封邮件的单项要求。邮件模块的陈佳在 10/17/2026 09:31 PT 纠正标签的演示仍保留原归因，不改成李敏。

## 4. E-102：G 模块后续另一封邮件，09:20

主题：Additional statements for APP-002

原文逐字保留：

> Please provide bank statements for July, August, and September 2026.

只可提取：
- 提供 07/2026–09/2026 银行对账单。
- 对应网关要求 REQ-01；原文未注明截止时间，不额外推算。
- 此封没有要求库存照片；不能把 E-101 的库存要求挪入该封原文。
- G 模块既定 09:20 新证据推进申请的事件继续以 E-102 为依据。E-101 在 09:18 收到，不等于系统在 09:18 已应用状态更新；邮件收取、分析/人工纠正与申请状态更新应分别归因。

两项明确来信要求可以并存；没有来源证据就不自动视为替代、撤销、合并或完成另一项。页面若做跨邮件汇总，每项保留自己的证据 ID 与原文入口。附件份数、上传/关联成功、记录已发送，都不等于平台确认收妥或申请获批。

## 5. 状态与独立场景边界

- Alex 的有效 Stripe APP-001 不因 APP-002 待补件、人工纠正或结束而失效。
- E-100 仍是 10/16/2026 17:00 PT 的误判材料收妥邮件，不与 E-001/E-101/E-102 混用。
- 正常 Casey APP-003 的 E-300 纠正与 E-301 首次有效获批是另一客户的独立演示，不套入 Alex 的邮件证据。
- 原文只读；译文、AI 摘要、处理标记都不能替换原文。邮件正文只作为安全本地纯文本，不访问外链或加载远程图片。
- 以上是静态一致性约定，不声称实际 AI 分析、状态自动推进或平台结果已验证。

## 6. 历史操作人不是当前用户列表示例的全集

- 王芳：APP-001 申请负责人、既有库存照片/银行文件操作人等历史演示归因保持原样。
- 陈杰：other-proof-demo.pdf 的操作人保持原样。
- 陈佳、王磊、李敏：当前用户管理三人演示及其邮件操作按原场景保留。
- 不能为了让当前用户列表只显示三人，就将旧记录中的王芳或陈杰替换成陈佳；不同姓名不是可互换的占位符。
- 此处不推定王芳/陈杰目前启用、停用或已离职，不新增账号及权限规则。当前用户列表的展示范围与既有记录归因不同。
- 准备资料无固定客户负责人；申请负责人、当前文件/字段操作人与系统邮件 AI 来源仍分别展示。

## 7. 来源、改动和回退

只读对照：
- [other-module-demo-data.md](other-module-demo-data.md) §3.2–3.3：来源 A 的 09:18 原文、来源 B 的 14:20 批准原文。
- [gateway-demo-data.md](gateway-demo-data.md) §2：E-001/E-100/E-102 与 APP-001 开始时间。
- [gateway-scenes.json](../prompts/gateway-scenes.json)：G01/G02/O-G10 的 APP-001 批准时间约束。
- [gateway-state-scenes.json](../prompts/gateway-state-scenes.json)：结束后保护场景沿用同一有效获批时间。

本次仅修改上述三个网关文件，新增本说明；other-module-demo-data.md 与 other-modules-scenes.json 不修改。历史审阅/队列中的 SHA-256 是其创建时基线，不是本次修改后指纹。

写入前完整备份：[gateway-mail-evidence-20261017T135642](../backups/gateway-mail-evidence-20261017T135642/manifest.json)。备份三文件逐个 SHA-256 与修改前源文件相同。回退时只从该目录恢复 manifest 对应的三个文件，移除此新增说明；不要改邮件模块文件、现有图或主索引。
