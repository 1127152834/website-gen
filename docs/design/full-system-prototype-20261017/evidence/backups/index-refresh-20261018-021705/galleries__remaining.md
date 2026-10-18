# 其余模块静态图册

> 状态：**IN_PROGRESS**；`as_of 2026-10-17T14:11:11-07:00`。有图不等于通过；以每项状态和引用证据为准。

## 证据与整改入口

- [跨模块共享邮件证据](../plans/shared-mail-evidence.md)：邮件与网关证据编号、时间及归因边界。
- [其他模块提示整改说明](../evidence/other-prompts-remediation.md)：助手、权限、模型用途和一期目标态边界。
- [全局缺口队列](../plans/global-gap-queue.json) · [其他模块状态队列](../plans/other-modules-state-queue.json)

## 去重与拆分说明

- `ES09 → A03-forced`：同一首次强制改密状态，仅保留一个待画目标。
- `A03-voluntary → A03`、`O-A01 → A08`：沿用已核实语义 alias，不重复计数。
- `A01-session-expired` 与 `A01-identity-recheck-failed` 已拆为两个独立 pending 状态，不再用一张合并会话图双算。

## 当前图

### O-A04

**O-A04 未保存离开确认**

状态：`reused_prior_static_audit`。

![O-A04 O-A04 未保存离开确认](../../customer-ui-consistency-20261017/corrected/O-A04-unsaved-ui-v2.png)

### O-A05

**O-A05 并发修改冲突**

状态：`reused_prior_static_audit`。

![O-A05 O-A05 并发修改冲突](../../customer-ui-consistency-20261017/corrected/O-A05-conflict-ui-v2.png)

### A01

**通用应用壳**

状态：`reused_prior_static_audit`。

![A01 通用应用壳](../../group-02-customer-onboarding/C12-batch-upload-v4.png)

## 明确复用 alias

| Alias ID | 复用目标 | 说明 |
|---|---|---|
| A03-voluntary | [A03](remaining.md#a03) | 不单独生成或计入待画 |
| O-M03 | [M04](remaining.md#m04) | 不单独生成或计入待画 |
| O-R03 | [R04](remaining.md#r04) | 不单独生成或计入待画 |
| T03 | [S06](remaining.md#s06) | 不单独生成或计入待画 |
| S07 | [A03](remaining.md#a03) | 不单独生成或计入待画 |
| O-S01 | [S02](remaining.md#s02) | 不单独生成或计入待画 |
| O-A01 | [A08](remaining.md#a08) | 不单独生成或计入待画 |
| ES09 | [A03-forced](remaining.md#a03-forced) | Same forced-first-login state as A03-forced; not a second pending image. |

## 尚无图片

| ID | 页面／状态 | 状态 |
|---|---|---|
| A02 | 内部用户登录 | `pending` |
| A03-forced | 首次必须修改密码 | `pending` |
| A04 | 个人菜单 | `pending` |
| A05 | 全局无权限 | `pending` |
| A06 | 全局页面不存在 | `pending` |
| A07 | 全局服务异常 | `pending` |
| A08 | 全局搜索 | `pending` |
| A09 | 全局AI助手 | `pending` |
| O-A02 | 助手工具确认卡 | `pending` |
| O-A03 | 助手新对话确认 | `pending` |
| A01-session-expired | 会话失效或身份复核失败 | `pending` |
| A01-narrow-navigation | 窄屏菜单与主从切换 | `pending` |
| M01 | 邮箱管理主页面 | `pending` |
| M02 | 文件夹／邮件列表 | `pending` |
| M03 | 邮件阅读 | `pending` |
| M04 | 撰写／回复／转发 | `pending` |
| M05 | 邮件预审与关联结果 | `pending` |
| M06 | 待人工确认 | `pending` |
| M07 | 邮件申请事项工作视图 | `pending` |
| M08 | 历史邮件补审 | `pending` |
| O-M01 | 邮箱凭据弹窗 | `pending` |
| O-M02 | 密码显示／重置确认 | `pending` |
| O-M04 | 邮件移到废纸篓确认 | `pending` |
| O-M05 | 删除邮箱确认 | `pending` |
| O-M06 | 邮件翻译展开区 | `pending` |
| O-M07 | 监听／同步详情面板 | `pending` |
| O-M08 | 发信前确认弹窗 | `pending` |
| O-M09 | 补审预览／入队确认 | `pending` |
| R01 | 账号与域名主页面 | `pending` |
| R02 | 选中账号的域名区域 | `pending` |
| R03 | 域名详情 | `pending` |
| R04 | 放弃站点／域名资源 | `pending` |
| O-R01 | 添加 Hostinger 账号弹窗 | `pending` |
| O-R02 | 删除账号确认 | `pending` |
| T01 | Grist 内嵌外壳 | `pending` |
| T02 | Grist 原生文档与表格 | `pending` |
| S01 | 设置／模型厂商 | `pending` |
| S02 | 厂商编辑及模型列表 | `pending` |
| S03 | 设置／用途分配 | `pending` |
| S04 | 设置／商品资料 CJ | `pending` |
| S05 | 设置／邮箱 | `pending` |
| S06 | 设置／Grist | `pending` |
| S08 | 内部用户管理 | `pending` |
| S09 | 设置／邮件 AI 预审 | `pending` |
| S10 | 设置／邮件关联规则 | `pending` |
| O-S02 | 删除厂商确认 | `pending` |
| O-S03 | CJ 凭据弹窗 | `pending` |
| O-S04 | 邮箱默认密码清除确认 | `pending` |
| O-S05 | Grist 凭据／集成操作确认 | `pending` |
| O-S06 | 创建内部用户弹窗 | `pending` |
| O-S07 | 重置用户密码弹窗 | `pending` |
| O-S08 | 启用／停用用户确认 | `pending` |
| O-S09 | 邮件 AI 授权／配置变更确认 | `pending` |
| O-S10 | 关联规则新增／编辑／移除抽屉 | `pending` |
| A03 | 修改密码页 | `pending` |
| ES01 | M02 独立关键状态（ES01） | `pending` |
| ES02 | M04 独立关键状态（ES02） | `pending` |
| ES03 | M05 独立关键状态（ES03） | `pending` |
| ES04 | O-M05 独立关键状态（ES04） | `pending` |
| ES05 | R01 独立关键状态（ES05） | `pending` |
| ES06 | R04 独立关键状态（ES06） | `pending` |
| ES07 | T01 独立关键状态（ES07） | `pending` |
| ES08 | S09 独立关键状态（ES08） | `pending` |
| ES10 | O-A05 独立关键状态（ES10） | `pending` |
| A01-identity-recheck-failed | 身份复核暂时失败 | `pending` |

