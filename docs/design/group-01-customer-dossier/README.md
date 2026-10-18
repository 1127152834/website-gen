# 第一组：客户档案与基础资料

<!-- customer-ui-consistency-20261017 -->
**10/17/2026 最新 UI 复核：**54 张现行原型已检查，29 张局部修正、25 张沿用。请从[当前分组图册](F:/projects/website-gen/docs/design/customer-ui-consistency-20261017/README.md)查看新版及前后对比。修订稿待确认，原图未覆盖；以下是历史版本与当时确认，不自动批准新图。本轮未写应用代码。
<!-- /customer-ui-consistency-20261017 -->


**10/17/2026 客户管理补齐（最新设计覆盖记录）：**已完成 [37 张补充原型](F:/projects/website-gen/docs/design/customer-management-completion-v1/README.md)：网站与邮箱、材料审核、网关申请、重复/差异、关联/公开信息、删除、资料操作归属及主要异常状态。均为静态候选，待用户确认；没有写应用代码，原 PNG 未覆盖。详情见[逐项清单](F:/projects/website-gen/docs/design/customer-management-completion-v1/coverage-status.md)。下文“待绘”等旧段落保留为当时记录，以此最新覆盖清单为准；旧版本的确认不会自动扩展到新图。

> **10/17/2026 最新局部修订：C01 v4 已绘制，待用户确认。**取消“手工建档”，仅保留“上传驾照建档”，支持单张或批量；必须先上传驾照。已与 v3 成对核对，其他业务数据及布局保留，原 PNG 不覆盖。见[三页对比记录](F:/projects/website-gen/docs/design/license-entry-ui-comparison-20261017.md)和[规则调整 03](F:/projects/website-gen/docs/design/scope-amendment-03-license-required.md)。以下旧确认仅代表各版本当时状态，不覆盖 v4 待确认状态。

本目录保存设计材料与确认记录。本轮已出图页面的局部修订已确认结束；未绘制的详情/异常态另列后续，不代表整组所有状态已画完。只含静态原型，无代码或真实业务操作。

**最新出图：C01 客户列表 v3、C02 档案概览 v2、C10 资料操作归属 v2，三张已由用户确认，本轮修订结束。**用户本轮“没问题，继续改客户列表、档案概览和资料操作归属页”已确认此前 O-C05、O-C07–O-C10 五张 v2；仍只做静态原型，不写代码。本轮保留原风格，清理客户级负责人、废止材料入口和旧日期格式；C10 将历史事件表改为当前资料归因表。[三图修改前后与核对记录](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-C02-C10-personnel-comparison.md)。此前对比文件保留为当时的过程快照，最新确认以 approvals.md 为准。

**10/17/2026 已确认：每次网关申请保存一份当时资料与最后操作人的定稿。**后续编辑/替换/移除当前资料不改写既有定稿；不做中间版本管理。此前 [15 张现有图稿审查](F:/projects/website-gen/docs/design/customer-attribution-ui-audit-2026-10-17.md)是重画前快照，随后陆续修订 C03 v3、C04 v2、C05 v2；其他图按修改清单继续，视觉风格保留。

**最新人员规则：准备材料不设客户负责人，仅申请网关时定申请负责人。**每个字段/每份附件需要定位最后成功录入、修改或文件操作的人；不做资料中间修改历史。以[规则调整 02](F:/projects/website-gen/docs/design/scope-amendment-02-latest-actor.md)为准。C03 v3、C04 v2、C05 v2 与对应编辑/文件面板已确认；C01/C02/C10 当前新稿也已确认。C10 v1 和 O-C06 旧稿仍只作历史留存，后者用途废止。

**最新统一规则：**日期展示/填写为 `MM/DD/YYYY`；州使用“缩写＋灰色小字英文全名”下拉；驾照附件仅显示上传状态、点击才查看图片。详见[全局界面规范](F:/projects/website-gen/docs/design/ui-conventions-v1.md)。个人资料当前为 v3，个人编辑为 v3，企业/银行编辑为 v2；三个编辑抽屉及企业状态/附件五面板 v2 已确认；C01/C02 新稿同步美国日期。旧稿保持原件，不以其旧格式覆盖现行规范。

**最新范围调整：**用户已确认 C04 企业资料、C05 银行资料，取消独立 C06 材料管理页。附件保留在所属资料页管理，材料审核仍保留；其他补充证明的最终入口待后续确认。以[取消材料页调整记录](F:/projects/website-gen/docs/design/scope-amendment-01-no-materials-page.md)为准。

**截图差异说明：**先前确认仍是对应时点的记录，不覆盖最新人员规则。原图不覆盖；旧“材料”入口、固定“客户负责人”以及操作归因缺项都须修订。企业/银行与附件操作流程可沿用，但不能把旧人员归属照搬实现。

## C01 客户列表 · v4 上传建档入口修订，待确认

沿用用户选中的第三种“列表＋右侧速览”布局。只移除“我负责的”、负责人筛选及六行客户负责人；搜索框利用原筛选空位，未新增筛选功能。申请负责人仅在选中客户的当前申请卡出现。

![C01 客户列表 v4](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v4.png)

v4 只把右上两个建档按钮合并为“上传驾照建档”，下方注明“支持单张或批量”。[修改前 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/C01-list-preview-v3.png)及原确认保留；六位客户、双状态、速览数据、附件数量、日期及原配色已逐项对照，无应用代码。

六位客户、原企业名称、2 位已完成/4 位未完成、搜索、5 个复制图标、外链及右侧双状态均保留；建档入口按上述 v4 统一。“附件概况”按类型进入个人/企业/银行资料，不再打开独立材料页；1/2/2/1 的数量未改。日期仅换美国格式，不改样例日期。[已选第三张原图](F:/projects/website-gen/docs/design/customer-list-options-v2/03-list-preview.png)仍在原路径，不覆盖。v3 是此前人员规则修订版本，本轮仅为入口更新至 v4，不表示提供多个备选。

## C02 档案概览 · v2 已确认归档

保留原两栏、个人摘要、企业与网站、当前申请、已获批记录及附件数量。头部为“当前档案”，负责人归当前 PayPal 申请；去独立材料页签，末页签改资料操作归属，材料审核保留。

![C02 档案概览 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v2.png)

驾照只显示已上传/查看，信息人工确认另行标注；企业资料、网站与邮箱提供各自入口。最近记录改为“最近申请记录”，保留原三条申请事实和时间，不变成资料编辑流水。附件数量 1/2/2/1/3 保持，前四类链接到所属资料页；其他证明 3 份仅展示数量，最终入口仍待申请模块细化。所有日期为 MM/DD/YYYY，原 24 小时制时间保留。概览不塞全部操作人，归因通过分类页和 C10 查看。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C02-overview-v1.png)保留，该静态图已确认，不代表运行页面已实现。

## C03 个人资料 · v3 已确认归档

只改人员归因与废止入口：客户头部改为“当前档案”，负责人放入当前申请卡；删除独立材料页签，末页签改为资料操作归属；每个字段/附件独立显示“操作人”，驾照 AI 识别发起与人工确认分开。点击姓名查看操作时间和来源的详情态尚未绘制，不代表图片可以真实交互。

![C03 个人资料 v3 操作人](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v3.png)

18 个字段原值、5 个复制入口、双地址、双状态、美国日期、无驾照缩略图和原布局保留。此前 [v2 修改前原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v2.png)及已确认的 [v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C03-personal-v1.png)均保持原字节；用户于 10/17/2026 确认 v3 并要求继续，此确认不包含尚未画出的操作详情或代码实现。

## O-C04 个人资料编辑抽屉 · v3 已确认归档

沿用 C03 风格和 18 个字段；日期使用 `MM/DD/YYYY`。两个州均改为下拉，显示缩写和灰色小字全名；图中左侧向上展开，右侧收起。菜单临时遮住部分左侧地址字段属于正常展开态，并未删除这些字段。保存只更新档案，不自动修改网站；只使变更字段涉及的审核结果需要更新。

![O-C04 个人资料编辑抽屉 v3](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v3.png)

头部空位显示只读“操作人：李敏 · 系统记录”和“查看字段操作人”。只对实际变更且保存成功的字段更新归因，未改字段和已有申请定稿不变；不代表整页原操作人都变成李敏。字段归因详情、未保存离开及保存失败状态尚未绘制。[v2 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v2.png)与[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-personal-edit-v1.png)均保留。

## C04 企业资料 · v2 已确认归档

分开展示外部办理记录、企业信息、企业地址和两份企业文件。只记录人工提供的结果；“已办结”不会自动推导 EIN 或文件已齐。主要入口是编辑企业资料、更新办理状态和上传文件。

![C04 企业资料 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-company-v2.png)

企业信息 3 项、地址 4 项及 2 份文件分别显示“操作人”；办理状态原“记录人：李敏”继续只代表该状态记录，不代替字段归因。旧材料页签、跳转及相关说明已清理。7 个原值、日期、2 个复制图标、上传和查看入口保持。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C04-company-v1.png)保留；v2 已由本轮用户继续确认，尚未绘制的详情和异常状态不在确认范围内。

## O-C04 企业资料编辑抽屉 · v2 已确认归档

七个字段：法定名称、销售品类、EIN、街道、城市、州、ZIP。品类支持选择和细分自定义；州显示缩写和灰色全名；保存不自动修改网站。附件与办理状态不混入此表单。

![O-C04 企业资料编辑 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-company-edit-v2.png)

操作人与字段归因入口放在标题右侧原空位，不挤压表单。保存仅更新成功变更的字段；未改字段、申请定稿保持不变，不自动修改网站。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-company-edit-v1.png)保留；v2 已由本轮用户“继续改”承接确认，未绘详情和异常态不在确认范围内。

## O-C05 企业办理状态弹窗 · v2 已确认归档

保留当前状态、目标状态下拉、可选说明和原值。状态操作人独立显示；“查看说明操作人”对应说明本身的归因，详情尚未绘制。本次“操作人”只读来自登录人。

![O-C05 企业办理状态 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v2.png)

示例当前与目标均为“已办结”，只补说明时不能将状态原操作人覆盖；只有实际变更且保存成功的项目更新操作人，未改、取消和失败不更新。已有申请定稿不变。不自动填写 EIN、生成企业文件或调用注册机构。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-company-status-v1.png)保留。

## C05 银行资料 · v2 已确认归档

公户信息仅录入客户提供的银行名称、账号和 Routing Number；下方是同一档案的一份介绍信、两份流水，不涉及申请开户或银行验证，也不推测缺哪个月份。

![C05 银行资料 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C05-bank-v2.png)

保留原三栏公户信息，每个字段单独加“操作人”；3 份附件逐行加操作人，旧材料跳转已清理。账号 10 个零、Routing 9 个零、3 查看＋3 下载、2 个复制图标和原日期已逐项比对。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/C05-bank-v1.png)保留；v2 已由本轮用户继续确认。

## O-C04 银行资料编辑抽屉 · v2 已确认归档

仅银行名称、公户账号、Routing Number 三个字段；号码按文本录入、保留前导零；不验证账户，也不申请开户。介绍信和流水留在银行资料页管理。

![O-C04 银行资料编辑 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-bank-edit-v2.png)

操作人与字段归因入口利用原帮助文字下的空白区，不下推输入框；未改字段和已有申请定稿不变。仍不验证账户或申请开户。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C04-bank-edit-v1.png)保留；v2 已由本轮用户“继续改”承接确认。

## O-C07 上传文件抽屉 · v2 已确认归档

从银行资料页进入，支持同类多份文件。两份流水仍在等待上传，底页已有文件仍为三份；移除队列项不等于删除已归档文件。

![O-C07 上传文件 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v2.png)

增加只读“操作人：李敏 · 系统记录”及逐份上传成功后记录的提示。成功文件单独记录，等待、失败或取消项不提前写成功归因；已有申请定稿不变。不向支付平台提交，也不推测缺哪个月份。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-upload-v1.png)保留。

## O-C08 当前文件预览大抽屉 · v2 已确认归档

明确标识“当前文件”，元数据显示该文件最近成功操作的操作人、操作类型和日期，不把查看者当成文件操作人。保持文件名、分类、大小、DEMO 文档、单页禁用翻页、缩放、下载、替换、移除与关闭。

![O-C08 当前文件预览 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v2.png)

预览不代表审核通过；当前文件替换或移除不影响已有申请定稿。申请定稿只读预览是另一个尚未绘制的状态，不应提供替换、移除入口；本图不冒充该状态。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C08-preview-v1.png)保留。

## O-C09 替换文件确认弹窗 · v2 已确认归档

原文件行显示该文件操作人；底部显示本次操作的登录人及“替换成功后记录”，两者含义分开。保留原文件、新文件、重新选择、取消与确认替换。

![O-C09 替换文件 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v2.png)

仅替换当前档案的一份文件，不保留中间版本；上传成功前旧文件仍可用，已有申请定稿不变。只有相关审核需更新，不自动提交平台；本图尚未执行替换。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C09-replace-v1.png)保留。

## O-C10 移除文件确认弹窗 · v2 已确认归档

文件行显示原文件操作人，底部显示本次登录人及“移除成功后记录”。保持目标文件、日期与取消、确认移除、关闭入口。

![O-C10 移除文件 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v2.png)

仅从当前档案移除此文件，不影响同类其他文件和已有申请定稿；当前档案无旧版恢复。不向外部平台撤回文件，也不自动改变申请状态；不暗示平台已经收到文件。本图未执行删除。[v1 原图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C10-remove-v1.png)保留。

附件四图是不同文件的独立操作示例，不是同一文件连续操作，也不是互斥风格方案。以银行资料为示例，其他所属资料页复用规范；[附件操作说明 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C07-C10-attachment-brief-v1.md)仅保留为旧流程参考，人员与定稿边界以本轮 [v2 对比说明](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C05-O-C10-v2-comparison.md)及规则调整 02 为准。上传进度/部分失败/重试、图片预览/读取异常、替换/移除失败及离开保护仍需后续绘制。

## C10 资料操作归属 · v2 银行资料筛选态已确认

沿用旧 C10 的应用壳、双状态、筛选条、白底表格和六行密度；必要变化是从历史事件改为当前字段/每份文件的最后成功操作归因。取消时间倒序、历史日期范围和“加载更早记录”。

![C10 资料操作归属 v2](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-attribution-v2.png)

本张选中银行资料，六项完整对应 C05：银行名称、账号、Routing，以及介绍信、两份流水。三字段操作人分别为王芳、陈杰、李敏；三份文件均为李敏。字段在前、文件在后；不把两份流水并成一条、不用申请负责人代替材料操作人。底部“银行资料 · 共 6 项”只指本筛选结果，不是全档案总数。

资料区域、类型和操作人可以筛选；“查看字段”拟进入对应字段归因详情，“查看文件”进入当前文件预览。个人/企业表体、筛选展开、字段详情、空/失败/已移除等状态尚未绘制，不代表这些交互已实现。银行三个字段的 09/28/2026 10:30/10:35/10:40 AM 是新增虚构 DEMO 时间；附件时间继承旧 C10 样例。不是从运行系统恢复记录，也不自动判定员工责任。已有申请定稿中的值与归因不随当前变化。

## C10 旧稿 / O-C06 · 历史与废止方案

- [C10 操作记录 v1](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-activity-v1.png)未获确认，只作修改前基线；其中申请事件不再放入 C10，归申请模块。
- [O-C06 客户负责人调整旧图](F:/projects/website-gen/docs/design/group-01-customer-dossier/O-C06-owner-change-v1.png)用途废止，不再从客户头部或建档流程进入。申请负责人如何指定/调整尚待确认，不能把旧图直接改名沿用。
- [旧说明](F:/projects/website-gen/docs/design/group-01-customer-dossier/C10-O-C06-activity-owner-brief-v1.md)保留为过程材料，以规则调整 02 为准。

## 已取消的历史方案

C06 独立材料页已从有效页面清单和主图册中移除。[原图仅作历史留存](F:/projects/website-gen/docs/design/group-01-customer-dossier/C06-materials-v1.png)，不代表保留实现范围，没有删除任何业务附件。

企业地址、EIN、银行数字、人员与时间均为虚构示例。既有主资料页、编辑抽屉及企业状态/附件五面板已确认；C01 v3、C02 v2、C10 v2 已确认。本轮仅更新确认状态，32 个图稿记录均保持原字节。后续还需 C10 个人/企业筛选态、操作人详情、未保存/失败/并发等状态、删除影响页以及只读申请定稿流程；申请人员权限和非管理员删除客户权限仍待确认。

此前覆盖层灰底只修必要的客户负责人、可见申请负责人及末页签，没有重绘全部底页归因；完整字段/文件操作人以已确认的 C03 v3、C04 v2、C05 v2 主图为准。被抽屉遮住的页签不能从像素直接验证。三个“查看字段操作人”和“查看说明操作人”的详情态尚待绘制，不是可点击系统。

本轮 C02 初稿页头日期误改为 10/17/2026，已单点恢复 10/16/2026 并重新比对；本页只展示最终候选。原图、Image Gen 提示词、修改前后对比及回退证据均保留。

- 全部为示例数据，仅静态原型，不是运行中的系统。
- 客户完成与当前申请分别展示，不推测下一步或具体缺件。
- 文件数量不代表符合平台审核要求。
- 详细分组和后续顺序：[模块分组](F:/projects/website-gen/docs/design/prototype-groups-v1.md)。
- 用户确认归档记录：[approvals.md](F:/projects/website-gen/docs/design/group-01-customer-dossier/approvals.md)。
- 校验及审阅结果：[manifest.json](F:/projects/website-gen/docs/design/group-01-customer-dossier/manifest.json)。
