# 驾照建档入口：三页局部修订与前后比对

日期：10/17/2026。状态：**已绘制、待用户确认**。路线：EXEC 静态原型修订，不写应用代码。使用 Product Design 参考约束及内置 Image Gen 原图编辑，不进行重新设计或真实业务操作。

## 交付与范围

| 页面 | 修改前 | 本轮新稿 |
| --- | --- | --- |
| 客户列表 | [C01 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png) | [C01 v4](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png) |
| 上传页 | [C12 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v3.png) | [C12 v4](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png) |
| 核对页 | [C13 v2](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v2.png) | [C13 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v3.png) |

约束以[规则调整 03](F:/projects/website-gen/docs/design/scope-amendment-03-license-required.md)为准：必须先有成功上传的驾照正面；单张或批量统一入口；OCR 失败只能对着已上传原图人工转录、确认后提交。没有独立手工建档；不新增真实性、有效期或后续文件删除权限规则。

## C01：仅统一右上入口

| 修改前 | 修改后 |
| --- | --- |
| ![C01 修改前](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png) | ![C01 修改后](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png) |

- 原“批量上传驾照”“手工建档”两个按钮，改为唯一深藏蓝按钮“上传驾照建档”；下方短说明“支持单张或批量”。
- 核对保留：6 位客户及其姓名/企业、2 完成/4 未完成、搜索、选中 Alex Morgan/C001、双栏结构、电话与邮箱、Northline LLC/品牌/网站/商业邮箱、附件 1/2/2/1、Stripe 与 PayPal 状态及日期、申请负责人李敏、页头 10/16/2026。
- 无其他新建按钮、固定客户负责人、材料总页或自动下一步提示。

## C12：单张与多张共用上传页

| 修改前 | 修改后 |
| --- | --- |
| ![C12 修改前](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v3.png) | ![C12 修改后](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png) |

- 面包屑和标题统一为“上传驾照建档”。
- 标题说明改为“先上传驾照正面才能建档；支持单张或多张，反面可后补。”上传区注明“支持单张或多张图片”。
- 04-blur.jpg 已上传、识别失败，原“手工录入”仅改为“人工转录”，不新增无图入口。
- 核对保留：批次 B20261017-01、上传/识别发起李敏、3 步流程、5 张/上传 5/识别完成 4/失败 1、五个文件名与状态、03 疑似重复、04 重新识别、尚未创建客户说明、进入人工核对（4）、10/17/2026 日期及表格/按钮结构。

## C13：人工转录不能绕过图片

| 修改前 | 修改后 |
| --- | --- |
| ![C13 修改前](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v2.png) | ![C13 修改后](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v3.png) |

- 面包屑统一为“上传驾照建档”；04 失败项“手工录入”改为“人工转录”。
- 页脚改为“人工转录须对照已上传原图；缺少驾照、未确认或重复未决项不提交。”不覆盖或挤压底部动作。
- 核对保留：批次、步骤 2、提交已确认项（1）、五项队列状态与 Emily 选中态、DEMO 原图、10 项字段及原值、美国日期、TX＋灰色 Texas、李敏上传/识别发起、王芳核对、非驾照字段后补说明、两个底部按钮与三栏布局。
- 04 仍是识别失败，未冒充 AI 成功；当前页仍是待确认，不提前显示已创建。

## 比对结论与限制

- 主线程和独立审查均逐对查看旧/新图。三对在所列业务值、状态、层级、配色和布局范围内通过；未发现额外字段丢失或业务改动。
- **不声称像素完全一致。**生成式编辑存在字体边缘/背景的轻微像素差异。C01 仍为 1487×1058，C12 仍为 1489×1056；C13 为 1489×1056，原图 1490×1056，宽度少 1 px，未发现字段裁切。
- 只读坐标重叠测量（未归一化尺寸）中，允许编辑框外平均通道差为 C01 1.91/255、C12 1.42/255、C13 3.51/255。它们只描述像素变化，不是视觉通过率或功能测试结果。完整数据见[像素记录](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01/pixel-comparison.json)。
- 未改 C14，未扩展重复/差异面板、上传失败、文件关联失败、单张队列或人工转录打开态。这些仍按后续计划单独设计。本次只完成要求的三个静态正常态修订，不验证真实上传/OCR/保存、服务端前置校验或权限。

## 归档、哈希与回退

- 三张新稿分别存于第 01/02 组，并更新两组 README 和 manifest；同步全局分组、界面规范、驾照前置调整与流程说明。没有应用代码、部署或状态变更 Git 操作。
- [生成提示词](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01/imagegen-prompts.json)、[源图与新图 SHA-256](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01/new-image-records.json)、[最终验证](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01/verification.json)均保留。
- [修改前备份](F:/projects/website-gen/.tmp/license-entry-ui-20261017-01)包含三张原图、八份文档/索引基线和全量旧图哈希。旧图没有覆盖；若要求回退，仅恢复对应文档基线并将图册指向原图，新图可作为历史候选保留。无线上业务数据需要回滚。

待用户确认当前三张新稿；不把本轮“请修改”视作对结果已批准。
