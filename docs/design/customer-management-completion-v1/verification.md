# 客户管理补齐 · 核查与回退记录

日期：10/17/2026。 [打开图册](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)

## 检查方法

1. 以已归档的模块清单、人员归属修订、驾照建档前置、原始截图和当前有效 PNG 为基线，不把历史废稿当新需求。
2. 按“上传与核对 → 当前资料 → 网站/邮箱 → 参考审核 → 人工开始网关申请 → 结果与删除”检查客户模块。
3. 每张先读取参考图，再用内置 Image Gen 生成/编辑，保存本地 PNG；未以 HTML 或应用代码冒充原型图。
4. 作者逐图检查，另交叉检查表单、归因、资料对应、队列计数、单在办、失败和保留语义；有问题的候选先备份再局部修正。
5. 对最终文件与生成源分别 SHA-256 校验；检查 37 张目录图、索引链接、JSON 和原有设计文件基线。

## 已发现并修复

| 图 | 问题 | 最小修复 |
| --- | --- | --- |
| O-C02 / O-C03 | 抽屉 Alex 与背后选中的 Emily 不一致 | 背景选中项及 DEMO 原图统一到 Alex |
| O-C03 | 新候选到期/街道与背后打开的新原图不一致 | 新证件展示 08/15/2031、78 Sample Street；当前档案仍为原值 |
| C07 / O-C14 | 企业地址漂移 | 恢复 C04 已有的 260 Demo Blvd, Austin, TX 78702；网站读取值保留其对照语义 |
| C07 / O-C13 | 已有关联站点仍有可用“新建网站” | 已关联时置灰；通过更换关联维持单站点关系 |
| O-C11 / O-C12 | 候选写“未关联”却又显示已有归属 | 改为明确未占用的新候选，与当前关联和他人占用区分 |
| C08 / O-G01 / O-G02 | 返回文字乱码 | 仅修为“返回客户列表” |
| O-G04 | 新生成灰底误恢复了手工建档入口 | 重出不含废止入口的版本 |
| C09 在办态 | “完成不受后续影响”措辞过宽 | 已有有效获批保留；误判获批被人工纠正后同步重算客户状态 |
| O-C14 | 读取失败提示提到与电话行无关的库存页 | 改为联系电话未读取到，不代表信息有误 |
| C10 个人第 1 页 | 面包屑误写个人资料 | 改为资料操作归属，筛选仍为个人资料 |
| C10 企业 | 未提供的说明被标成人工录入 | 来源/查看清空为“—”；州全名缩小为灰字 |
| O-C08 两种异常 | 未加载/不支持预览却仍提供分页和缩放 | 移除无效工具，保留文件名、下载及适用的重试 |
| O-C16 | 档案已删除仍留可读的旧资料底页 | 改为中性遮罩；删除结果本身完整保留 |
| O-A04 | 声称当前住址未保存，表单却仍是正式值 | 抽屉临时值 130 Example Ave，底页正式值保持 128 |
| 文档说明 | 将 C01 右侧详情失败误称整列表失败 | 据实际图改为列表可用、仅速览读取失败 |

修改前候选保存在各组的 `history` / `before-fix` / `before-fix-root`，不进入正式图册。未追求无依据的全量重画；如 C10 第 2 页与第 1 页的返回链接布局差异只是轻微一致性差别，不影响归因表内容，未因此扩展重画范围。生成图存在细微排版/像素波动，不声称像素级完全相同。

## 最终核验结果

- 最终 PNG：37/37；与 Image Gen 最终生成源 SHA-256 一致：37/37。
- 原 PNG：49/49 哈希不变；80 个旧设计文件无丢失，只有预先备份的 5 个索引/manifest 被更新。
- JSON：18 份均可解析（包括修前记录）；本地文档链接 272 项检查、0 失效。
- 四组图册实际引用 37 张不同的最终 PNG，不计修前历史稿。
- 主清单 SHA-256：`EF07EBFC600FDF7F6C434298BE5A3572920431170E621768E9065776E6B38E3F`。
- 所有结果限静态设计与文件核验；没有运行应用功能测试。

## 校验结果入口

- [主 manifest](F:/projects/website-gen/docs/design/customer-management-completion-v1/manifest.json)：最终 37 图的尺寸、字节数、生成源与 SHA-256。
- [机器校验结果](F:/projects/website-gen/.tmp/customer-completion-20261017-01/verification.json)：新图/源文件、目录引用、JSON、49 张旧 PNG 和旧文档差异。
- [本轮范围盘点](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-plan.md)与[逐项覆盖结果](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)分别保留计划和实际覆盖。
- 各组 report、prompts 记录生成/修复依据；02-customer-links 留存的是明确标注的提示词摘要，并非逐字工具调用全文，这与最初完整提示词归档计划有差异，不伪称全文齐备。其他组保留其生成/修复提示文本。03-support 的根审查补充见 repair-root.json，04-common 分主/追加两份记录。

两次内置出图调用超过 10 分钟没有返回，均先终止挂起调用，再进行单次新调用重试并获得最终源；没有把未返回的调用当成成功图片。未执行任何真实用户上传/OCR/AI审核、网关申请、网站发布、删除或生产部署，所以这些不属于本轮验证通过项。

## 变更范围

新增设计目录：`F:/projects/website-gen/docs/design/customer-management-completion-v1`。

旧设计文件仅更新下列 5 项索引或覆盖记录；原确认记录、原页面清单及旧 PNG 保留：
- `F:/projects/website-gen/docs/design/prototype-groups-v1.md`
- `F:/projects/website-gen/docs/design/group-01-customer-dossier/README.md`
- `F:/projects/website-gen/docs/design/group-01-customer-dossier/manifest.json`
- `F:/projects/website-gen/docs/design/group-02-customer-onboarding/README.md`
- `F:/projects/website-gen/docs/design/group-02-customer-onboarding/manifest.json`

没有新增应用源文件、安装依赖、改配置、提交 Git 或部署。本仓库原有并行修改不属于本轮产物，不回退它们。

## 回退记录（未执行）

基线目录：[customer-completion-20261017-01](F:/projects/website-gen/.tmp/customer-completion-20261017-01)。

- 回退设计索引时，只把此目录中相应 `docs__design__…` 备份复制回上述 5 个文件；若此后有人再编辑，先比对，不盲目覆盖。
- 原 49 张图从未覆盖，不需要恢复。
- 新设计可从索引取消引用后保留为历史；不要用 Git reset/clean 或删除整个 design 目录。
- 本轮草稿的局部回退使用各组 history/before-fix 副本，不影响原已确认图。

## 仍待确认/未验证

非管理员删除、申请负责人指派/改派权限，以及 C09 补充证明落点仍待确认。完整网关、只读申请定稿、邮件与建站模块后续分别设计。37 张是本轮客户模块设计覆盖，不是全应用已完成，也不是全部状态组合和响应式验收。
