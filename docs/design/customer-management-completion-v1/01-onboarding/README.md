# 建档与驾照核对

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


10/17/2026 · 5 张静态设计候选，待确认。 [返回总图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

原图不覆盖，颜色/布局参照现有白底深海军蓝设计。各图为独立截面，不保证同一示例的所有分支连续发生。通用提示不代表动作真实执行。

## 1. O-C02 重复线索处理

提示相同证件/姓名线索，由员工选择仅关联、比较差异、确认为不同人或跳过；不自动合并。

![O-C02 重复线索处理](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/O-C02-duplicate-v1.png)

## 2. O-C03 字段差异确认

逐字段决定是否采用新识别值；未识别字段不清空原值，选择先暂存，正式提交成功才更新。

![O-C03 字段差异确认](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/O-C03-differences-v1.png)

## 3. C12 上传混合状态

上传中、成功、失败、等待和取消分别呈现；只有上传成功的正面可进入识别/核对。

![C12 上传混合状态](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/C12-upload-states-v1.png)

## 4. C13 识别失败后的人工转录

依附已上传的正面原图进行转录和人工确认；不是无驾照手工建档。

![C13 识别失败后的人工转录](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/C13-manual-transcription-v1.png)

## 5. C14 提交结果未知

区分明确失败与结果未知；未知先核验，不盲目重建，保留已确认内容。

![C14 提交结果未知](F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/C14-unknown-result-v1.png)

更多范围见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)，生成与校验见[主清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)。
