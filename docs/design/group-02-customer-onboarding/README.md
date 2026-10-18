# 第 02 组：建档与驾照识别

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


**10/17/2026 客户管理补齐（最新设计覆盖记录）：**已完成 [37 张补充原型](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)：网站与邮箱、材料审核、网关申请、重复/差异、关联/公开信息、删除、资料操作归属及主要异常状态。均为静态候选，待用户确认；没有写应用代码，原 PNG 未覆盖。详情见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)。下文“待绘”等旧段落保留为当时记录，以此最新覆盖清单为准；旧版本的确认不会自动扩展到新图。

日期：10/17/2026。仅静态原型，不写应用代码。

**最新局部修订：C12 v4、C13 v3 已绘制，待用户确认。**取消 C11/O-C01 独立手工建档；单张、多张统一上传驾照正面，再识别/人工转录、人工确认、提交。同步完成 C01 v4 上传入口；三页已成对核对，旧 PNG 均未覆盖。以[规则调整 03](F:/projects/website-gen/docs/design/scope-amendment-03-license-required.md)为准，见[本轮修改前后对比](F:/projects/website-gen/docs/design/license-entry-ui-comparison-20261017.md)。只覆盖静态正常态，不能视为交互已实现。

**此前进度记录：用户表示“先这样……原型也只是参考，继续……后面的页面”，接受 C12 v3 作为继续设计的参考。**随后按同一方向完成 C13 人工核对 v2、C14 建档结果 v2；不再围绕细微色差反复出图。此承接不等于逐像素配色批准、功能运行验收或写代码授权；当前入口修订以顶部新状态为准。

## C12 上传驾照建档 v4 · 入口修订，待确认

![C12 上传驾照建档 v4](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png)

- v4 仅统一标题/面包屑、增加先上传正面的短说明、注明支持单张或多张，“手工录入”改“人工转录”。保留 5/5/4/1 数量、文件状态及操作人。[修改前 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v3.png)是保留的视觉基线，以下 v3 说明为历史记录。

- **唯一配色基准：**[用户本轮提供的客户列表截图](F:/projects/website-gen/docs/design/group-02-customer-onboarding/references/C01-user-color-reference-20261017.png)。原始附件逐字节复制，不能用另一个近似版本替代它。C03/编辑抽屉只作为结构参考，不再覆盖本轮指定的颜色。
- v3 只校准颜色角色：标题接近黑色的深海军蓝、普通内容深蓝黑、未选导航与辅助文字低饱和灰蓝、主按钮深藏蓝、边框浅灰蓝；亮蓝用于少量交互。业务结构和菜单不改。取色与前后对照见[配色记录](F:/projects/website-gen/docs/design/group-02-customer-onboarding/palette-reference-02.md)。
- 保留 5 个文件、上传成功 5、识别完成 4、识别失败 1、进入核对 4；保留默认正面、后补反面、不自动建档、失败项保留及独立操作人记录。
- **状态：用户接受暂按此方向继续。**不是对第一组原图的修改，不声称像素级一致、最终实现定稿或整组完成。

## C13 人工核对识别结果 v3 · 入口修订，待确认

![C13 人工核对识别结果 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v3.png)

- v3 仅统一面包屑、把失败项入口改为“人工转录”，页脚注明须对照已上传原图，缺少驾照/未确认/重复未决项不提交。10 个字段值、队列、操作人及三栏布局保留。[修改前 v2](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v2.png)不覆盖。

- 左侧按文件选择处理，中间打开原图，右侧核对识别字段；支持修正、跳过、确认后继续。重复与识别失败项保留各自入口，不自动合并。
- 当前 5 项中只有 02 已核对，所以顶部是“提交已确认项（1）”。确认只保存核对结果，提交后才尝试创建或关联；候选数据不冒充正式客户资料。
- 上传/识别发起为李敏，当前人工核对为王芳，均只读；不设置客户负责人。10 个字段、美国日期、TX＋灰色 Texas 保留。当前住址、SSN、电话、邮箱不从驾照自动填充。

## C14 建档结果 v2 · 待确认

![C14 建档结果 v2](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C14-creation-results-v2.png)

- 按每个文件分别呈现已创建、已关联、创建失败、未处理、已跳过；此示例各 1 项，总数仍为 5。成功项可打开档案，失败或未处理项可继续处理。
- 这是后续时点：员工另外确认 01、为 03 选择仅关联、跳过 05，再提交 3 项。不是 C13 当前“提交（1）”的一次点击直接得到的画面。
- C007 是唯一新档案；C001 仅关联且未覆盖资料。02 明确保存失败、未写入并保留核对内容，王芳标注为提交操作人。结果未知时先核实，不盲目重复创建。
- 两张与旧稿的内容及配色对照见[本轮核对记录](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-C14-v2-review.md)。新建档案不等于客户业务完成。

## 后续与未完成范围

1. C01 v4、C12 v4、C13 v3 已完成本轮必要入口修订并成对核对，待用户确认。C14 本轮未修改；旧图原件均保留。
2. C11/O-C01 已废止，不再列为待画页面。O-C02 重复线索处理、O-C03 字段差异确认仍未绘制，后续仅承接已有驾照图片的流程；未在本轮扩大范围。
3. 上传中/取消/部分上传失败、空结果、结果未知、离开保护等未全部覆盖。
4. 三页业务逻辑见[流程约定](F:/projects/website-gen/docs/design/group-02-customer-onboarding/flow-brief-v1.md)。业务守恒核查不等于视觉通过，也不等于真实上传/OCR/保存测试。

## 失败候选留存，不作为当前设计稿

- [C12 v1](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v1.png)
- [C12 v2：用户继续指出配色不符](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v2.png)
- [C13 v1](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v1.png)
- [C14 v1](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C14-creation-results-v1.png)
- [C11/O-C01 无驾照快建废稿：用户明确否定，仅留作历史](F:/projects/website-gen/docs/design/group-02-customer-onboarding/history/C11-O-C01-without-license-rejected-v1.png)

没有删除或覆盖旧图；原文件、初始提示词、反馈前文档基线保留在 [本轮备份](F:/projects/website-gen/.tmp/onboarding-prototypes-20261017-040135)。素材路径和 SHA-256 见 [manifest.json](F:/projects/website-gen/docs/design/group-02-customer-onboarding/manifest.json)；差异与纠正见[风格校准记录](F:/projects/website-gen/docs/design/group-02-customer-onboarding/style-correction-01.md)。

本次按用户截图校色前的备份、取色记录、提示词和文件校验另存于 [配色校准证据](F:/projects/website-gen/.tmp/palette-reference-20261017-01)。旧记录保留为历史过程，不覆盖本段最新状态。

本轮 C13/C14 v2 的文档基线、全量旧图哈希、提示词、源图路径和校验保存在 [继续绘制证据](F:/projects/website-gen/.tmp/onboarding-review-results-20261017-01)。旧图和前轮记录均保留。

本次驾照前置纠正仅更新设计文档并归档废稿，基线与校验见[纠正规则证据](F:/projects/website-gen/.tmp/license-required-20261017-01)。第 02 组有效界面为 C12、C13、C14、O-C02、O-C03，不把历史手工建档稿作为有效候选。

随后三页入口落图的原图备份、提示词、只读像素差异测量及哈希见[本轮修图证据](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01)。使用内置 Image Gen 编辑原图，不写应用代码；像素并非完全相同，C13 输出宽度比原图少 1 px，详见对比记录。
