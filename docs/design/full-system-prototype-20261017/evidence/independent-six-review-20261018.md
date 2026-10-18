# 六张关键图独立静态复核

- 复核时间：2026-10-18 PT
- 性质：独立、只读的静态视觉与业务一致性复核
- 范围：`C02-v4`、`C09-active-v4`、`O-G-snapshot-preview-v2`、`O-G06-v2`、`O-G07-v2`、`O-G08-v2`
- 结论：**6/6 通过，0 项实质问题，0 项需要重绘。**
- 边界：截图只能证明可见文案、数据关系和静态状态；不能证明跳转、保存、禁用、权限、邮件动作、并发约束或远端平台行为。

## 逐张结果

### 1. C02-v4 — 通过

路径：`screens/C02-v4.png`

- 页头右上可见 `时间：PT`，适用于页内分钟值；位置清楚，无裁切。
- 右侧当前申请为 PayPal `APP-002`、待补件，开始 `10/16/2026 14:00`、状态更新 `10/17/2026 09:20`、来源邮件 AI、申请负责人李敏。
- 最近申请记录中的 APP-002 开始/更新时间和 Stripe 首次有效获批 `10/12/2026 14:20` 均一致。
- 客户仍为已完成；后续 PayPal 申请没有覆盖 Stripe 有效获批结果。
- 附件概况保持 `1 / 2 / 2 / 1 / 3`；未出现客户级负责人、自动提交或平台已收件暗示。

尺寸 `1484×1060` 与其 v3 基准相同；不是本轮裁切或重采样造成的问题。

### 2. C09-active-v4 — 通过

路径：`screens/C09-active-v4.png`

- 当前唯一在办申请为 PayPal `APP-002`，待补件，开始 `10/16/2026 14:00 PT`，更新 `10/17/2026 09:20 PT`，负责人李敏，来源邮件 AI。
- Stripe 有效获批时间为 `10/12/2026 14:20 PT`，负责人王芳；历史开始时间 `09/28/2026 10:00 PT`，来源人工确认。
- “有效获批结果”是当前摘要，“历史申请”是同一 Stripe 记录的历史明细；未出现 Zen 或第二条在办申请。
- 客户已完成、当前补充证明 `1 / 1 / 1`、定稿只读及“当前客户材料不等于已发送给平台”边界清楚。
- 普通导航、元信息和只读值已恢复深蓝/灰蓝；实际动作链接仍保持可识别蓝色。

### 3. O-G-snapshot-preview-v2 — 通过

路径：`screens/O-G-snapshot-preview-v2.png`

- 右侧抽屉标题为“申请定稿附件 · 只读”，对象为 Alex Morgan · C001 · PayPal APP-002。
- 定稿时间 `10/16/2026 14:00 PT` 与文件操作归因“王芳 / 10/02/2026 10:30 PT”分层显示，没有混同。
- 文件固定为 `bank-statement-2026-07.pdf`，只提供预览、下载和关闭；没有替换、删除、上传或恢复动作。
- 底部明确说明这是申请当时保存文件，当前档案后续替换不影响定稿。

宽度 `1489` 比目标少 1px，无内容裁切，记为非阻断尺寸偏差。

### 4. O-G06-v2 — 通过

路径：`screens/O-G06-v2.png`

- 结束对象为 PayPal APP-002，当前状态待补件，操作人李敏；理由保持“经内部评估，本次申请不再继续尝试。”
- 错误的 `14/500` 已移除。
- 影响说明限定为结束内部记录：不代表远端撤回；仅保存成功后释放在办名额；客户完成与 Stripe 获批保留；原邮件和定稿继续保留。
- 当前仍是确认前状态，只有取消/确认结束，没有假成功结果。

### 5. O-G07-v2 — 通过

路径：`screens/O-G07-v2.png`

- 原邮件固定为 E-102、主题 `Additional statements for APP-002`、收件邮箱 `hello@northline.example`、时间 `10/17/2026 09:20 PT`，并明确“发件人未显示”。
- 精确原文为 `Please provide bank statements for July, August, and September 2026.`，没有补造发件人或平台事实。
- PayPal APP-002 候选备注为“邮件主题编号与此申请一致，平台需人工核对。”；没有提前宣称平台已匹配。
- 同邮箱不等于同一次申请；关联范围仅限本封邮件，不新建申请、不关联全部邮件；可保持待核对。

### 6. O-G08-v2 — 通过

路径：`screens/O-G08-v2.png`

- 要求为 `07/2026–09/2026 银行对账单`，期限仅写“邮件未注明”；原文框没有添加 `No deadline stated.` 或其他伪原文。
- 当前资料分别显示：
  - `bank-statement-2026-07.pdf` / 07/2026 / 王芳 / `10/02/2026 10:30 PT`
  - `bank-statement-2026-09.pdf` / 09/2026 / 李敏 / `10/16/2026`
- 没有为 September 补造时间，没有自动生成缺 August 任务，也没有新增文件类型或 10MB 限制。
- 状态明确为“已关联资料 · 尚未记录发送”；上传/关联不等于发送，发送不等于平台认可。
- 处理说明为空、没有新文件选择，保存按钮为禁用视觉；“去邮箱回复”仍是导航而非已发送动作。

## 哈希与尺寸

| 图片 | 尺寸 | SHA-256 |
|---|---:|---|
| `C02-v4.png` | 1484×1060 | `c609e37d3a2c61b2aae69a002b67a193d8aaef633d68ab36155dffbb75efde46` |
| `C09-active-v4.png` | 1489×1056 | `60238df015109cc0adb85b77f6f9d963b0c43689b043d57acf6edf4901f2831f` |
| `O-G-snapshot-preview-v2.png` | 1489×1056 | `ddc9e65ed8c85fd1b4a3bde08a7819ae08f942cc603be56fbc45cbffb6962f9e` |
| `O-G06-v2.png` | 1491×1055 | `a728cd053226f0018f384c324a73d03ee8f8e13f696af8f8abfae1f2ce22ece1` |
| `O-G07-v2.png` | 1490×1055 | `3c986767507f1b1ac2295b3a2c48d7761533297c6eebe36538dad9febd0144b1` |
| `O-G08-v2.png` | 1490×1055 | `39ef58f127b545ef2557154a1603e84fabd15db943b2ee8e54c52708a28aec43` |

## 参考基准

- `evidence/customer-gateway-crossflow-audit.md`
- `evidence/customer-crossflow-recheck.md`
- `evidence/review-gateway-overlays-01.md`
- `evidence/review-gateway-overlays-01-recheck.md`
- `plans/gateway-demo-data.md`
- `plans/gateway-attachment-fixture-addendum.md`
- `prompts/customer-crossflow-fixes/*.txt`
- `prompts/gateway-overlay-fixes/*.txt`

未修改六张图片、共享 coverage/README、共享 ledger 或应用代码。
