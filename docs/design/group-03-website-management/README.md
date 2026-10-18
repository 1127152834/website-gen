# 第 03 组：网站制作与管理

**当前阶段：用户已选 W02 第一页方案 3、W04 第三页方案 1；仅确认布局方向，W03 原图不变。其他页面及异常覆盖层仍待绘制；未写应用代码。**

- **[已确认选型及多客户展示规则](W02-W04-layout-options-20261017/selection-decision.md)**：第一页工作表布局、第三页纵向清单与固定确认侧栏。[六张备选留档](W02-W04-layout-options-20261017/README.md)。三位客户仅为示例，非数量上限。

承接客户模块，先确认用途、功能、页面和操作流程，再按原有视觉风格逐张绘制。不依赖 Stitch 认证，不修改既有客户原型。

- [当前 UI 优化讨论稿 v2](F:/projects/website-gen/docs/design/group-03-website-management/design-brief-v2.md)
- [范围调整 04：一客户、一企业、一网站](F:/projects/website-gen/docs/design/scope-amendment-04-one-company-one-site.md)
- [现有功能与源码证据快照](F:/projects/website-gen/docs/design/group-03-website-management/source-evidence.md)：旧实现结构不覆盖本轮用户确认的业务规则。
- [v2 写入前基线](F:/projects/website-gen/docs/design/group-03-website-management/baseline-v2.json)与[验证记录](F:/projects/website-gen/docs/design/group-03-website-management/verification-v2.json)
- 历史留存：[v1 讨论稿](F:/projects/website-gen/docs/design/group-03-website-management/design-brief-v1.md)、[v1 基线](F:/projects/website-gen/docs/design/group-03-website-management/baseline.json)、[v1 当时验证](F:/projects/website-gen/docs/design/group-03-website-management/verification.json)。其中单/多客户二选一、多客户后做及一企多站建议已被覆盖；v1 的 README 哈希是更新前快照。

范围：W01–W12 与 O-W01–O-W14；这些是主页面、向导步骤、详情子页和覆盖层，不是 26 条独立路由。客户 C07/O-C11–O-C14 沿用现有设计。

已确定：一个或多个客户都能建站，每个客户/企业仅一个网站。批量是多条独立客户建站项，全局新建入口同样遵守，不保留一企多站特例。

本组重点是现有成熟功能的 UI 优化：逐客户配置、清晰任务状态、易用站点详情和一致视觉。不重做核心建站功能；当前先连贯核对三步向导，再逐张补齐其他页面。此前讨论稿中“未画图”和 W03 说明中的“后续补齐 W02/W04”是当时快照，本 README 为当前进度入口。

## 原始三步主页面（历史留存）

| 编号 | 页面 | 版本与状态 | 说明 |
| --- | --- | --- | --- |
| W02 | [新建网站 · 客户与经营资料](F:/projects/website-gen/docs/design/group-03-website-management/W02-customer-business-info-v1.png) | v1 · 旧布局保留，改选新备选 | 选择已有客户，核对各自企业资料，分别填写处理与运输时效；不提交建站 |
| W03 | [新建网站 · 站点配置](F:/projects/website-gen/docs/design/group-03-website-management/W03-site-configuration-v1.png) | v1 · 待确认 | 多客户逐行配置，展开当前客户详细参数；单客户复用同一结构；本页不提交建站 |
| W04 | [新建网站 · 确认启动](F:/projects/website-gen/docs/design/group-03-website-management/W04-confirm-start-v1.png) | v1 · 旧布局保留，改选新备选 | 逐客户核对最终输入，提示外部调用、费用与维护模式；仅确认按钮发起提交，画面仍是提交前 |

以下为此前补画 W02 / W04 的说明和证据快照；本轮布局备选及最新验证见顶部入口。W03 原图不变。所有图片展示正常流程，不代表单客户、选择弹窗、条件错误、资源失败与提交结果未知等状态均已绘完。

- [W02 / W04 设计说明与跨步字段对齐](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-design-notes.md)
- [独立静态图审阅](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/independent-review.md)
- [W02 / W04 写入前基线](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/baseline.json)与[归档验证及图片哈希](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/verification.json)
- 实际提示词：[W02](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/W02-prompt-v1.txt)、[W04 重试](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/W04-prompt-retry-1.txt)、[W04 一句辅助文案修正](F:/projects/website-gen/docs/design/group-03-website-management/W02-W04-evidence/W04-copy-fix-prompt.txt)

- [W03 设计说明与视觉比对](F:/projects/website-gen/docs/design/group-03-website-management/W03-design-notes.md)
- [W03 生成提示词](F:/projects/website-gen/docs/design/group-03-website-management/W03-evidence/prompt-v1.txt)
- [W03 写入前基线](F:/projects/website-gen/docs/design/group-03-website-management/W03-evidence/baseline.json)与[归档验证](F:/projects/website-gen/docs/design/group-03-website-management/W03-evidence/verification.json)

以上图片仅是静态示例，不代表已创建网站、已读取 Hostinger 资源、已实现客户绑定或已验证交互。
