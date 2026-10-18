# 客户管理 · 页面和状态覆盖清单

10/17/2026 · [返回图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

## 结论

本次盘点发现 **11 个未画的独立客户界面 + 4 个直接操作面板**。现已补出，并补充归因与主要异常状态：**37 张新增 PNG**。下面 12 个有效客户主页面编号、14 个客户覆盖层编号均有静态图；另有 4 个 O-G 客户直接操作、2 个 O-A 共用面板。O-C04 含三类表单，编号与张数不等同。

“有图”只表示设计覆盖，不表示用户已确认、页面代码已完成、链接已经可点或真实业务测试通过。未把取消项当成缺页，也未把全应用剩余工作冒充完成。

## 当前有效编号

| 编号 | 职责 / 主参考 | 本轮结果 | 状态图册 |
| --- | --- | --- | --- |
| C01 | [客户列表与速览](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png) | 保留上传驾照统一入口；新增空、搜索空、加载、速览读取失败 4 态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |
| C02 | [档案概览](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v2.png) | 原图保留；新增不存在、无权限 2 态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |
| C03 | [个人资料](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v3.png) | 原图保留；驾照与当前住址分开、仅显示上传状态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| C04 | [企业资料](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-company-v2.png) | 原图保留；复用编辑/附件异常 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| C05 | [银行资料](F:/projects/website-gen/docs/design/group-01-customer-dossier/C05-bank-v2.png) | 原图保留；新增附件操作异常 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| C07 | [网站与邮箱](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C07-website-mail-v1.png) | 新增独立主面板及关联、解除、公开信息对照 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| C08 | [材料审核](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C08-review-v1.png) | 新增独立主面板及范围、运行、发现详情 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| C09 | [网关申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C09-applications-active-v1.png) | 新增在办/无在办两态及开始申请面板 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| C10 | [资料操作归属](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-attribution-v2.png) | 银行原图保留；新增个人两页、企业及字段归因详情 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |
| C12 | [上传驾照](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png) | 原正常态保留；新增混合上传状态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) |
| C13 | [核对识别结果](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v3.png) | 原正常态保留；新增有原图的人工转录失败分支 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) |
| C14 | [建档结果](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C14-creation-results-v2.png) | 原成功/明确失败保留；新增结果未知待核验 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) |
| O-C02 | [重复线索处理](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/O-C02-duplicate-v1.png) | 新增；人工决策，不自动合并 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) |
| O-C03 | [字段差异确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/O-C03-differences-v1.png) | 新增；逐项选择，未识别不清空 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) |
| O-C04 | [三类资料编辑](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v3.png) | 原个人/企业/银行三图保留；新增保存失败、复用离开/并发 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C05 | [企业办理状态](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v2.png) | 原正常态保留；失败与未保存按共用规范，不再重复画 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |
| O-C07 | [上传附件](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v2.png) | 原正常态保留；新增五类队列状态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C08 | [当前附件预览](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v2.png) | 原正常态保留；新增读取失败与不支持格式 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C09 | [替换附件](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v2.png) | 原正常态保留；新增失败保留旧文件 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C10 | [移除附件](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v2.png) | 原正常态保留；新增失败状态 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C11 | [关联网站](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C11-link-site-v1.png) | 新增；当前/空闲/他人占用资源分开 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-C12 | [关联商业邮箱](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C12-link-mail-v1.png) | 新增；更换前原关联保持 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-C13 | [解除/更换关联确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C13-unlink-confirm-v1.png) | 新增解除确认；更换确认在 O-C11/O-C12 同一抽屉完成 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-C14 | [公开信息对照](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C14-public-info-v1.png) | 新增；当前档案值与读取到的线上值严格区分 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-C15 | [删除客户确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C15-delete-confirm-v1.png) | 新增；管理员场景与明确影响范围 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-C16 | [删除执行/结果](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C16-delete-execution-v1.png) | 新增；部分失败/未知，不报全成功 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) |
| O-G01 | [检查范围](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G01-review-scope-v1.png) | 新增；客户材料审核直接操作 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-G02 | [审核运行](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G02-review-running-v1.png) | 新增；执行与检查结论分层 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-G03 | [发现详情](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G03-finding-detail-v1.png) | 新增；来源/证据/未覆盖规则明确 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-G04 | [开始申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G04-start-application-v1.png) | 新增；申请负责人在此指定 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) |
| O-A04 | [未保存离开](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/O-A04-unsaved-v1.png) | 新增共用；输入不丢失，放弃须明确 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |
| O-A05 | [并发修改](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/O-A05-conflict-v1.png) | 新增共用；保留输入，禁止静默覆盖 | [查看](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) |

原 O-C04 另两张正常表单：[企业](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-company-edit-v2.png)、[银行](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-bank-edit-v2.png)。

## 关键状态覆盖与复用

| 场景 | 实际 PNG | 复用边界 |
| --- | --- | --- |
| 正常列表与速览 | C01 v4 原图 | 不改原布局；只有驾照上传入口 |
| 尚无客户 / 搜索无结果 / 加载 / 速览读取失败 | C01 四张新增状态 | 失败样例为列表正常、右侧详情失败；全列表失败可复用容器但未另画，不冒充各个列表均有单独图 |
| 对象不存在 / 无权访问 | C02 两张新增状态 | 不显示遗留个人数据；不是新的员工数据隔离策略 |
| 表单保存失败 | O-C04 新增 | 企业/银行/状态表单复用保留输入、原正式值、失败不记人规则 |
| 未保存离开 / 并发冲突 | O-A04 / O-A05 新增 | 表单、核对、关联等编辑复用；不自动覆盖，不盲目重试副作用 |
| 上传等待/进行/成功/失败/取消 | C12、O-C07 各一张混合列表 | 分文件状态，成功归因；非所有排列组合 |
| OCR 失败 / 无可用原图 / 待人工确认 | C13 人工转录及其队列 | 人工转录只依附成功上传的原图，不能跳过驾照 |
| 重复 / 差异 | O-C02 / O-C03 新增 | 先暂存员工选择，再按正式提交结果写入 |
| 建档结果明确失败 / 未知 | 原 C14 v2 / 新 C14 unknown | 明确失败才重试；未知先核验，不能创建重复客户 |
| 附件读取失败 / 不支持格式 / 替换失败 / 移除失败 | O-C08 两图、O-C09、O-C10 新增 | 异常不是文件从未存在，也不提前更新操作人 |
| 审核未检查/发现问题/变更待复核/执行失败 | C08 / O-G02 / O-G03 新增 | 只是参考，不等同平台拒绝或保证获批 |
| 有/无在办网关 | C09 两图 | 同时只允许一条在办；后续申请不覆盖已有有效获批 |
| 删除部分成功/失败/未知/按规则保留 | O-C16 新增 | 逐步骤核验；已删档案不继续展示，不将未知报成功 |

## 一致性检查要点

- 两个个人地址独立；企业地址统一沿用 C04 示例 `260 Demo Blvd, Austin, TX 78702`。网站线上值必须实际读取后才称为已知。
- 日期使用美国格式；州缩写配灰色全名。未单画日历弹层和每个下拉展开态；遵循已确认个人编辑抽屉的规范。
- 当前字段/文件归因仅记录最后成功操作人；上传、AI发起、人工确认、申请负责人不混用。个人 20 项分两页，企业 11 项，银行 6 项沿用旧图。
- 所有后续申请与当前档案各自关联同一客户；每次申请定稿不可因当前资料修改被覆盖。未做审核或有问题可人工知悉后开始申请。
- 已获批误判被纠正时，按剩余有效获批结果重新计算客户完成状态；不得因“后续申请不影响已完成”忽略此规则。
- 其他证明在 C09 当前资料区暂放；属于客户当前资料而非单次申请专属，位置仍待确认。

## 不在本轮完成声明内

- 全局网关 G01–G04、申请定稿完整只读浏览、邮件来源与人工纠正详情、其余 O-G05–O-G12：后续网关模块；客户页只保留入口，不声称有图或实现。
- 完整建站 W、邮箱 M、资源/表格/系统设置与登录模块：后续各组；本轮仅处理客户直接关联。
- 手机/窄屏、所有筛选组合、每个日历/下拉、所有成功Toast和全量异常组合：没有逐项另画，应用共用规范，不写“全状态完整”。
- 权限细则尚待业务确认：非管理员删除、申请负责人指定和改派；不擅自恢复客户负责人。
- 真实 OCR、上传、保存、AI、资源关联、删除、网关状态推进，以及所有代码与交互测试均未执行。

## 已取消或暂挂

- C06 独立材料页：取消，附件仍在所属页。
- C11 / O-C01 无驾照手工建档：取消，单张/多张统一上传驾照正面。
- O-C06 固定客户负责人调整：旧用途废止；不冒充申请改派设计。

本清单是最新覆盖记录；原历史清单和原型的审批时点不被改写。
