# 操作归属与公共状态

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


10/17/2026 · 12 张静态设计候选，待确认。 [返回总图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

原图不覆盖，颜色/布局参照现有白底深海军蓝设计。各图为独立截面，不保证同一示例的所有分支连续发生。通用提示不代表动作真实执行。

## 1. C10 个人资料操作归属：第 1 页

个人与驾照字段的当前值、来源、操作人和时间；不是中间修改历史。

![C10 个人资料操作归属：第 1 页](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C10-personal-page1-v1.png)

## 2. C10 个人资料操作归属：第 2 页

两个地址分别记录，正反面附件各自归因；共 20 项分两页。

![C10 个人资料操作归属：第 2 页](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C10-personal-page2-v1.png)

## 3. C10 企业资料操作归属

企业字段、办理状态、说明及每份文件分开；空值不虚构填写者。

![C10 企业资料操作归属](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C10-company-v1.png)

## 4. C10 字段操作归属详情

当前字段操作人、驾照上传人、AI发起人和人工确认人分层，不自动判责。

![C10 字段操作归属详情](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C10-actor-detail-v1.png)

## 5. C01 尚无客户

只引导上传驾照建档，没有手工建档入口。

![C01 尚无客户](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-empty-v1.png)

## 6. C01 搜索无结果

保留关键词与清除入口，不将无结果当作系统没有客户。

![C01 搜索无结果](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-search-empty-v1.png)

## 7. C01 列表加载中

只呈现占位，不伪造客户总数、选中项或状态。

![C01 列表加载中](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-loading-v1.png)

## 8. C01 客户速览读取失败

左侧列表仍可用，仅右侧当前客户档案读取失败；局部重试，不展示旧详情或伪报零客户。

![C01 客户速览读取失败](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C01-read-failure-v1.png)

## 9. C02 档案不存在

对象已不可用时不继续呈现旧的个人资料，给出返回列表。

![C02 档案不存在](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C02-not-found-v1.png)

## 10. C02 无权访问档案

不泄露客户字段；只表达本次无权访问，不擅自制定员工分配规则。

![C02 无权访问档案](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/C02-forbidden-v1.png)

## 11. O-A04 未保存离开确认

继续编辑或放弃本次输入；不把放弃输入当成删除正式资料。

![O-A04 未保存离开确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/O-A04-unsaved-v1.png)

## 12. O-A05 并发修改冲突

保留我的输入，展示当前已保存值及操作人；不静默覆盖他人修改。

![O-A05 并发修改冲突](F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/O-A05-conflict-v1.png)

更多范围见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)，生成与校验见[主清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)。
