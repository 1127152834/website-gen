# 邮件模块绘制前只读预检

日期：10/17/2026 PT。已读 `plans/other-modules-render-order.json`、邮件16条主提示、ES01–ES04、other-modules-coverage、other-module-demo-data与shared-mail-evidence。仅新增本记录，不修改提示词/总索引/图，不访问真实邮件或外部服务。

## 绘制顺序：保持现有依赖，四组各4张

| 组 | 顺序 | 最合适的内容底图与现有样式参考 |
| --- | --- | --- |
| 1 邮箱到证据 | M01 → M02 → M03 → M05 | M01用下方R1应用壳+R2配色；M02必须用通过后的M01，M03用M02，M05用M03。先确定同一邮箱/邮件，再画AI建议。 |
| 2 事项与操作 | M06 → M07 → M08 → M04 | M06/M07基于M05；M08基于M03邮件模块壳；M04基于M03，表单覆盖层样式参考R3。M08是已在清单中的历史补审，不是本次新增页面。 |
| 3 凭据与删除边界 | O-M01 → O-M02 → O-M04 → O-M05 | O-M01/O-M02/O-M05以已通过M01为底；O-M04以M02为底。现有R3只借凭据表单样式，R4只借确认弹窗/灰遮罩，不复制SMTP或网站恢复业务。 |
| 4 翻译、同步、确认 | O-M06 → O-M07 → O-M08 → O-M09 | O-M06以M03内嵌展开，不能灰遮罩；O-M07用M01+R5抽屉样式；O-M08以M04为底，O-M09以M08为底；R4仅作确认层样式。 |

四组为现有sequence 1–16连续分组，不调换依赖。O-M03是M04别名，不另画。主图后若接着画已有关键状态，建议第5组4张：ES01切换加载(M02) → ES02发送未知(M04/O-M08) → ES03证据冲突(M05/M03) → ES04关联保护(O-M05/M01)。ES08为专用AI设置停机，留设置模块，不混进邮件主视图。

### 已存在且已核验路径的参考

- **R1 应用壳/A01：** `F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png`
- **R2 用户配色：** `F:/projects/website-gen/docs/design/group-02-customer-onboarding/references/C01-user-color-reference-20261017.png`（只借白底深蓝，不复制旧手工建档入口）
- **R3 凭据表单/弱灰遮罩样式：** `F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/O-W13-v2.png`
- **R4 确认弹窗/弱灰遮罩样式：** `F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/O-W10-v2.png`
- **R5 右抽屉样式：** `F:/projects/website-gen/docs/design/full-system-prototype-20261017/screens/O-W08-v1.png`

预检时M01–M08尚无PNG，不能把计划`.../screens/M01-v1.png`等当现有文件。每一组内仍应逐张生成/复核，再将通过版本路径传给后继；若修为v2，则引用v2，不固定使用首稿。网站图只作视觉样式，不用W10交易SMTP页假装邮箱收件管理。所有提示都需拼入common-style实际文本，文件名引用不会自动加载文件内容。

## 发现的实际冲突与出图约束

1. **O-M06存在确定形态冲突。** 清单和coverage均为`embedded-panel`/邮件翻译展开区；提示正文却要求white overlay/gray scrim，`reference_kind`也是覆盖层。出图应采用M03阅读区内部原文/译文分区或标签，不遮罩整页、不生成独立确认弹窗。此记录只指出冲突，未改提示。
2. **O-M05对象已有关联，不可画可用永久删除。** 固定hello@northline.example关联Alex/APP-002，动作列表里的“输入确认/永久删除”只是多状态库存，不能全部当当前可用。该对象应画明确关联阻止、永久删除禁用、查看关联/取消；这项是一期目标，不代表源码保护已实现。若与ES04完全同态，可由根任务决定复用同图覆盖两ID，不能为了凑两张假造无关联。当前预检不改alias或总计数。
3. **来源映射与授权分支不完整内嵌于逐页提示。** E-101/E-102隔离及M05–M07“此前授权开启后历史快照”在配套文档，单独发送场景提示未必带上。每次生成应明确附下节数据，不能指望ImageGen读取提示中提及的本地Markdown。M06未关联时APP-002只能是候选，不能先把候选画成已确认归属；ES03冲突标签不得自动更新申请。
4. **O-M02需只选一个动作态。** 本张推荐远端密码重置前确认；不要将“确认显示/隐藏”和“确认重置”全部同时画成主动作。若选择显示密码态，则不能将远端密码立即失效写成显示动作的后果。凭据拒绝与网络故障也不可合并断因。

未发现需要改变既定业务目标、重排主依赖或添加新能力的其他硬冲突。

## 逐次生成必须携带的最小一致性数据

- 统一对象：Alex Morgan/C001、Northline LLC、northline.example、hello@northline.example；侧栏李敏·管理员。APP-001 Stripe已获批支撑客户已完成，APP-002 PayPal待补件不覆盖首次有效获批。
- **E-101（来源A）：** 10/17/2026 09:18 PT，review@paypal-demo.example，主题`Additional documents requested for APP-002`。原文：`For application APP-002, please reply with the most recent business bank statement and one current inventory photo. We will continue review after receipt.` 只提取最近一期企业银行流水和一张当前库存照片；不添加月份、截止、格式、上传入口。
- **E-102是另一封：** 10/17/2026 09:20 PT，主题`Additional statements for APP-002`；原文`Please provide bank statements for July, August, and September 2026.` 不补未知发件人；只对应07–09/2026对账单，不加入库存要求。两封可并存，不能无证据替代/合并；09:18收取不代表09:18已推进申请状态。
- **E-001（来源B）：** decisions@stripe-demo.example，`Decision for APP-001`，10/12/2026 **14:20 PT**；原文`Application APP-001 has been approved effective 10/12/2026. No additional documents are requested.` 不用09/28开始时间或旧10:00批准时刻。
- 纠正示例仍是陈佳10/17/2026 09:31 PT将一般通知改待补件，不能替换成当前李敏。来源标签/译文不能替代原文，来源ID不得串用。
- 邮箱层级域名→邮箱→文件夹→邮件；收件箱12/已发送8/草稿0/废纸篓1，轮询监听中，最近同步09:42 PT。文件夹数不是当前未读数或AI待确认数，不应机械复用。
- 正文仅安全本地纯文本，URL不激活，不加载远程图片/跟踪像素，不访问正文链接；附件仅显示可人工下载的文件行，不自动打开。来源A未指定随信附件，勿因其要求银行流水/照片便画成来信已经附带这两份材料。
- M04仅未发送草稿，2项“本次回复义务”不是2项已经履行；O-M08只是外发前确认，SMTP接受≠投递≠平台收妥≠获批。不因邮件移到废纸篓自动删除申请或客户。
- M05–M08相关已有分析/补审为独立授权历史或未提交演示，默认关闭设置仍成立；无真实模型、IMAP/SMTP、授权或关联验证声明。工程缺口写证据/图册，不将整页塞满实施说明。

## 文件与回退

本记录新建前确认不存在；无需覆盖备份。五个已有样式参考路径已存在验证。原提示、排序、queue、总索引与图保持不动；若撤回本次预检，仅移除此新增记录即可。结果是绘制准备，不是邮件功能已开发或运行验收。
