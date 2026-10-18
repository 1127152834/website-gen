# 网站与邮箱、审核及申请

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


10/17/2026 · 12 张静态设计候选，待确认。 [返回总图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

原图不覆盖，颜色/布局参照现有白底深海军蓝设计。各图为独立截面，不保证同一示例的所有分支连续发生。通用提示不代表动作真实执行。

## 1. C07 网站与邮箱

显示同一客户的站点和商业邮箱关联、建站前置及公开信息来源，不把当前档案当作已同步线上值。

![C07 网站与邮箱](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C07-website-mail-v1.png)

## 2. O-C11 关联或更换已有网站

区分当前关联、可选未占用资源和被其他客户占用的资源；确认前不改变当前关联。

![O-C11 关联或更换已有网站](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C11-link-site-v1.png)

## 3. O-C12 关联或更换商业邮箱

选择已有邮箱，保存关联不代表邮箱已连接或已向平台发信。

![O-C12 关联或更换商业邮箱](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C12-link-mail-v1.png)

## 4. O-C13 解除关联确认

解除关系不是删除网站、域名、邮箱；与删除整个客户的影响边界不同。

![O-C13 解除关联确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C13-unlink-confirm-v1.png)

## 5. O-C14 网站公开信息对照

企业名、企业地址、商业邮箱、个人电话与独立品牌名分开；未读取到的线上值不能假设一致。

![O-C14 网站公开信息对照](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-C14-public-info-v1.png)

## 6. C08 材料审核

展示已检查、参考问题、变更待复核、执行失败及未检查；不生成虚构评分或阻止申请。

![C08 材料审核](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C08-review-v1.png)

## 7. O-G01 确认检查范围

增量检查只覆盖变化及受影响关联项；可以追加范围或取消整次检查。

![O-G01 确认检查范围](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G01-review-scope-v1.png)

## 8. O-G02 审核运行状态

分别显示完成、运行、失败、取消和重试；关闭面板不等于停止后台任务。

![O-G02 审核运行状态](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G02-review-running-v1.png)

## 9. O-G03 审核发现详情

展示问题、文件证据、受影响字段、未检查范围及结果有效性；AI意见不等于平台决定。

![O-G03 审核发现详情](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G03-finding-detail-v1.png)

## 10. C09 网关申请：有在办申请

当前申请与历次申请分开；已有在办时不能再开始一条。客户完成只由有效获批决定。

![C09 网关申请：有在办申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C09-applications-active-v1.png)

## 11. C09 网关申请：无在办申请

保留历次获批结果，可开始后续申请；当前补充证明的放置是待确认提案。

![C09 网关申请：无在办申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/C09-applications-idle-v1.png)

## 12. O-G04 开始网关申请

此时指定申请负责人；知悉审核参考情况，确认后创建申请和当时资料定稿，不替代外部申请操作。

![O-G04 开始网关申请](F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/O-G04-start-application-v1.png)

更多范围见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)，生成与校验见[主清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)。
