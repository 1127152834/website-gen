# 原型图模块分组与确认进度

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


**10/17/2026 客户管理补齐（最新设计覆盖记录）：**已完成 [37 张补充原型](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)：网站与邮箱、材料审核、网关申请、重复/差异、关联/公开信息、删除、资料操作归属及主要异常状态。均为静态候选，待用户确认；没有写应用代码，原 PNG 未覆盖。详情见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)。下文“待绘”等旧段落保留为当时记录，以此最新覆盖清单为准；旧版本的确认不会自动扩展到新图。

**10/17/2026 最新入口修订：**[C01 v4](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png)、[C12 v4](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v4.png)、[C13 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v3.png)已绘制，待用户确认。统一上传驾照建档（单张或批量），无独立手工建档；人工转录只依附已上传原图。三对已核查，旧图保留，未改 C14 或应用代码。见[对比记录](F:/projects/website-gen/docs/design/license-entry-ui-comparison-20261017.md)。以下此前各轮确认均为对应历史版本状态。

日期：2026-10-16。用户已确认[全应用页面清单 v1](F:/projects/website-gen/docs/design/application-page-inventory-v1.md)，并要求按模块与业务流程逐组绘制。

**最新出图进度：**C03 个人资料 v3、C04 企业资料 v2、C05 银行资料 v2，O-C04 个人编辑 v3、企业编辑 v2、银行编辑 v2，以及 O-C05 企业状态 v2、O-C07–O-C10 附件覆盖层 v2 已确认；确认均只覆盖对应静态界面，不扩大为代码、操作人详情、异常态或权限批准。新完成的 [C01 客户列表 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png)、[C02 档案概览 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v2.png)、[C10 资料操作归属 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-attribution-v2.png)已由用户明确确认，本轮修订结束；三页前后对比见 [C01/C02/C10 人员规则记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-C02-C10-personnel-comparison.md)。此前主页面、编辑抽屉和五张覆盖层对比分别见 [C04/C05 v2 记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-C05-v2-comparison.md)、[O-C04 人员规则记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-editors-personnel-comparison.md)、[O-C05/O-C07–O-C10 v2 记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-O-C10-v2-comparison.md)。本轮没有改应用代码或新增页面编号；此前静态审查及出图说明仍是对应时点快照。

**10/17/2026 早期规则确认：**每次申请保存一份当时资料与最后操作人的定稿已确认；当前资料仍无中间版本。当时已完成 [15 张现有图稿静态审查](F:/projects/website-gen/docs/design/customer-attribution-ui-audit-2026-10-17.md)，尚未生成后续修订图，也未写应用代码。下面先前批准仅对应当时流程，不覆盖新归因/定稿规则。

## 执行边界

- 本阶段只有 Product Design 静态原型图。没有前端代码、可点击演示、后台接入或真实数据操作。
- 原清单是范围快照，不覆盖；本文件记录其已获确认及之后的出图进度。
- 每组先确定主页面布局，再按同一风格画子页、弹窗、抽屉和关键异常状态。一张图一个界面，不用一张拼图充当多页完成。
- 客户列表原确认基线为已选[第三张](F:/projects/website-gen/docs/design/customer-list-options-v2/03-list-preview.png)；其[人员规则修订稿 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png)当前已确认。其他旧稿只作历史参考，不自动视为当前确认稿。
- 跨模块入口使用同一对象和记录，不重复创建客户、网站、邮箱或申请结果；已确认的每次申请只读资料定稿是有明确用途的时点副本，不是第二套可编辑客户档案。
- 原型图确认不等于授权写代码，技术实现仍需后续明确要求。
- 全局遵循[界面规范](F:/projects/website-gen/docs/design/ui-conventions-v1.md)：美国日期格式 `MM/DD/YYYY`，固定选项优先下拉，州缩写后跟灰色英文全名，驾照仅显示上传状态。旧图作为历史参考，格式差异不能覆盖新规范。
- 后续用户已取消 C06 独立材料页；原清单仍是历史快照，以[范围调整 01](F:/projects/website-gen/docs/design/scope-amendment-01-no-materials-page.md)覆盖相关条目。当时范围为 132 项，C06 原图退休保留；材料审核和通用附件操作继续保留。
- **最新人员规则覆盖：**准备资料不设客户负责人，字段/附件只保留当前最后操作归因，申请网关时才确定申请负责人。以[规则调整 02](F:/projects/website-gen/docs/design/scope-amendment-02-latest-actor.md)为准。清单编号用于追踪，不代表全部交互已确定；O-C06 旧客户改派用途废止、暂挂待重规划，不默认保留一个新的申请改派功能。
- **最新建档前置：**所有新客户先上传驾照正面；C11/O-C01 独立手工建档废止，单张/多张共用 C12。有效追踪范围更新为 130（含 O-C06 暂挂项），第 02 组为 5 个有效界面。以[规则调整 03](F:/projects/website-gen/docs/design/scope-amendment-03-license-required.md)为准；C01 v4/C12 v4/C13 v3 已局部修订并待确认，不覆盖旧 PNG。

## 模块分组

| 顺序 | 模块 | 页面/子视图 ID | 弹窗/抽屉 ID | 组内业务顺序 | 进度 |
| --- | --- | --- | --- | --- | --- |
| 01 | 客户档案与基础资料 | C01–C05、C10 | O-C04–O-C10、O-C15–O-C16（O-C06 暂挂重规划） | 列表 → 概览 → 个人 → 企业 → 银行 → 当前资料操作归属；附件在所属页管理 | 原人员修订已确认；新增C10个人/企业/详情、删除及共用异常图已出，待确认；C06取消、O-C06旧用途废止 |
| 02 | 建档与驾照识别 | C12–C14 | O-C02–O-C03 | 上传 1 张或多张驾照正面 → 识别/人工转录 → 人工核对 → 重复处理 → 建档结果与失败项 | C11/O-C01废止；C12/C13入口修订和C14正常样例保留；重复/差异、人工转录、上传混合和结果未知图已出，待确认 |
| 03 | 客户网站关联与现有建站 | C07、W01–W12 | O-C11–O-C14、O-W01–O-W14 | 客户网站/邮箱关联 → 企业就绪检查 → 建站向导 → 批次 → 站点概况、对话、交易发信、变更、复核 → 总览 | C07及O-C11–O-C14已出，待确认；完整W模块未绘制 |
| 04 | 材料审核与网关申请 | C08–C09、G01–G04 | O-G01–O-G12 | 参考审核 → 开始申请 → 详情与来源 → 明确要求及处理记录 → 获批/拒绝 → 后续申请与误判纠正 | C08/C09及O-G01–O-G04已出，待确认；全局G及其余覆盖层未绘制 |
| 05 | 邮件协作与邮件 AI | M01–M08、S09–S10 | O-M01–O-M09、O-S09–O-S10 | 邮箱连接/收件 → 阅读/翻译 → 人工回复 → 预审授权 → 申请事项/待确认 → 证据关联与历史补审 | 未绘制 |
| 06 | 账号域名与 Grist | R01–R04、T01–T03 | O-R01–O-R03 | 接入账号 → 同步域名 → 查看资源关联 → 既有放弃操作；Grist 外壳、登录与设置入口 | 未绘制 |
| 07 | 模型、集成与内部用户 | S01–S08 | O-S01–O-S08 | 厂商/模型 → 用途 → CJ/邮箱/Grist → 账户安全 → 内部用户新增/启停/重置 | 未绘制 |
| 08 | 全局体验与公共状态 | A01–A09 | O-A01–O-A05 | 登录/改密 → 应用壳/搜索/用户菜单/助手 → 身份复核、权限、异常、并发修改和未保存保护 | 客户场景已补不存在/无权限/加载/失败/未保存/并发；其余全局页未绘制 |

注：T03 引用 S06 的同一设置页；O-A04/O-A05 为多模块共用状态；它们不代表重建多套界面。C02 头部/页签先确定后，C03–C10 使用相同骨架。W10 是网站交易邮件配置，M01–M04 是收发信，两者不混用。

## 第一组：当前确认点

### C01 客户列表——原第三版已确认，人员规则 v3 已确认

- 文件：[客户列表与右侧速览](F:/projects/website-gen/docs/design/customer-list-options-v2/03-list-preview.png)。
- 用户此前选定第三版，本轮要求纳入[第一组设计材料](F:/projects/website-gen/docs/design/group-01-customer-dossier/README.md)。
- 直接引用已选原图，不重新生成或复制；原三稿目录保留历史快照，当前选择状态以本组确认记录为准。
- 当前确认稿 [C01-list-preview-v3.png](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png)保持一客户一行、六条客户样例及原完成状态；移除“我负责的”、负责人筛选和各行客户负责人，搜索占用释放出的筛选空间。
- 右侧速览标为“当前档案”，客户完成状态与当前申请状态继续分开；申请负责人仅出现在 PayPal 当前申请卡。材料记录改为附件概况，按驾照、企业、银行所属页进入，不恢复独立材料页或虚构下一步。

### C02 客户档案详情首页——v1 已确认，人员规则 v2 已确认

- 文件：[C02 概览 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v1.png)
- 入口：C01 列表右侧“打开完整档案”。返回后应保留列表选中项及筛选。
- 示例客户沿用 Alex Morgan / C001 / Northline LLC，避免不同页面反复换人。
- 显示“客户已完成，首个有效获批为 Stripe”和“当前 PayPal 待补件”两个事实。
- 概览只保留个人联系摘要、企业/网站、材料数量、申请记录和最近发生事项；全部字段留给分类页签。
- 不推测缺件、不显示下一步，不用文件数量代表审核通过；不提供当前在办时的第二次开始按钮。
- 此图新增的完整导航来自已确认清单；原列表图的精简侧栏不限制后续导航范围。
- 用户已于 2026-10-16 明确确认此图并要求归档；保留原 PNG 不作改动，作为后续页签的视觉基准。见[确认记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/approvals.md)。
- 当前确认稿 [C02-overview-v2.png](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v2.png)保留 Alex Morgan、双状态、摘要值、附件份数和申请记录；页头及全部可见日期统一为 `MM/DD/YYYY`，当前申请卡显示申请负责人，页头客户负责人改为“当前档案”。
- 当前确认稿去掉独立“材料”页签，末页签改为“资料操作归属”；企业资料与网站/邮箱入口分开，驾照“已上传”与“信息已人工确认”分开。最近事项明确为“最近申请记录”，不混入字段修改历史，也不在概览塞入各字段操作人。

### C03 个人资料——v3 已确认归档

- 当前文件：[C03 个人资料 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v3.png)；[v2 修改前图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v2.png)及此前已确认的 [v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v1.png) 保留原件。
- 保留既有布局、双状态和个人资料选中态；客户负责人替换为当前档案、申请负责人加入对应申请卡。只去独立材料页签并将末项改为资料操作归属。
- 四个资料卡归因列名统一“操作人”，每个字段/附件分别展示；18 字段、5 复制图标与原值已前后核对。驾照导入/识别发起为李敏、人工确认王芳，驾照号后来修改为陈杰，仅为演示身份分工，不是真实员工操作记录。
- 基本信息展示 FN、LN、生日、示例 SSN、电话、个人邮箱和可选信誉分；驾照区展示号码、可选签发日期、到期日期、正面和可选反面。
- 驾照地址：`78 Sample St, Dallas, TX 75201`，来源为驾照正面提取、人工确认。
- 当前住址：`128 Example Ave, Austin, TX 78701`，来源为客户提供，与已确认 C02 保持一致。
- 两地址独立展示、独立保存，地址不同不自动判为错误，不放自动覆盖或同步按钮。
- SSN `000-00-0000`、驾照号 `DEMO-DL-0001` 均为明确不可用于真实业务的演示内容，不使用真实客户证件。
- 驾照正面显示“已上传＋查看”，可选反面显示“未上传（可选）”，不展示缩略图或文件名；点击查看才进入图片预览。
- 生日、签发、到期、页头和首次获批日期均为 `MM/DD/YYYY`，为控制局部改动，页头示例日期仍保留 10/16/2026。v3 已由本轮“ok 继续改后面的吧”确认，不包含尚未绘制的操作详情态。

### O-C04 个人资料编辑抽屉——v3 已确认

- 当前确认图：[个人资料编辑抽屉 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v3.png)。[v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v2.png) 与 [v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v1.png) 均保留为历史稿。本图仅覆盖 O-C04 的个人资料分支；企业、银行分支见后续确认图。
- 入口：C03 的“编辑个人资料”；右侧宽抽屉，底页减弱，固定头部和保存区。较窄窗口应允许表单独立滚动；本静态图不验证响应式行为。
- 基本信息 7 项、驾照信息 3 项、驾照地址和当前住址各 4 项，共 18 个字段；可选信誉分留空、可选签发日期有示例值，不加入所有字段必填的规则。
- 两个地址并排、分别编辑和保存，无自动同步、覆盖或同址勾选；使用与已确认 C03 相同的示例值。
- 两个州改为下拉，缩写后跟较小灰色英文全名。左侧菜单向上展开、右侧收起，保存区不被遮盖；菜单正常覆盖部分左侧地址字段。日期输入和底页日期统一为美国格式，手动输入和日历选择使用同一显示规则。
- 本抽屉只编辑字段，不改变驾照附件；附件上传、替换和预览从个人资料页进入通用覆盖层，不再跳独立材料页。
- v3 只在个人头部右侧原空位增加只读“操作人：李敏 · 系统记录”和“查看字段操作人”，不下推表单。原字段各自操作人继续以已确认 C03 v3 为准；当前登录操作人不会覆盖整页原归因，入口所指的具体详情态尚未绘制。
- “保存修改”只让实际发生变化且保存成功的字段更新操作人；未改字段及既有申请定稿不变。仍只保存客户当前档案，不自动修改线上网站，也不触发网关申请。实际变更字段涉及的审核结果标为需更新；其余结果保留，不自动全量复审。
- 保存前保留原值；保存成功才刷新 C03。保存失败保留输入，不关闭抽屉；有未保存改动时关闭/取消需要离开确认。异常状态后续分别出图，本张不叠加异常弹窗。
- 灰底仅局部把旧客户负责人改为“当前档案”，未重绘被遮住的全部主页面归因；主页面以 C03 v3 为准。用户以“继续改”确认本静态正常态；没有实现或批准表单、校验、保存、人员详情、滚动、响应式及异常交互。

### C04 企业资料——v2 已确认

- 当前 [企业资料 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-company-v2.png)补 7 字段和 2 文件操作人，移除客户负责人及废止材料入口，当前申请卡补申请负责人；原字段、状态记录、按钮和 2 个复制图标不变。用户本轮“继续 还有需要修改的嘛”确认该图；下方 v1 仅历史参考，不覆盖最新 v2。

- [企业资料 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-company-v1.png)。外部办理状态、记录人与日期独立展示；法定名称、品类、EIN 与企业地址分组；成立文件和章程各一份。
- 仅记录外部办理事实，不自动注册企业；“已办结”不等于系统推定文件或 EIN 齐备。旧材料导航及跳转已废止，企业文件直接在本页管理。原图保留不覆盖。

### C05 银行资料——v2 已确认

- 当前 [银行资料 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C05-bank-v2.png)保留三栏公户信息，3 字段和 3 文件独立显示操作人；移除客户负责人及废止材料入口，当前申请卡补申请负责人。原值、10/9 位零、6 个文件操作和 2 个复制图标均保持。用户本轮“继续 还有需要修改的嘛”确认该图；下方 v1 仅历史参考。

- [银行资料 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C05-bank-v1.png)。公户字段可复制，银行介绍信一份、银行流水两份，保持 C02 材料样例数量一致。
- 不提供申请开户，不宣称账户经过验证，不推测所缺月份。银行附件直接在本页管理，统一文件记录、不复制；旧材料导航及跳转已废止。

### C06 材料管理——已取消，仅历史留存

- [旧图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C06-materials-v1.png)不再属于有效设计范围，不删除其文件。上传/预览/替换/移除/单文件下载下沉到所属资料页，材料审核 C08 保留。
- 其他证明入口待确认；旧三页出图说明是历史方案，不覆盖本次范围调整。

### O-C04 企业与银行编辑抽屉——人员归因修订稿已确认

- 当前确认图 [O-C04 企业编辑 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-company-edit-v2.png)：保留七个字段、可自定义品类、州缩写＋灰色全名及“不自动修改网站公开信息”的原边界。标题右侧空位增加只读“操作人：李敏 · 系统记录”和“查看字段操作人”，不下推表单。
- 当前确认图 [O-C04 银行编辑 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-bank-edit-v2.png)：保留银行名称、10 位账户号、9 位 routing 号与前导零，不验证账户、不申请开户。人员只读行放在两条原说明下方空白区，不下推表单。
- 两个抽屉均明确：只有实际变化且保存成功的字段更新操作人，未改字段和已有申请定稿不变；主页面字段原归因分别以已确认 C04 v2、C05 v2 为准，当前登录操作人不替代所有原操作人。“查看字段操作人”具体详情态尚未绘制。
- [O-C04 企业编辑 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-company-edit-v1.png)与 [O-C04 银行编辑 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-bank-edit-v1.png)保留此前确认与原字节，只作为归因修订前历史稿，不冒充当前候选。
- 灰底只局部移除旧客户负责人；银行底页末页签改为“资料操作归属”。没有重绘灰底全部字段归因，不应以被遮住部分判断主页面缺项。
- 正常态不等于保存交互已经实现；关闭时未保存保护、保存失败保留输入等仍待独立设计。用户“继续改”的确认仅覆盖三个 O-C04 当前静态正常态。

### O-C05 企业办理状态——v2 人员归因修订稿已确认

- 当前确认图：[企业办理状态 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v2.png)。[v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v1.png)保留此前确认与原字节，作为归因修订前历史基线。
- 状态与可选说明分别归因；状态操作人保留李敏与 `09/25/2026`，新增“查看说明操作人”入口但不捏造此前说明操作人，入口详情态尚未绘制。
- “操作人：李敏 · 系统记录”是本次登录身份；仅实际变化且保存成功的状态或说明更新各自操作人。状态未变只改说明时不改状态归因，失败、取消、无变化及既有申请定稿均不变。
- 原状态值、说明、下拉、按钮和“不会自动填写 EIN、生成企业文件或调用注册机构”边界保持。灰底只局部撤掉客户负责人并在可见申请卡增加申请负责人，邮件 AI 来源保留；未整幅重画企业主页面归因。

### O-C07–O-C10 附件操作覆盖层——v2 人员归因修订稿已确认

- 当前确认图 [O-C07 上传 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v2.png)：保留银行分类、两份待上传文件、逐项移出队列、可选说明及按钮。待上传不算成功、不提前增加底页 3 份数量；逐份成功后才分别记录系统操作人，不自动提交网关，不影响已有申请定稿。
- 当前确认图 [O-C08 预览 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v2.png)：本图仍是客户当前文件预览，展示当前文件操作人、动作和日期，保留原 DEMO PDF、页码/缩放、下载、替换及移除入口。申请定稿只读预览是后续独立态，本轮未画。
- 当前确认图 [O-C09 替换 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v2.png)：当前文件原操作人与本次登录操作人分开；仅替换成功后更新当前文件及归因，失败时旧文件和原归因保持。替换只限当前档案，已有申请定稿不变。
- 当前确认图 [O-C10 移除 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v2.png)：当前文件原操作人与本次登录操作人分开；成功才记录移除操作。仅从当前档案移除，不撤回外部文件、不影响同类其他附件、申请状态或既有申请定稿，不能套用为整个客户删除。
- [O-C07 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v1.png)、[O-C08 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v1.png)、[O-C09 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v1.png)、[O-C10 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v1.png)及[详细设计说明](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-C10-attachment-brief-v1.md)保留为历史基线，不覆盖旧确认。
- 五张 v2 的原值和控件均保留；灰底只做必要人员语义修订，不整幅重画公司/银行主页面。被抽屉遮住的末页签不能据静态像素声称已直接验证。上传进度、部分失败、读取异常、重试、未保存保护和操作人详情等异常/详情态仍未完成。
- 五图前后对比见 [O-C05/O-C07–O-C10 v2 记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-O-C10-v2-comparison.md)；用户已确认本节 5 张 v2 静态图，异常态、操作人详情和申请定稿预览仍不在本次确认范围。

### C10 资料操作归属——v2 银行筛选态已确认；旧客户负责人调整用途废止

- [C10 操作记录 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-activity-v1.png)：历史草稿，未获确认，不再作为当前方向。
- 当前确认稿 [C10-attribution-v2.png](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-attribution-v2.png)是当前资料归属查看页，不是编辑历史或全版本审计。选中“银行资料”时以六项表展示资料项、当前值、操作人、来源、时间和查看入口；其他资料筛选态及操作人详情尚未绘制。银行名称、公户账号、Routing Number 三项的 `09/28/2026 10:30/10:35/10:40 AM` 为本轮新增的虚构 DEMO 时间，不是旧稿证据、真实查询或已确认历史。
- [O-C06 客户负责人调整 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C06-owner-change-v1.png)：旧用途废止，准备资料不再指派负责人；申请负责人指定/改派权限尚待确认。
- [旧说明](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-O-C06-activity-owner-brief-v1.md)只作历史记录。新规则和受影响页面以规则调整 02 为准，没有声称已重画全部图稿。

### 本组接下来

1. C03 v3、C04 v2、C05 v2，O-C04 个人 v3、企业 v2、银行 v2，以及 O-C05、O-C07–O-C10 共 5 张 v2 的当前静态态已确认；确认不扩展到代码、详情态、异常态或权限。
2. C01 v3、C02 v2、C10 v2 已确认，本轮已出图页面修订结束；三页前后对比见 [C01/C02/C10 人员规则记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-C02-C10-personnel-comparison.md)。旧图继续保留，不批量覆盖。
3. 申请时点定稿已确认，但第 04 组 O-G04 开始申请、G02 申请详情以及申请定稿只读附件预览尚未绘制，不新增顶级材料页。
4. O-C06 旧客户负责人调整用途已废止；申请负责人指定/改派权限和非管理员删除客户权限仍待确认，不能由本轮“操作人”展示反推权限。
5. 之后仍需设计其他资料筛选态、字段/说明/文件操作人详情、异常态和申请定稿流程；其他证明入口仍待确认。本轮没有写代码、增加编号或批准这些后续界面。

## 第 02 组：建档与驾照识别——必须先上传驾照，入口修订稿待确认

用户此前接受 [C12 v3](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C12-batch-upload-v3.png)作为继续设计参考，随后 [C13 人工核对 v2](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C13-recognition-review-v2.png)与 [C14 建档结果 v2](F:/projects/website-gen/docs/design/group-02-customer-onboarding/C14-creation-results-v2.png)已出图。最新纠正明确没有驾照不能建档，因此 C11/O-C01 撤回，C12 v4/C13 v3 相关入口文案已局部修订并待确认；不能把继续设计的授权理解为批准无驾照创建。见[第 02 组图册](F:/projects/website-gen/docs/design/group-02-customer-onboarding/README.md)和[三页流程约定](F:/projects/website-gen/docs/design/group-02-customer-onboarding/flow-brief-v1.md)。本组现有 5 个有效界面；没有应用代码、真实识别或保存验证。

| 界面 | 责任与边界 |
| --- | --- |
| C11 / O-C01 手工建档抽屉 | **已废止，非待画页面。**无驾照快建图仅历史留存，不允许先建空档案后补驾照 |
| C12 上传驾照建档 | **v4 已绘制待确认，v3 原图保留。**支持 1 张或多张正面，逐文件拆分上传与识别状态；失败可对已上传图片人工转录，反面后补；不提供无图创建 |
| C13 识别结果人工核对 | **v3 已绘制待确认，v2 原图保留。**原图对照字段，纠正/确认/跳过；上传、识别发起和人工核对操作人分开。确认只保存核对结果，提交新建前仍须有可关联的已上传正面 |
| O-C02 重复线索处理 | 重复图片、驾照号或同名只提示，由员工选关联/另建/跳过，不自动合并；另建仍必须已有驾照图片 |
| O-C03 识别字段差异确认 | 关联已有或重新识别时逐项确认，不覆盖当前住址、SSN等非识别来源字段 |
| C14 建档结果 | **v2 已绘制、待确认。**成功、关联、跳过、失败、未处理分开；可打开档案或继续处理，结果未知不盲目重建 |

本轮三页用同一虚构批次的 5 项贯通：最终结果为已创建 1、已关联 1、失败 1、未处理 1、跳过 1；C13 当前画面与 C14 后续提交结果是两个时点，不冒充一次点击立即产生全部结果。客户不参与系统操作，准备阶段无负责人，沿用美国日期、州缩写与灰色全名及操作人规则。

尚未绘制 O-C02 重复处理、O-C03 差异确认，二者仅承接带已上传驾照的流程。C11/O-C01 不再续画；C01/C12/C13 入口局部修订已出图，待用户确认。上传中/取消/部分上传失败、空结果、结果未知、离开保护等异常态也未全部覆盖，不能将三张正常流程候选标成整组完成。

## 证据与回退

- 原范围清单 SHA-256：`C419018E941858CA9B41259E0E715CFE54B9584E74D5162B3C66DC4BDDFD021B`。
- 已选列表图 SHA-256：`EA4EE3A22C41CB3CAD971901E540389BFF8FB6A1CC9389D9EC478EBE1420AB6E`。
- 本阶段仅维护设计文档、静态图和校验记录；旧 PNG 均保留原件，O-C04 与 O-C05/O-C07–O-C10 的已确认修订图均以新版本独立保存，C01/C02/C10 已确认新稿也不覆盖历史图。
- 不采用首稿时保留旧稿并生成新版本；没有部署，不涉及业务数据回滚。
- 组内文件哈希及覆盖检查见[manifest.json](F:/projects/website-gen/docs/design/group-01-customer-dossier/manifest.json)。
