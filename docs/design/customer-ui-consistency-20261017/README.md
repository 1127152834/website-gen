# 客户模块 UI 复核与修正

**当前图册：54 张现行图已复核，29 张局部修正，25 张保留原图。**

10/17/2026 · EXEC：基线 → 备份 → 问题汇总 → 局部修图 → 前后复核 → 回归检查 → 归档。仅静态原型，新修订待确认；未写应用代码。

## 按模块查看

| 模块 | 当前图数 | 修订数 | 修改前后 |
|---|---:|---:|---|
| [基础档案与正常操作](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/current/01-core.md) | 14 | 5 | [本组对比](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/comparisons/01-core.md) |
| [驾照建档与核对](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/current/02-onboarding.md) | 8 | 6 | [本组对比](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/comparisons/02-onboarding.md) |
| [网站、审核与网关申请](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/current/03-links.md) | 12 | 8 | [本组对比](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/comparisons/03-links.md) |
| [附件、保存与删除异常](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/current/04-support.md) | 8 | 2 | [本组对比](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/comparisons/04-support.md) |
| [操作归属与公共状态](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/current/05-common.md) | 12 | 8 | [本组对比](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/comparisons/05-common.md) |

## 已发现并修正

1. **颜色角色混乱：**部分普通正文、辅助字、未选导航偏亮蓝；回归墨蓝正文、灰蓝辅助、亮蓝链接。重复候选统一为警告橙，未读取信息不再冒充红色错误。
2. **同类结构不一致：**补回网关页返回行；统一归属表表头与重置控件，恢复翻页后的返回入口；调整企业/银行编辑抽屉的操作人位置与详情标题层级。
3. **状态与按钮矛盾：**未勾选必要确认时，开始申请、解除关联、删除客户的提交按钮改为禁用态。AI 审核仍只是参考，不新增通过门槛。
4. **提示与当前场景不符：**移除员工界面的设计占位语；搜索无结果提示先清空搜索；加载骨架与无头像列表一致；上传失败与不支持格式分别统计。
5. **跨页示例数据不一致：**校正灰底驾照/企业地址、办理/上传日期及同一客户的历史申请和附件数量；保持当前档案、未保存输入与申请定稿边界。

## 验证与证据

- [验证结果、SHA-256 和回滚记录](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/verification.md)
- [全部修复映射与完整生成提示](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/manifest.json)
- [原始 54 张审查范围](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/audit-scope.json)
- 问题清单：[主页面](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/root.md)、[建档](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/onboarding.md)、[关联与申请](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/links-review.md)、[操作面板](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/support.md)。

## 保留的边界

- 列表紧凑导航与档案完整导航沿用此前分型；不在本轮擅自合并菜单或重排业务布局。
- 仍须上传驾照正面才能建档；无独立手工建档入口。地址分开，美国日期，州缩写加全名。
- 仍无固定客户负责人，仅申请时定申请负责人；字段和附件记录最后成功操作的操作人。
- 审核只供参考；有在办申请时不能并行开启第二条；误判获批纠正后重算客户状态。
- 申请定稿保持原值与当时归因；失败、取消或未保存不会更新正式资料操作人。
- C09 补充证明的最终放置位置仍是设计建议，未因本轮去掉界面备注而自动成为已批准规则。
- 所有样例均为 DEMO；没有识别真实证件、调用支付平台或访问客户邮箱。
- 静态图片不能证明键盘、响应式、权限、按钮行为或真实数据状态；这些留到获准实现后验收。
- 审核运行/未运行、保存/未保存是不同场景示例，不拼接为同一次真实操作的连续时间线；定稿字段数为演示数量，不定义最终数据模型字段总数。

## 历史与回滚

修改前 PNG 均原路径保留。最新候选以本图册及 catalog.json 为准；历史 README、版本确认和旧 manifest 不改写成新版本已批准。撤回本轮时可恢复入口文档备份并重新使用原图，不需要修改应用或外部系统。
