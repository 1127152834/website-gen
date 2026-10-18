# 附件、保存与删除

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


10/17/2026 · 8 张静态设计候选，待确认。 [返回总图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

原图不覆盖，颜色/布局参照现有白底深海军蓝设计。各图为独立截面，不保证同一示例的所有分支连续发生。通用提示不代表动作真实执行。

## 1. O-C07 附件上传混合状态

每份文件独立成功、等待、失败、取消；成功才记录当前文件的操作人。

![O-C07 附件上传混合状态](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C07-upload-states-v1.png)

## 2. O-C08 预览读取失败

保留文件归档事实，允许重试/下载；不显示可用的分页和缩放。

![O-C08 预览读取失败](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C08-preview-unavailable-v1.png)

## 3. O-C08 格式不支持预览

明确文件仍已保存，可下载查看；不把不支持预览当作损坏或审核失败。

![O-C08 格式不支持预览](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C08-preview-unsupported-v1.png)

## 4. O-C09 替换失败

旧文件及其操作归因继续有效，失败的新文件不覆盖，不改申请定稿。

![O-C09 替换失败](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C09-replace-failure-v1.png)

## 5. O-C10 移除失败

未成功前文件仍保留；不提前更新操作归因，也不撤回平台材料。

![O-C10 移除失败](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C10-remove-failure-v1.png)

## 6. O-C04 编辑保存失败

保留输入与原正式值，保存失败不关闭抽屉、不更新当前操作人。

![O-C04 编辑保存失败](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C04-save-failure-v1.png)

## 7. O-C15 删除客户影响确认

管理员示例；明确档案/网站/申请定稿删除、域名解绑、邮箱与原邮件保留，在办申请另行知悉。

![O-C15 删除客户影响确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C15-delete-confirm-v1.png)

## 8. O-C16 删除执行结果

逐项显示成功、失败、未知与按规则保留；已删除档案不再留作可访问底页，未核验步骤不冒充完成。

![O-C16 删除执行结果](F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/O-C16-delete-execution-v1.png)

更多范围见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)，生成与校验见[主清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)。
