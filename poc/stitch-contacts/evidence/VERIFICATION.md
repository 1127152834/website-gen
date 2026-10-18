# 交付验证

日期：2026-10-18。路线 CODE：基线 → 新目录隔离 → Stitch 取回/视觉检查 → 实现 → 测试/浏览器回归 → 回滚记录 → 交付。

## 最终结果

- TypeScript：exit 0。
- 单元测试：9/9 通过，见 unit-tests.txt。
- Stitch Build 原始 SWC AST 组件校验：10/10 通过（9 个组件 + App）。
- Vite production build：1936 modules，成功，无最终 chunk 警告。
- 正式预览：http://127.0.0.1:5189/，HTTP 200，页面标题匹配。
- 正式构建浏览器警告/错误：0（仅统计 :5189 来源）。
- 独立代码审查：无阻塞问题；复制 toast 关闭的小问题已修复。

## 浏览器实际完成

使用 Codex in-app browser，而非仅静态测试：

1. 姓名/邮箱搜索与无结果状态、清除筛选。
2. 空姓名表单校验；新增联系人与刷新后保留。
3. 编辑名称、收藏、朋友分组筛选，以及刷新后的收藏/编辑保留。
4. 删除确认包含姓名；取消保留；确认后刷新仍删除。
5. 仅填写姓名，空电话/邮箱可以新增；随后已清理该测试联系人。
6. 模拟 localStorage setItem 配额错误：编辑器保持打开、原列表未改变、显示失败；重新加载确认未持久化；模拟已恢复。
7. 临时写入非法 JSON：显示格式错误且原始坏值不被覆盖；原数据已恢复。
8. 360×800、768×1024、1440×900 布局，document scrollWidth 等于 clientWidth，无页面横向溢出。
9. 手机联系人详情、原生新建模态框、Escape 关闭、深色切换。
10. 最终正式构建再次检查手机表单/退出、桌面首屏、控制台；桌面/手机截图已保存。

测试联系人均为本任务创建的虚构记录，均已清理。存储故障注入均已撤销；未拨号、发送邮件或访问真实通讯录。开发时修改 hook 曾使热更新暂态白屏，全页刷新恢复；交付使用无 HMR 的正式构建预览，未复现。

## 范围与基线

- 新增：F:\projects\website-gen\poc\stitch-contacts 下的独立应用、设计快照和证据。
- 新增：F:\projects\website-gen\.stitch\metadata.json（Stitch Build 要求的镜像）。
- 根 package.json、package-lock.json、vite.config.ts、tsconfig.json 前后 SHA-256 完全一致。
- 没有 Git 提交、暂存、重置或分支切换；没有修改 .env；没有部署到生产或修改 Stitch 云端画稿。
- 不运行原网站全量测试，验证范围仅此独立应用。
- 数据仅浏览器本地，不支持设备通讯录、后端或云同步；跨标签检查并非数据库原子事务保证。

## 回滚与哈希

基线在 git-status-before.txt / protected-hashes-before.json；四份受保护根文件复核在 protected-hashes-after.json。
中间修改前快照在 checkpoints/；最终源码、设计和构建产物哈希在 sha256.json。
停止该应用的 Vite 服务后可归档整个独立应用目录；根 metadata 仅在内容仍匹配本次 manifest 时归档该文件，不删除根 .stitch 目录。浏览器数据不会因代码归档被删除。

原目标核对：已使用 Stitch 设计构建简单通讯录，并交付可运行源码、中文界面、本地预览及验证证据。
