# 建档模块 UI 一致性复核

复核日期：10/17/2026（America/Los_Angeles）  
范围：现行 C12–C14 三张主流程，以及 completion-v1/01-onboarding 五张补图。  
方式：逐张使用 `view_image` 查看原始 PNG，并与以下两张基准实际对照：

- 配色基准：`group-02-customer-onboarding/references/C01-user-color-reference-20261017.png`
- 档案结构基准：`group-01-customer-dossier/C03-personal-v3.png`

本文件仅记录静态图证据和最小修复建议，不表示功能已经实现。本阶段没有修改 PNG。

## 壳层分型说明

- 客户列表使用紧凑导航，客户档案及建档流程使用完整导航，这是当前既有分型。
- 本轮不把两类导航强行统一；只检查同一建档流程内部的配色、按钮、边距、状态和命名漂移。
- 八张图的主内容左边界、顶部日期区、深海军蓝主按钮、白底灰蓝分隔线总体与基准一致。

## 8 张覆盖表

| 文件 | 实看结果 | 基准一致性 | 关联问题 |
| --- | --- | --- | --- |
| `group-02-customer-onboarding/C12-batch-upload-v4.png` | 已查看 | 深海军蓝按钮、上传区、状态色和完整导航一致；日期为美国格式 | U-02 的颜色参照来源 |
| `group-02-customer-onboarding/C13-recognition-review-v3.png` | 已查看 | 三栏宽度、顶部步骤、底部动作区与 C03 的完整壳层一致 | U-02 |
| `group-02-customer-onboarding/C14-creation-results-v2.png` | 已查看 | 表格、状态标签、按钮层级和边距一致 | U-01 |
| `completion-v1/01-onboarding/O-C02-duplicate-v1.png` | 已查看 | 右抽屉、遮罩、主/次按钮层级一致；字段逻辑完整 | U-02 |
| `completion-v1/01-onboarding/O-C03-differences-v1.png` | 已查看 | 抽屉表格与 C03 字段密度一致；MM/DD/YYYY 与候选/当前值边界正确 | U-02 |
| `completion-v1/01-onboarding/C12-upload-states-v1.png` | 已查看 | 上传页壳层、主按钮禁用态和表格对齐一致 | U-03 |
| `completion-v1/01-onboarding/C13-manual-transcription-v1.png` | 已查看 | 三栏结构、日期控件、州下拉和底部按钮与主 C13 一致 | U-02 |
| `completion-v1/01-onboarding/C14-unknown-result-v1.png` | 已查看 | 结果表、警示条、状态标签和按钮层级与主 C14 一致 | 通过，无需改动 |

## 编号问题

### U-01 · C14 面包屑仍使用旧模块名

- **文件**：`group-02-customer-onboarding/C14-creation-results-v2.png`
- **位置**：页面左上方面包屑。
- **原证据**：C12 v4、C13 v3 与 completion C14 均使用“上传驾照建档”；此图仍写“客户 / 批量建档 / 建档结果”。
- **影响**：同一三步流程在最后一步突然更换模块名称，容易被理解为进入另一套批量工具。
- **最小修复**：只把面包屑“批量建档”改为“上传驾照建档”；页面标题、步骤条和表格不动。
- **严重度**：中。

### U-02 · “疑似重复/重复待处理”在同一流程中混用警告橙与错误红

- **文件**：
  - `group-02-customer-onboarding/C13-recognition-review-v3.png`
  - `completion-v1/01-onboarding/O-C02-duplicate-v1.png`
  - `completion-v1/01-onboarding/O-C03-differences-v1.png`（遮罩底页）
  - `completion-v1/01-onboarding/C13-manual-transcription-v1.png`（左侧 03-alex 行）
- **位置**：`03-alex.jpg` 的“重复待处理”标签，以及 O-C02 的“疑似重复”标签。
- **原证据**：C12 v4 对同一 `03-alex.jpg` 使用橙色圆点与橙色“已识别 · 疑似重复”；进入 C13 后同一业务事实变为红底红字。红色在同组已经用于“识别失败/创建失败”等确定错误。
- **影响**：把需要人工决定的候选重复误表达成确定失败，破坏状态色语义。
- **最小修复**：仅把上述重复候选标签改为 C12 v4 同款警告橙；“识别失败/上传失败/创建失败”继续使用红色，操作链接继续使用蓝色。不改文字和布局。
- **严重度**：中。

### U-03 · 上传状态汇总把“格式不支持”并入“失败 2”

- **文件**：`completion-v1/01-onboarding/C12-upload-states-v1.png`
- **位置**：上传区下方汇总行。
- **原证据**：表格实际包含 `04-front.jpg · 上传失败` 与 `05-document.pdf · 格式不支持` 两种不同状态，但汇总统一写成红色“失败 2”。行内已经明确后者未进入上传/识别。
- **影响**：用户无法从汇总区分网络上传失败和选择了不支持的文件；也与逐文件状态文案不完全守恒。
- **最小修复**：将汇总拆成“上传失败 1 · 格式不支持 1”，或合并为中性“待处理 2”；保持总数 5、已上传 1、上传中 1、等待 1 和禁用的“进入人工核对（0）”不变。
- **严重度**：低至中。

## 无需修订的可见边界

- 所有日期均使用 `MM/DD/YYYY`，没有发现中国日期格式。
- 主按钮统一为深海军蓝；次按钮为白底描边；禁用按钮为灰蓝，未发现紫色渐变或亮蓝主按钮漂移。
- O-C02 仅保存重复处理决定；O-C03 只暂存字段选择；两者均未提前宣称已关联或已覆盖资料。
- O-C03 的灰底新证件原图与选中的识别候选现已一致：`78 Sample Street`、`08/15/2031`；当前档案仍为 `78 Sample St`、`08/15/2030`。
- C13 人工转录仍明确基于已上传原图，未把人工转录冒充 AI 成功。
- C14 结果未知稿只提供“核实结果”，没有把未知当失败或提供盲目重试。

## 修图优先级

1. U-01：单一文字修正。
2. U-02：统一重复候选的警告色语义。
3. U-03：修正上传汇总分类文字；不调整版式。
