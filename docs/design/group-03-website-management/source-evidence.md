# 第 03 组：现有能力与设计新增的区分

核查日期：10/17/2026。只读当前工作区代码及设计资料；未验证运行中的应用、Hostinger、CJ、邮件或模型。工作区可能有其他并行改动，下面是本轮源码快照，不是部署证明。

## 页面与路由

| 当前路由/区域 | 本地可见能力 | 证据 |
| --- | --- | --- |
| `/` | 站点状态计数、进行中批次、实际异常及 30 天内域名到期快照 | `F:/projects/website-gen/src/renderer/src/features/overview/index.tsx:9–21`；`F:/projects/website-gen/src/backend/overview.ts:22–48` |
| `/new` | 三步向导，确认后调用 `batches.create` 并进入批次 | `F:/projects/website-gen/src/renderer/src/features/new-batch/index.tsx:94–103,125–160` |
| `/batches`、`/batches/:batchId` | 批次与站点进度、步骤、日志、QA、失败重试、人工上线 | `F:/projects/website-gen/src/renderer/src/features/batches/index.tsx:46–52,62–87,107–113` |
| `/sites` | 活跃站点列表、搜索/状态筛选、已放弃历史 | `F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:48–76` |
| `/sites/:siteId`、`/overview` | 概况、打开网站、执行步骤和日志、适用的重试/上线/放弃操作 | `F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:81–130` |
| `/sites/:siteId/chat` | AI 站点修改对话、执行反馈、停止、新对话确认 | `F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:135–168` |
| `/sites/:siteId/mail` | 邮箱、DNS、SMTP 验证与启用、修复、密码操作、交易测试邮件 | `F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:192–246` |
| `/sites/:siteId/changes` | 变更、整体回滚、定时恢复取消；后续修改冲突需保留 | `F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:171–189` |
| `/sites/:siteId/qa` | 单项/整体修复、复核、需人工处理项、证据及运行记录 | `F:/projects/website-gen/src/renderer/src/features/sites/components/qa-report.tsx:93–142,149–237,251–298` |

详情子视图白名单为 `overview/chat/mail/changes/qa`，见 `F:/projects/website-gen/src/renderer/src/lib/route-params.ts:22`。原清单中的 W 编号是设计视图编号，不意味着增加同等数量的独立路由。

## 关键输入与资源边界

1. 现有 `BatchForm` 为一个 `entity` 加多个 `sites`，实体存整批 `entity_json`。证据：`F:/projects/website-gen/src/shared/forms.ts:31–34`、`F:/projects/website-gen/src/backend/batches.ts:58–63`。本次核查的创建链路没有客户关联字段；“多个客户各自用自己的公司建站”是新增设计，不是旧批量能力的别名。
2. 现有经营信息支持公司/个人经营者、法定名称/姓名、地址、电话及处理/运输时效。每个站点包含域名、邮箱、品类、数量 1–200、可选售价范围、品牌名；品牌为空时用域名。证据：`F:/projects/website-gen/src/shared/forms.ts:3–34,41–62`。EIN 不是当前输入/校验项；客户模式的 EIN 前提来自用户业务规则。
3. 域名取已同步的可用资源，排除已有站点、已占批次及已放弃域名。证据：`F:/projects/website-gen/src/backend/batches.ts:10–21`。当前向导不是域名购买页面。
4. 域名选定后读取 Hostinger 当前有效邮箱，唯一候选可自动选、多候选显式选、无候选或读取失败不能创建。创建前重新验证各站点。证据：`F:/projects/website-gen/src/renderer/src/features/new-batch/index.tsx:27–61`、`F:/projects/website-gen/src/backend/site-mailbox.ts:31–105`、`F:/projects/website-gen/src/backend/index.ts:456–477`。无邮箱时当前提示去 hPanel 开通，不应画出向导自动开通邮箱成功。
5. 主体模板 UI 当前未见，兼容 RPC 仍存在；不得为了补齐页面重新新增模板管理。证据：`F:/projects/website-gen/src/renderer/src/features/new-batch/index.tsx:128–139`、`F:/projects/website-gen/src/backend/index.ts:345–347`。

## 执行、上线与危险操作

- 任务状态为 `queued/running/waiting/done/failed/abandoned`；上线另有 `launchedAt`。18 个实际流水线步骤可形成有依据的执行进度，不能换算成客户业务完成率。证据：`F:/projects/website-gen/src/shared/protocol.ts:73–96,115–135`。
- 失败重试从失败步骤继续。生成后保留维护模式；上线前读取最新 QA，有未解决项可以人工确认继续，QA 读取失败不执行上线。证据：`F:/projects/website-gen/src/renderer/src/features/sites/index.tsx:95–130`、`F:/projects/website-gen/src/renderer/src/features/new-batch/index.tsx:153–160`。
- 站点 AI 对话会直接应用网站修改，并非仅给建议。原型必须说明这一点；“新对话”只清空上下文，不能当作撤销修改。实际变更、错误、操作人仍应有可查入口，不增加未经确认的逐次审批流程。
- 现有放弃站点涉及删除网站、域名邮箱/别名、关闭续费并禁止域名复用。证据：`F:/projects/website-gen/src/renderer/src/components/abandon-site.tsx:29–34,104–107`。与客户删除时域名保留解绑、邮箱不动不同，不能共用删除语义。
- 现有显示 `pi/你/定时恢复` 不代表已实现员工姓名级归因；本组的“操作人”联动是待设计能力，不冒充现状。
- 当前部分源码日期格式仍是中文地区格式。原型遵循用户的 MM/DD/YYYY 规范；不因保留已有功能就保留旧格式。

## 本稿不作出的承诺

未新增客户绑定数据模型、未修改批次模型、未调用供应商、未验证真实建站成功、未验证线上共享权限、未生成原型图片。文档中的建议须先讨论，不能因写入清单就视为用户批准。
