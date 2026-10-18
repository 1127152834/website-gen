# 一期客户模块 → Stitch 迁移材料

**状态：本地迁移材料已准备；Stitch 账号认证未通过。没有创建远端项目或页面，用户要求的远端迁移尚未完成。**

## 范围与目标

承接最新 [54 张客户模块图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)，不是旧版本，也不是尚未设计的全应用。54 张图对应主屏、覆盖层及状态示例，不表示要创建 54 条产品路由。迁移后仍保留客户列表、档案详情、上传驾照、人工核对、建档结果这 5 个路由家族。

仅在 Stitch 制作原型；不修改本仓库应用代码，不连接客户真实资料、邮箱、支付平台或 Hostinger，不部署。

## 当前检查点

- 已读取本机已启用的 Stitch MCP 配置；没有展示、复制或记录密钥。
- 官方服务 `https://stitch.googleapis.com/mcp` 的初始化与工具目录读取均为 HTTP 200。
- 真正执行 `list_projects` 时返回 **HTTP 401，API key not valid. Please pass a valid API key.**
- 工具目录可读不能证明账号认证成功；没有发出创建项目、上传设计系统或生成页面的调用。
- 请在 Stitch 中生成有效 API Key，并更新 Codex 对应 MCP 的 `X-Goog-Api-Key`。不在聊天或项目文件中保存明文密钥。[官方 SDK 认证说明](https://github.com/google-labs-code/stitch-sdk/blob/main/README.md)

## 准备材料

- [DESIGN.md](F:/projects/website-gen/docs/design/stitch-phase-01/DESIGN.md)：Stitch 定向设计规范，锁定当前墨蓝/灰蓝视觉，不应用技能默认的艺术化或动态风格。
- [BUSINESS.md](F:/projects/website-gen/docs/design/stitch-phase-01/BUSINESS.md)：业务约束、五路由组织、未定事项；未定权限不由生成工具自行补齐。
- [MASTER-PROMPT.md](F:/projects/website-gen/docs/design/stitch-phase-01/MASTER-PROMPT.md)：每屏共同约束，配合设计系统及逐屏说明使用。
- 54 个参考图的逐屏规格：[核心与公共状态 26 图](F:/projects/website-gen/docs/design/stitch-phase-01/prompts/core-common.json)、[建档与附件支持 16 图](F:/projects/website-gen/docs/design/stitch-phase-01/prompts/onboarding-support.json)、[网站、审核与申请 12 图](F:/projects/website-gen/docs/design/stitch-phase-01/prompts/links.json)。这些是迁移输入，不是已生成的 Stitch 页面。
- [migration-manifest.json](F:/projects/website-gen/docs/design/stitch-phase-01/migration-manifest.json)：逐图来源、提示词位置、哈希与远端状态；尚未上传的项目/页面 ID 均为空，不预造链接。
- [source-baseline.json](F:/projects/website-gen/docs/design/stitch-phase-01/source-baseline.json)：54 张当前参考图及其 SHA-256。
- [verification.json](F:/projects/website-gen/docs/design/stitch-phase-01/verification.json)：本地覆盖、来源完整性及远端未验证的明确边界。
- remote/：连接探测的请求/响应证据；不是已创建的远端资产。

## 认证恢复后的顺序

1. 只读验证项目列表成功，记录已有项目基线。
2. 创建独立项目“业务工作台｜一期客户管理”，不修改既有项目。
3. 上传 DESIGN.md，再由 Stitch 创建对应设计系统；保存真实项目与资产 ID。
4. 先生成 C01 客户列表、C02 档案概览、C03 个人资料，核对视觉和业务骨架。
5. 同一设计系统下按组补齐其余主屏、覆盖层和异常状态；各自保留稳定编号与来源图映射。
6. 读取真实生成结果，核查字段、状态、按钮、上下文、定稿/归因边界；发现偏差只修目标页面。
7. 输出真实 Stitch 项目链接、画板 ID、覆盖清单、未验证项及本地验证证据。

发生生成超时不盲目重试；先查询远端是否已经完成。编辑前留存对应远端结果。未验证的按钮连接、响应式、权限、OCR、邮件 AI 等不能宣称实现。

## 回滚与保护

原设计材料只读保留；本轮文件放在独立目录。未改全局 MCP 配置或密钥；未改应用代码、数据或 Git 提交。因尚无远端写入，当前没有需要删除或回滚的 Stitch 项目。本地如需撤销，归档本目录即可，不覆盖旧图；本轮 README 修改前副本位于 `F:/projects/website-gen/.tmp/stitch-migration-20261017/backup/README-before-finalization.md`。后续任何远端项目删除都应另行确认。
