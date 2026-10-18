# 知交 · 简单通讯录

基于 Stitch「智能通讯录系统 / Aura Contact」现有设计实现的中文 React + Vite 通讯录。原 Stitch 项目只读，未修改或覆盖原画稿。

## 使用

```powershell
Set-Location 'F:\projects\website-gen\poc\stitch-contacts'
npm ci --ignore-scripts
npm run dev
```

开发预览打开 http://127.0.0.1:5188/ 。正式构建预览：`npm run build` 后运行 `npm run preview`，打开 http://127.0.0.1:5189/ 。当前已启动正式构建预览。首次进入包含 9 位虚构示例联系人；电话使用保留的 202-555-01xx 示例号码，邮箱使用 example.com。

## 功能

- 姓名、电话、邮箱、公司搜索；按姓名排序。
- 新建、编辑、删除二次确认；仅姓名必填。
- 收藏、工作/朋友/家人/其他分组筛选（桌面侧栏）。
- 联系人详情、复制电话/邮箱、明暗主题切换。
- 桌面三栏、平板和手机布局、键盘焦点、原生模态对话框。
- localStorage 显式持久化：写入失败不更新内存、不关闭编辑器；损坏数据只读保护；检测已观察到的跨标签更新冲突。

## 边界

这是本地 Web App，不是原生手机安装包。没有登录、后端、云同步、真实通话记录、自动拨号、设备通讯录授权或导入导出。数据不上传，但 localStorage 并非加密保险库；清除浏览器站点数据会丢失联系人。仅适合轻量单用户使用，多窗口同时写入不提供数据库级原子事务保证。主题设置仅在当前页面生效。

## Stitch 来源

- 项目：https://stitch.withgoogle.com/projects/9334146681510666234
- `.stitch/designs/`：4 张原始 HTML 与 PNG，使用官方 skill 的 fetch-stitch.sh 下载并逐张检查。
- `.stitch/metadata.json`：项目、屏幕 ID、尺寸、位置及同步时间；按 Stitch Build 要求镜像至 `F:\projects\website-gen\.stitch\metadata.json`。
- `resources/style-guide.json`：从联系人列表 HTML 的 Tailwind 配置提取。
- 设计保留蓝/青绿、浅蓝背景、卡片和头像；桌面布局为响应式适配。原稿中的云同步、真实呼叫等不可用能力没有实现为假按钮。
- 使用本地字体回退、Lucide 图标和文字头像，运行时不加载 Google 字体/远程照片。

## 验证

```powershell
npm run typecheck
npm test
npm run build
Get-ChildItem src/components -Filter '*.tsx' | ForEach-Object { npm run validate -- $_.FullName }
npm run validate -- src/App.tsx
```

`scripts/validate.mjs` 为 Stitch Build 原始 SWC AST 检查脚本，必须传入组件路径。最终验证、文件哈希和基线见 `evidence/`。

## 回滚

本次仅新增独立目录和 `.stitch/metadata.json`，没有提交、重置 Git，未修改网站源码、根依赖或环境配置。停止本应用端口 5188（开发）/5189（构建预览）的 Vite 进程后，可将整个 `F:\projects\website-gen\poc\stitch-contacts` 移到归档位置；根 `.stitch/metadata.json` 只有仍属于此项目且未被后续任务修改时才移走。不要删除整个根 `.stitch` 目录。移走代码不会删除浏览器中的联系人数据。

写入前基线：`evidence/git-status-before.txt`、`evidence/protected-hashes-before.json`；中间修复备份：`evidence/checkpoints/`。

