# 客户管理原型补齐 · 图册

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


10/17/2026 · **静态设计候选，待确认；未写应用代码。**

按现有设计档案核对，本次缺少 11 个独立客户页面/覆盖层，以及 4 个直接服务审核和申请的操作面板。现补齐这些界面，并补上必要的归因详情和关键异常状态，共 **37 张新图**，分为下列 4 组。原有已确认 PNG 不覆盖、不重画。

## 按业务顺序查看

| 组 | 图册 | 新图数量 | 覆盖内容 |
| --- | --- | ---: | --- |
| 1 | [建档与驾照核对](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md) | 5 | O-C02、O-C03、C12、C13、C14 |
| 2 | [网站与邮箱、审核及申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md) | 12 | C07、O-C11、O-C12、O-C13、O-C14、C08、O-G01、O-G02、O-G03、C09、O-G04 |
| 3 | [附件、保存与删除](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md) | 8 | O-C07、O-C08、O-C09、O-C10、O-C04、O-C15、O-C16 |
| 4 | [操作归属与公共状态](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md) | 12 | C10、C01、C02、O-A04、O-A05 |

## 建议先确认这三个主面板

### C07 网站与邮箱

显示同一客户的站点和商业邮箱关联、建站前置及公开信息来源，不把当前档案当作已同步线上值。

![C07 网站与邮箱](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C07-website-mail-v1.png)

### C08 材料审核

展示已检查、参考问题、变更待复核、执行失败及未检查；不生成虚构评分或阻止申请。

![C08 材料审核](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C08-review-v1.png)

### C09 网关申请：有在办申请

当前申请与历次申请分开；已有在办时不能再开始一条。客户完成只由有效获批决定。

![C09 网关申请：有在办申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C09-applications-active-v1.png)

## 范围与记录

- [逐项覆盖清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)：原有图、本轮补图和复用状态分别列出。
- [检查与修复记录](F:/projects/website-gen/docs/design/customer-management-completion-v1/verification.md)：参考图、语义核对、回退及校验结果。
- [文件清单与 SHA-256](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)：每张最终 PNG 的生成源、尺寸、提示词与校验。
- [原客户档案图册](F:/projects/website-gen/docs/design/group-01-customer-dossier/README.md)及[原建档图册](F:/projects/website-gen/docs/design/group-02-customer-onboarding/README.md)继续保留。

## 未擅自定案

1. 非管理员删除档案、申请负责人指定/改派的具体权限仍待确认；本轮没有恢复固定客户负责人。
2. C09 的“当前补充证明”是落点提案，图中已注明待确认，不恢复独立材料页。
3. 网关全局详情、只读申请定稿完整浏览、邮件管理和完整建站流程属于后续对应模块，不以客户页中的链接冒充已绘制。
4. 共用异常图是代表性状态，不是每个字段、每个平台、每种组合均另画一张；响应式、可点击交互及真实接口仍未实现或验证。

已废止 C06 独立材料页、C11/O-C01 无驾照手工建档和 O-C06 固定客户负责人调整均不恢复。所有图片为 DEMO；“已完成”等字样仅为静态示例，不是真实业务结果。
