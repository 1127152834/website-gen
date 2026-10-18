# 验证与回滚记录

10/17/2026 · 静态设计审查，非运行验收。

## 自动文件检查

- 当前清单 54 张，路径唯一 54/54；修订 29 张、沿用 25 张。
- 修订图与内置 image_gen 最终源 SHA-256 一致：29/29。
- 原基线 166 文件：101/101 PNG 原字节保留；只更新 8 个入口 Markdown，其他基线文件未变。
- 本轮及更新入口内的绝对本地 Markdown 链接检查：0 个失效。
- 每张原始/修订尺寸与 SHA-256 已存 manifest.json、verification.json。未用代码裁切或二次绘制图片。

## 目视前后复核

- 修图各组逐张查看原图及输出图；并交叉检查关键数据、表行数、计数、按钮禁用态、正文/链接色阶和画面布局。
- 保留操作人、双地址、客户/申请双状态、美国日期、必需驾照、当前资料/定稿边界。
- image_gen 不是像素级补丁工具，部分输出存在 1–3 px 画布边界差异和细微字形/抗锯齿变化；以数据、控件及版式语义的前后核对为准，不宣称零额外像素变化。
- 未执行应用测试、浏览器交互、AI 提供商、邮箱、Hostinger 或支付平台测试，因为本轮未实现或部署应用。

## 更新的既有文件

独立复核记录：[主页面 11 张](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/root-cross-review.md)、[建档 6 张](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/onboarding-cross-review.md)、[操作面板 4 张](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/support-cross-review.md)、[关联与申请主复核 8 张](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/findings/links-cross-review.md)。

- `F:/projects/website-gen/docs/design/prototype-groups-v1.md`
- `F:/projects/website-gen/docs/design/group-01-customer-dossier/README.md`
- `F:/projects/website-gen/docs/design/group-02-customer-onboarding/README.md`
- `F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md`
- `F:/projects/website-gen/docs/design/customer-management-completion-v1/01-onboarding/README.md`
- `F:/projects/website-gen/docs/design/customer-management-completion-v1/02-customer-links/README.md`
- `F:/projects/website-gen/docs/design/customer-management-completion-v1/03-support/README.md`
- `F:/projects/website-gen/docs/design/customer-management-completion-v1/04-common/README.md`

## 回滚

1. 原图均仍在旧路径；本轮图单独保存在 `F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/corrected`。
2. 8 个入口文档的修改前备份位于 `F:/projects/website-gen/.tmp/customer-ui-consistency-20261017-01/documents`，按相对 docs/design 路径映射逐文件恢复。不要恢复整棵仓库，也不要删除其他人的文件。
3. 原基线 SHA-256 见 all-design-baseline.json；恢复后可与之逐文件比较。新图可继续留作历史，不需要删除。
4. 没有应用部署、数据库更改、外部操作或 Git 状态修改需要回滚。

## 主证据 SHA-256

- manifest.json: `5E7623129C2E42C25B3A83D4CA2514A6BE335A33F409C66C7E7D77B07681D747`
- catalog.json: `5BE46FC732E714B7ABA29301F2934F9DD4A333BEDD95F670A1B493B0B56F38F6`
- verification.json: `4E02A3A09FCE7C2D1B1BE9598C66DF6D37357BC3CDB3AA08786EDF4D5824FD20`
