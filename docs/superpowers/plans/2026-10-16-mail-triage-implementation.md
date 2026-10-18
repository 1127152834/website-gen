# Mail Triage and Application Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户选定的第三版「申请进度看板」实现为可追溯的邮件预审模块：指定 AI 只读邮件正文、分类并给出短标签，系统管理真实待办、申请归组和人工核对，邮箱按层级独立展示。

**Architecture:** 现有 IMAP 缓存写入与本地预审登记同事务提交，SQLite 持久化队列异步调用独立 `mail_triage` 模型。模型只提取建议；服务器校验证据、身份、版本和权限后，由确定性投影器生成三列申请看板。保留原邮箱、翻译和发送流程，所有自动化均可暂停、追踪和撤销，不给模型工具能力。

**Tech Stack:** Node.js >=24（当前 24.18.1）、TypeScript、node:sqlite、React、TanStack Router/Query、现有 Radix/Lucide/Tailwind、Zod、pi-ai 1.2.0、node:test、Playwright Core；不增加运行时依赖、不引入 Redis/向量库。

**Spec:** `F:/projects/website-gen/docs/superpowers/specs/2026-10-16-mail-triage-design.md`；术语 `F:/projects/website-gen/CONTEXT.md`；选定视觉基准 `F:/projects/website-gen/docs/superpowers/specs/assets/mail-triage-board-selected.png`。用户已在本会话批准设计；原设计文档的历史「待审阅」文字不代表本计划未经授权。设计 SHA-256：`24E8B3F1DCF46CE0863D50982FFD33C4C19F3BF7FCA970CA88711C1C9A659F70`。

## Global Constraints

- 本次交付仅为实施计划。以下复选框均为未来执行步骤，不代表已经实现、运行或验收。
- 工作根目录固定为 `F:/projects/website-gen`。遵循现有中文 UI/注释、可擦除 TypeScript 语法和后端 `.ts` 扩展名导入。
- 保留当前未提交工作，特别是独立 `translation` 模型角色和迁移 014；禁止 reset/clean/自动 stash/提交/切换分支。每任务以可回退文件快照和验证记录代替自动 commit；用户另行明确授权后才提交。
- 不读取真实 `.env`、邮件凭据或真实邮箱进行测试；不调用真实 Hostinger、IMAP、SMTP 或模型服务。假传输、临时数据库和本机 HTTP fixture 必须与真实服务验收分开报告。
- 邮件主题、正文、显示名、附件名、引用内容和模型输出都是不可信数据，不能成为指令。任何邮件 URL 均不访问、不跟随、不渲染可点击链接、不预取、不加载远程图片；附件只允许用户显式下载。
- 模型无浏览器、HTTP、邮件发送、文件读取等工具；只能到明确配置的模型端点，禁止重定向。DNS 预检查不宣称为 DNS 重绑定保护；生产端点出站限制须另验。
- 仅支持现有 `openai` / `anthropic` provider protocol；新增用途 `mail_triage` 与 `translation/agent/vision/bulk/review` 独立，不回退、不自动复制绑定或 Key。
- 卡片代表申请事项，不代表单封邮件。三列固定「需要你处理 / 等待平台 / 结果回执」；未归组、未预审、失败、待确认始终有可见入口。
- 签名完成不等于获批，资料收到不等于审核通过，SMTP 接受不等于投递成功。邮件结论不改变站点 QA、支付开通或上线 readiness。
- 主标签 **2–6 个汉字**；展示用 `requiresReply/requiresAction/requiresReview` 从服务器校验后的义务集合派生。不展示未经校准的模型置信度百分比。
- 默认关闭；显式告知正文发往的服务商并授权邮箱。仅处理启用水位后的新信；历史补审需单独预览/确认。未来新增邮箱默认不在已授权范围。
- 每工作区并发 1，服务级总并发 4；新来信优先于历史补审，同级工作区轮询公平调度。
- 单次真实出站请求超时 60 秒、最多 3 次实际尝试；退避 30 秒/120 秒加抖动，服从更长 Retry-After；鉴权/配置错误持久暂停，坏 JSON/证据不自动修复循环。
- 每工作区每日默认最多 500 次实际尝试，重试也扣预算；历史单批最多 200 封；新信正文 30,000 个 Unicode 字符、上下文总计 30,000 字符且最多 8 个来源，同时服从模型上下文窗口并预留输出。
- 请求序列化最多 256 KiB，模型标准文本输出最多 16 KiB；超限/不完整不静默截断后判无需处理。价格未知显示「未知」，不能显示为 0 元。
- 租约 TTL 90 秒，每 15 秒续租；实际出站前事务预留 attemptSeq 并扣预算。崩溃未知结果也算已消费；原请求截止时间再加 30 秒前不得重发。
- 配置世代、来源世代、上下文版本、人工版本、fencing token 必须在同一提交事务复核；取消为终态，不能被重启/租约恢复复活。仅人工覆盖变化不得自动再调用模型来对抗人工决定。
- 缓存失配/世代变化后的敏感衍生信息最多保留 7 天且仅作失效历史；显式删除立即清除。跨邮箱不能共用可复用 assessment 或借副本规避清理。
- 开启自动通知分流必须先完成真实标注评估并人工批准对应版本；前 100 封全部入抽查队列，之后每 10 封至少 1 封。发现一次漏待办立即暂停并追查自上次通过抽查以来的通知。

## Review Focus

1. **RF1 Unicode 边界：**补充平面汉字应按 Unicode 码点计数；组合符、零宽字符、URL 和伪装 HTML 标签不混入短标签。归属任务 5，测试 `tag counts Unicode code points and rejects invisible payloads`。
2. **RF2 时间歧义：**邮件伪造未来 Date、夏令时回拨、无时区期限不能抢排序或制造截止时间；预算按 UTC 日、实际观察时间独立。归属任务 3/6，测试 `UTC budget boundary` 与 `ambiguous deadline stays unknown`。
3. **RF3 引用和多编号：**新请求夹在转发/引用旧请求中，且同平台有多申请；不能把旧要求重开或把同一义务复制到全部申请。归属任务 5/6，测试 `forwarded multi-case request remains reviewable`。
4. **RF4 UI 竞态：**A→B→A 快速换信、SSE reset/断线重连、人工修改期间旧列表返回；不能跨邮件显示摘要、恢复旧状态或重复调用模型。归属任务 13/15/16，测试 `reconnect and late response preserve identity`。
5. **RF5 授权撤销与饥饿：**工作区 A 的历史大队列、B 的新信，以及在途请求使用的第三邮箱被撤权；不能泄漏撤权上下文，不能饿死 B，不能应用旧结果。归属任务 3/8，测试 `fair workspace admission` 与 `revoke contextual mailbox during dispatch`。

---

## 0. 已核对基线、任务边界与依赖

- 只读核对 HEAD：`6a9e314759426b2fd759cb2d669d3dc094f5ec48`。当前为脏工作区，且其他工作仍可能并行修改；此 HEAD 不是可直接恢复全部工作内容的快照。
- 基线清单：`F:/projects/website-gen/docs/superpowers/plans/assets/mail-triage-plan-baseline.json`。计划文件原先不存在；本轮不改批准设计及业务源码。
- 当前 `F:/projects/website-gen/src/backend/migrations.ts` 有 14 项；**本计划新增 015**，不改写 001–014。执行前若新增迁移已占用 015，先重排为最新下一号并更新计划/测试，不覆盖他人的迁移。
- 当前 `completeText()` 包含三次内部尝试和单次五分钟超时，不能套在预审三次重试中；新单次调用路径仅复用模型解析与密钥管理。
- 当前 SSE 新信事件可能仅携带同批最大 UID，不能拿 SSE 入队；当前 `mail_messages` 主键也没有 UIDVALIDITY，必须建立独立来源身份。
- 当前 `/mail` 父路由直接渲染阅读器；已有深链、翻译竞态和发送原文行为必须保留。现有模型翻译与本模块不共用调用/触发策略。
- 计划自检期间另一个修改流在共享 protocol 中新增 `DomainMailboxes`；已只读复核，与本设计不冲突，执行时必须原样保留。源码行号会变化，以函数/类型名定位，不用旧整文件快照覆盖并行修改。
- 这是一个相互依赖的邮件子系统，使用一份计划。后台安全闭环完成后才开放新 UI；不顺带重构站点、支付、Grist、通用助手或整个邮箱 transport。

执行依赖：`1 → {2,3,4} → 5 → 6 → 7 → 8 → 9 → {10,11,12} → 13 → {14,15} → 16`。花括号内仅可在文件所有权明确、共享契约冻结后并行。涉及 `index.ts/protocol.ts/migrations.ts/models.ts` 的变更单写者串行整合。

每任务都执行：检查文件当前哈希/差异 → 把本任务要改的已有文件复制到 `.tmp` 下独立任务快照并记录哈希 → TDD → 自查差异 → 更新检查点。备份路径使用 `F:/projects/website-gen/.tmp/mail-triage-implementation/<runId>/task-N/`，不得覆盖旧快照；不备份或打印真实凭据。无现存文件时记录「absent」。回滚前先比对当前文件与本任务完成时哈希，若发生他人修改停止自动覆盖。

## 1. 文件职责与核心契约

所有下列文件路径以 `F:/projects/website-gen/` 为明确根目录；任务 Files 段给出绝对路径。保持后端现有平铺模块约定，不创建无必要的中间层。

| 新文件（绝对路径） | 唯一职责 |
|---|---|
| `F:/projects/website-gen/src/shared/mail-triage-types.ts` | UI/RPC DTO、枚举、固定中文文案、限额常量；不暴露 Key/完整原始模型响应 |
| `F:/projects/website-gen/src/backend/mail-triage-schema.ts` | 运行时输入/输出 Zod schema 与数据库约束映射 |
| `F:/projects/website-gen/src/backend/mail-triage-source.ts` | sourceHash、locator/alias、同步登记、来源有效性 |
| `F:/projects/website-gen/src/backend/mail-triage-queue.ts` | SQL 原子队列、租约、预算、attempt、重试状态 |
| `F:/projects/website-gen/src/backend/mail-triage-scheduler.ts` | 服务级公平并发许可，释放/关闭，不持有正文 |
| `F:/projects/website-gen/src/backend/mail-triage-context.ts` | 授权交集、脱敏、候选集、完整性与输入大小 |
| `F:/projects/website-gen/src/backend/mail-triage-model.ts` | 预审单次模型调用、guarded fetch、限流/超限错误分类 |
| `F:/projects/website-gen/src/backend/mail-triage-analyzer.ts` | 固定专员提示、严格提取及证据校验，无数据库写权限 |
| `F:/projects/website-gen/src/backend/mail-case-projector.ts` | 归组资格、稳定事件/义务、周期、三列、计数/提醒投影 |
| `F:/projects/website-gen/src/backend/mail-triage-worker.ts` | 队列到 analyzer/projector 的编排及受栅栏保护的提交 |
| `F:/projects/website-gen/src/backend/mail-triage-lifecycle.ts` | 撤权/删除/失效、来源支持集清理、保留期、最小审计 |
| `F:/projects/website-gen/src/backend/mail-triage-service.ts` | 设置、启用握手、查询、补审、工作区内部 facade |
| `F:/projects/website-gen/src/backend/mail-triage-actions.ts` | 人工关联/拆分/纠正/独立核验/撤销，CAS 与审计 |
| `F:/projects/website-gen/src/backend/mail-triage-send.ts` | 用户发信收据与逐项义务履行记录；不自动发送 |
| `F:/projects/website-gen/src/backend/mail-triage-evaluation.ts` | 评估资格、通知分流抽查、漏判停用/追查 |
| `F:/projects/website-gen/src/backend/workspace-rpc-policy.ts` | 独立 RPC 读写风险判定，不把业务 RPC 自动开放给助手 |

### 1.1 固定领域字典（任务 1 定义，后续只导入）

- `MailCategory = action_request | customer_inquiry | progress | milestone_receipt | application_decision | account_operations | security_verification | general_other`。
- `BoardColumn = needs_you | awaiting_platform | results`；未归组/未预审没有伪造的第四种申请状态。
- `CaseIdentityState = unconfirmed_case | confirmed`；`ApplicationStage = unknown | preparing | submitted | reviewing | ended`；`ApplicationDecision = unknown | pending | conditional | approved | declined | withdrawn`。
- `SourceState = active | stale | missing | deleted`；`SourceTrust = unconfirmed | contact_mapped | human_confirmed`（首版不产生 `authenticated`）。
- `ObligationKind = reply | action | review`；`ObligationState = open | awaiting_external | resolved_by_evidence | resolved_by_human | dismissed | blocked`。被撤销/删除来源支撑的义务清除或失效，不能当作成功完成。
- `TriageJobState = queued | running | retry_wait | succeeded | needs_review | failed | paused_budget | blocked_config | stale_source | cancelled`。`unreviewed` 是没有可用预审的来源视图状态，不是假成功作业。
- `AssessmentGrade = evidence_complete | needs_review | failed`；所有展示布尔值由投影器产生。
- 内部 source/case/event/task/job/assessment/manual/sendReceipt ID 均为服务器 UUID 字符串；已有 mailbox/site/provider ID 沿用正整数；新实体 RPC 用 Zod UUID 校验，不能采信模型自创 ID。
- `SourceLocator={mailboxId:number,folder:string,uidValidity:string,uid:number}`；`VersionTuple={providerId:number,modelId:string,modelConfigRevision:number,promptVersion:number,ruleVersion:number,schemaVersion:number}`。
- `MutationMeta={requestId:string,expectedVersion:number,reason:string}`；server actor 取会话身份，不接受客户端 actor/userId/workspaceId。
- `Fence={jobId:string,leaseToken:string,attemptSeq:number,configEpoch:number,sourceVersion:number,contextVersion:string,manualVersion:number}`。
- `EvidenceRef={sourceId:string,quote:string}`；`Provenance={supportSourceIds:string[],kind:'source_derived'|'independent_manual',verifiedAt:number|null,reason:string|null}`。没有支持来源且不是明确独立人工事实的业务衍生项不得保留。
- `CaseProjection={caseId:string,version:number,identityState:CaseIdentityState,column:BoardColumn|null,stage:ApplicationStage,decision:ApplicationDecision,decisionCycle:number,milestones:string[],tasks:TaskView[],sourceUnavailable:boolean,requiresReply:boolean,requiresAction:boolean,requiresReview:boolean}`；`TaskView` 至少含 id/kind/state/title/requestedItems/deadlineRaw/deadlineAt/provenance。
- `TriageStatus` 分别返回 `needsActionCaseCount/awaitingCaseCount/resultCaseCount/unlinkedMailCount/unreviewedMailCount/failedMailCount/openTaskCount/auditPendingMailCount`，并返回 enabled/state/configEpoch，不用一个 count 混单位。
- 分页请求 `PageRequest={page:number,pageSize:number}` 默认 1/30，pageSize 1–100；响应 `PageResult<T>={items:T[],total:number,page:number,pageSize:number}`。排序使用稳定 ID 次序作为末级排序。

### 1.2 持久化选择（任务 1 一次追加迁移）

表均在**当前会话工作区的独立 DB**，客户端不能指定 DB；外键启用。SQL 事务不能跨 `await`，网络等待不得占住写事务。

| 表 | 字段/约束重点 |
|---|---|
| `mail_triage_settings` | singleton id=1，enabled/state/config_epoch/model_config_revision/version，mode，daily_attempt_limit，consent_provider_revision，提醒设置，自动通知开关；默认关闭 |
| `mail_triage_scope` | PK mailbox_id，epoch，state，uid_validity，baseline_uid，effective_at，scope_version；删除/撤权先使版本失效 |
| `mail_triage_contacts` | 已确认 provider/site/mailbox 映射和版本、人工原因；不代表单封邮件认证 |
| `mail_triage_sources` | id，mailbox_id，source_hash，critical_headers_hash，source_version，state/trust，observed_at，missing_since；不另存整封正文 |
| `mail_triage_source_aliases` | locator 四元组唯一，source_id 外键、active 标记；跨邮箱禁止复用 source_id |
| `mail_triage_jobs` | source_id/source_version，版本 tuple，context_version，generation，config_epoch，state，priority，next_attempt_at，lease_token/expires_at，manual_version；逻辑键唯一 |
| `mail_triage_attempts` | id，job_id 可 SET NULL，attempt_seq，UTC budget_day，reserved_at，deadline_at，settled_at，outcome，usage；UNIQUE(job_id,attempt_seq)；来源清理后仅保留去身份化用量，不存正文/地址/tag |
| `mail_triage_assessments` | job_id 唯一、版本 tuple、prompt_hash、validated_json、grade、stale，来源生命周期绑定；源删除级联/清理 |
| `mail_application_cases` | 身份状态、site/provider/application identity、version/manual_version、projection_json；来源派生身份仍需 support，不因存在独立的空 case 行就永久留申请号 |
| `mail_case_sources` | PK(case_id,source_id)，关联依据、人工锁定；支持一来源多事项但每个事件/义务明确归属 |
| `mail_case_events` | case_id/source_id，稳定 event_slot，kind，decision_cycle，claimed_at/observed_at，evidence/provenance；同来源事件槽唯一 |
| `mail_case_tasks` | case_id，event_id，obligation_key，kind/object/state/deadline，version，provenance；UNIQUE(case_id,event_id,obligation_key)，不按 AI 自由标题去重 |
| `mail_case_manual_decisions` | actor、对象/字段、expected/applied version、reason、before/after、undo_of、provenance；敏感快照随来源清理，不永久保留邮件摘录 |
| `mail_triage_send_receipts` | request_id 唯一、mailbox_id、reply_source_id、smtp_status、message_id、appended、selected_task_ids、created_at；不复制正文，状态 prepared/smtp_accepted/failed/unknown |
| `mail_triage_qualifications` | version tuple 唯一、评估证据哈希、分层计数/漏判、批准 actor/time、revoked_at；新版本不继承资格 |
| `mail_triage_audits` | assessment_id 唯一、sequence、sampled、reviewed_at、verdict、last_passed_boundary；漏判可追查范围 |
| `mail_triage_requests` | request_id+operation 唯一、canonical_input_hash、最小结果引用；不同内容复用 requestId 返回冲突，删除时去身份化/清理引用 |

所有源派生事件、case identity 字段、任务、人工决定及输出都带 `supportSourceIds`；统一在 lifecycle 模块清理 JSON 里的支持关系，不能只依靠顶层 FK。新增 `mail_messages.uid_validity TEXT NULL`：保留旧 cache PK 作为「当前世代缓存槽」，身份以 aliases 四元组为准；迁移来的 NULL 缓存不得直接进入 AI。完整同步重建世代后才可用。新增 `model_providers.config_revision INTEGER NOT NULL DEFAULT 1`，每次相关配置/Key修改递增；绑定于该provider的预审 `model_config_revision` 与 epoch 同步递增。角色/思考强度变动也递增预审revision；不能仅以 modelId 不变认为模型配置未变。

必需索引：jobs(state,next_attempt_at,priority)、jobs(source_id,config_epoch)、attempts(budget_day)、sources(mailbox_id,state)、source_aliases(source_id,active)、events(case_id,observed_at)、tasks(case_id,state)、audits(sampled,reviewed_at)。所有动态 SQL 字段/排序白名单，所有值参数化。

## 2. 实施任务

### Task 1: 冻结领域契约、迁移与独立模型角色

**Files:** Create `F:/projects/website-gen/src/shared/mail-triage-types.ts`、`F:/projects/website-gen/src/backend/mail-triage-schema.ts`、`F:/projects/website-gen/src/backend/mail-triage-migration.test.ts`；Modify `F:/projects/website-gen/src/backend/migrations.ts`（追加 015）、`F:/projects/website-gen/src/backend/models.ts`（ROLES/ROLE_NAMES）、`F:/projects/website-gen/src/shared/protocol.ts`（ModelRole）、`F:/projects/website-gen/src/backend/models.test.ts`、`F:/projects/website-gen/src/backend/translation-model-migration.test.ts`。

**Interfaces:** Produces 本文 1.1 的导出类型/常量与所有表；schema 导出 `TriageConfigSchema/AssessmentOutputSchema/MutationMetaSchema/PageRequestSchema`。`ModelRole` 增加 `mail_triage`；现有 `listRoles(db)` 返回用途「邮件预审」，未绑定时显式未配置。

- [ ] **1. 写迁移与模型角色失败测试。** 从真实 v14 schema+五个角色绑定、密封 Key、旧邮件缓存升级，检查所有表/索引、默认关闭、foreign_key_check 空、五个绑定/密文逐字节不变；新预审绑定不改 translation/agent。断言核心示例：
  ```ts
  assert.equal(triageRole.providerId, 0); // 沿用现有 RoleSummary 未配置哨兵
  assert.equal(triageRole.modelId, '');
  assert.equal(triageRole.ready, false);
  assert.equal(settings.enabled, 0);
  assert.deepEqual(oldBindingsAfter, oldBindingsBefore);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(new Set(allModelRoles).size, 6);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-migration.test.ts"`；预期缺表/缺角色断言失败，而非环境导入错误。
- [ ] **3. 实现字典、schema 和追加迁移。** 按 1.1/1.2；enum 使用 literal union，Zod `.strict()`；固定数值单一来源。新增角色无默认 provider。迁移事务由现有 `migrate()` 管理，不内部嵌套 BEGIN。
- [ ] **4. 修正历史迁移测试边界。** 原 translation 测试硬编码最终版本 14，改为单独执行到 014 验证其历史行为；新增另一个从 v14 到当前 `MIGRATIONS.length` 的保留测试，不能删除原有密文与外键断言。
- [ ] **5. 跑绿灯与检查点。** 上述三个后端测试文件逐项跑 `node --test`，再 `npm run typecheck`；预期全部通过。记录迁移号、表索引、未绑定状态；不提交、不启动实际数据库迁移。

### Task 2: 邮件来源身份、同步事务与不漏单登记

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-source.ts`、`F:/projects/website-gen/src/backend/mail-triage-source.test.ts`；Modify `F:/projects/website-gen/src/backend/mailbox-service.ts`（syncFolder/upsert/reset/trash seams）、`F:/projects/website-gen/src/backend/mailbox-parser.ts`（完整性元数据）；Test `F:/projects/website-gen/src/backend/mailbox-service.test.ts`（若基线采用分拆测试则保持原文件并新增独立 fixture 测试，不移动它）。

**Interfaces:** `fingerprintSource(key:Buffer, mail:ParsedSafeMessage):{sourceHash:string,criticalHeadersHash:string}`；`registerCachedSource(db:DatabaseSync,input:{locator:SourceLocator,mail:ParsedSafeMessage,observedAt:number},key:Buffer):{sourceId:string,sourceVersion:number,isNew:boolean}`；`reconcileFolderSnapshot(db, input:{mailboxId:number,folder:string,uidValidity:string,presentUids:number[],complete:boolean},now:number):void`。`MailboxService` 新增内部 `withInboxSnapshot<T>(mailboxId:number,commit:(snapshot:{uidValidity:string,maxUid:number,complete:true})=>T):Promise<T>`：复用同一串行槽执行完整同步，再运行同步 commit 回调；不允许回调 await 或再次进入 exclusive。

- [ ] **1. 写 B28/B29/B30/B33/B55/B57/B61 的失败测试。** 同 Message-ID 不同 body 两条来源且冲突；三封缓存只收到一个 SSE 仍有三条待处理登记；重复同步不重复；旧 UIDVALIDITY 的 UID=42 与新信不同；脱敏相同但 OTP 不同必须 sourceHash 不同。测试 cache+source/job 两处之一抛错时全部回滚。
  ```ts
  assert.notEqual(hashOfCode123.sourceHash, hashOfCode456.sourceHash);
  assert.equal(new Set(sourceIdsForThreeMessages).size, 3);
  assert.equal(jobCountAfterDuplicateSync, 3);
  assert.equal(oldAlias.active, false);
  assert.equal(staleWorkerMayApply, false);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-source.test.ts"`；预期身份/事务登记缺失。
- [ ] **3. 实现 sourceHash 与完整性。** HMAC-SHA256 使用工作区派生密钥及固定域分隔；canonical 原文包含主题、结构化地址、正文、日期、Message-ID/References/In-Reply-To、附件元数据，使用稳定字段顺序；仅规范化行尾，不脱敏后算 sourceHash。`promptHash` 留给任务 4。解析失败、缺正文、只有附件/链接、超长被拒均标记内容不足。
- [ ] **4. 接入同步短事务。** 每条 MIME 解析完成、UIDVALIDITY 已明确后，在短事务中写 cache→source/alias→持久登记；不要把流式 IMAP/parse await 放进 SQL 事务。旧缓存失效先撤销旧 jobs/fence 并递增 sourceVersion，再建新 alias；未拿到完整 snapshot 不执行「缺失邮件」清理。旧 NULL 世代缓存需完整同步重建，不能猜 UID。同步metadata-only更新不重复登记。增加启动/周期的有界恢复扫描：当前有效locator、有正文且在已授权水位后但无该版本登记的缓存逐条补登记，仍受同一唯一键/授权规则，不把全部旧缓存回扫成历史补审。
- [ ] **5. 接入初始可见义务。** 对已可靠关联且启用预审的来源立即登记 `review_new_mail` 临时义务，即使预算暂停/调用未开始也返回 needs_you；未关联来源放未预审/待确认队列。已有映射规则由任务 6 提供可替换 pure callback，禁止同步层调用模型。
- [ ] **6. 跑绿灯与检查点。** source 测试及现有 mailbox/parser 测试全通过；断言 `modelCalls===0`、不改变 seen、不触发 SMTP。记录删除/重置中断点用于任务 8 的正式清理实现。

### Task 3: 持久队列、真实尝试预算与公平许可

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-queue.ts`、`F:/projects/website-gen/src/backend/mail-triage-scheduler.ts`、`F:/projects/website-gen/src/backend/mail-triage-queue.test.ts`。

**Interfaces:** `createTriageQueue(db:DatabaseSync,clock:()=>number):TriageQueue`，其方法：`enqueue(input:JobRegistration):string`、`peekPriority():'new'|'history'|null`、`claim():JobLease|null`、`reserveAttempt(lease:JobLease):AttemptPermit`、`renew(fence:Fence):boolean`、`retry(fence:Fence,error:TriageFailure):void`、`cancel(sourceIds:string[],reason:string):void`、`recover():number`。`JobRegistration` 固定包含 sourceId/sourceVersion/tuple/contextVersion/generation/configEpoch/priority；`JobLease` 含 jobId/leaseToken/sourceId/epoch/version；`AttemptPermit` 含 fence/deadlineAt。`TriageFailure` 含 code、retryable、retryAfterMs（无原始 response）。`createTriageScheduler(limit=4):TriageScheduler`，`acquire(workspaceKey:string,priority:'new'|'history',signal:AbortSignal):Promise<()=>void>`。

- [ ] **1. 写 B29/B32/B40/B53/B58/B60 和 RF2/RF5 的失败测试。** 假时钟+真实临时 SQLite：重复登记唯一；restart 恢复不依赖 SSE；最多三次真实许可；500 次后暂停；UTC 23:59:59→00:00:00 新预算日；取消不能 recover；抢租约旧 fence 失效；A 历史/B 新信并发总数≤4、单工作区≤1，许可释放和中断不泄漏。
  ```ts
  assert.equal(reservedAttempts, 3);
  assert.equal(dispatchesBeforeDeadlinePlus30s, 1);
  assert.equal(stateAfter500Attempts, 'paused_budget');
  assert.equal(cancelledRecoveredCount, 0);
  assert.ok(maxGlobalActive <= 4 && maxWorkspaceActive <= 1);
  assert.equal(nextAdmittedWorkspace, 'B');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-queue.test.ts"`；预期 queue/scheduler 行为缺失。
- [ ] **3. 实现 SQL 预约与恢复。** `BEGIN IMMEDIATE` 内检查当前授权/取消/租约，按 UTC 日统计 attempts，再插入 attemptSeq 和 deadline；只在成功提交后返回许可。启动恢复把已出站未知尝试计为已消费，至少等到 deadline+30s；终态不重排。
- [ ] **4. 实现退避和调度。** 注入 `clock/jitter`；jitter 采用 [0,1000]ms，Retry-After 取更大；网络/429/5xx 才重试，401/403/缺用途/unsupported_protocol 进入 blocked_config。60s timeout 后按同一最多3次策略；非法 JSON/证据只一次后 failed/needs_review。退避释放租约与服务许可。
- [ ] **5. 跑绿灯与检查点。** queue 测试全通过；重启、双 worker、崩溃时间点均为可重现假时钟，不用 sleep 等90秒。记录已证明的是本地尝试计账/幂等，不承诺服务商恰好一次或不重复收费。

### Task 4: 最小授权上下文与单次可取消模型调用

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-context.ts`、`F:/projects/website-gen/src/backend/mail-triage-model.ts`、`F:/projects/website-gen/src/backend/mail-triage-model.test.ts`、`F:/projects/website-gen/src/backend/mail-triage-context.test.ts`；Modify `F:/projects/website-gen/src/backend/models.ts`（导出窄单次调用接缝，不改 completeText）。

**Interfaces:** `buildTriageContext(db:DatabaseSync,key:Buffer,sourceId:string,epoch:number):TriageInput`；`TriageInput` 包含 source、authorizedSources、eligibleCaseIds/eligibleTaskIds、contextIncomplete、sourceVersion/contextVersion/manualVersion、tuple。模型输入不含 sourceHash/key。本模块导出 `TriageModelRequest={input:TriageInput,context:Context,promptHash:string,maxOutputTokens:number}` 与 `fingerprintPrompt(context:Context,tuple:VersionTuple):string`，由任务5准备固定提示后的请求。`completeTriageOnce(request:TriageModelRequest,signal:AbortSignal,deps:{db:DatabaseSync,key:Buffer,fetch?:typeof fetch}):Promise<{text:string,usage:ModelUsage}>`；`ModelUsage={inputTokens:number|null,outputTokens:number|null,estimatedCost:number|null}`。底层 `streamRoleOnce(db:DatabaseSync,key:Buffer,role:'mail_triage',context:Context,options:{signal:AbortSignal,fetch:typeof fetch,maxTokens:number,maxRetries:0,timeoutMs:number}):AssistantMessageEventStream` 在 models 模块复用当前 runtime/resolve；`Context/AssistantMessageEventStream` 从已安装 pi-ai types 导入，不另造接口；真实deadline由worker传入signal限制，timeoutMs不超过60,000且不能放宽signal截止时间。

- [ ] **1. 写 B14/B35/B38/B40/B55/B58/B59 的失败测试。** 只授权 A、同申请 B 未授权，捕获模型 payload，断言 B 的正文、摘要、地址及派生任务标题全部不存在。不同 OTP 脱敏后 promptHash 可同而 sourceHash 必不同。两个现有 adapter 各用本机 fake SSE 验证 single dispatch、500不内部重试、redirect:error、abort 到底层、输出超限真实 abort。
  ```ts
  assert.equal(payload.includes('PRIVATE_B_SENTINEL'), false);
  assert.equal(input.contextIncomplete, true);
  assert.equal(fetchCallsPerAttempt, 1);
  assert.equal(requestInit.redirect, 'error');
  assert.equal(observedAbortSignal.aborted, true);
  assert.equal(error.code, 'response_too_large');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-context.test.ts" "F:/projects/website-gen/src/backend/mail-triage-model.test.ts"`；预期安全接缝尚未实现。
- [ ] **3. 实现授权交集与脱敏。** 只读相关∩当前 epoch 已授权邮箱∩active来源；最多8来源/30k上下文，当前信30k；过滤人工备注（未单独同意不得外发），保留不完整标志而非偷偷携带未授权事实摘要。验证码、密码、token、URL 查询秘密先占位化；选中字段明确，不传任意 DB对象。`fingerprintPrompt` 对任务5生成的实际 canonical Context+版本计算promptHash，不用原始source对象代替外发载荷。
- [ ] **4. 实现单次 adapter。** 使用已安装 pi-ai `runtime.models.streamSimple`，options 显式 maxRetries:0、timeoutMs:60000、同一 AbortSignal 和 guarded fetch；拒绝同一调用第二次 HTTP dispatch。guarded fetch 强制 redirect:error，端点只来自配置；序列化请求按UTF-8 ≤256KiB；标准 text_delta 累计 ≤16KiB。另设 **wire总字节1MiB** 防 SSE/error帧/思考流无限膨胀，超限 abort；这是防护上限，不把16KiB业务输出与SSE帧等同。
- [ ] **5. 实现窗口与错误策略。** 输出 maxTokens 取4096与模型上限较小值；输入用已可用 tokenizer 或保守 UTF-8 byte/token 上界预算，含提示和输出预留，无法证明窗口足够则 input_too_large 需核对，不截断。未支持 protocol/缺Key/缺用途 blocked_config；禁止 fallback；错误不回显原始服务商体或秘密。仅新信调用路径使用此边界。
- [ ] **6. 跑绿灯与检查点。** model/context及旧 models/translation 测试全通过；两个 adapter 各记录 fake HTTP 次数、取消和限额证据；不声称所有兼容厂商已实测。

### Task 5: 预审提示、分类、短标签与证据验证

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-analyzer.ts`、`F:/projects/website-gen/src/backend/mail-triage-analyzer.test.ts`；Modify `F:/projects/website-gen/src/backend/mail-triage-schema.ts`。

**Interfaces:** `prepareTriageRequest(input:TriageInput):TriageModelRequest` 构建固定Context、调用任务4的fingerprintPrompt并预检大小/窗口；`analyzeTriage(request:TriageModelRequest,callOnce:TriageModelCaller,signal:AbortSignal):Promise<ValidatedAssessment>`；`validateAssessment(raw:unknown,input:TriageInput):ValidatedAssessment`。`TriageModelCaller` 在任务4的model模块导出，签名 `(request:TriageModelRequest,signal:AbortSignal)=>Promise<{text:string,usage:ModelUsage}>`，任务7只导入不另定义。`ValidatedAssessment` 固定含 primaryCategory/tag/summary/events/actions/completionSuggestions/uncertainties/grade/usage，以及引用和应用限制，不包含可自行授权的 requires* 布尔值。`buildTriageMessages(input:TriageInput):Context` 输出固定systemPrompt + 被明确标成不可信数据的user消息，不提供tools；schemaVersion/promptVersion/ruleVersion 首版1。

- [ ] **1. 写分类反例失败测试。** B01–B14、B21、B34、B38/B39；RF1/RF3：补充平面汉字计数、零宽字符/HTML/URL拒绝；引用旧的签名请求但新正文已完成；不带问号的客服明确请求；no-reply发件也可要求操作；假 source/task/case ID、伪造引文拒绝；一信多动作保留，逾期时间未知不得猜。
  ```ts
  assert.equal(signatureOnly.events.some(e => e.kind === 'application_approved'), false);
  assert.deepEqual(replyAndUpload.actions.map(a => a.kind), ['reply', 'action']);
  assert.equal(invalidTag.tag, '资料请求'); // action_request 安全默认标签
  assert.equal(invalidTag.grade, 'needs_review');
  assert.equal(unknownDeadline.actions[0].deadlineAt, null);
  assert.equal(extraModelRepairCalls, 0);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-analyzer.test.ts"`；预期缺 schema/分类规则。
- [ ] **3. 定义严格结果结构。** 采用批准设计7.4结构，summary≤240 Unicode字符、events≤16、actions≤16、每项evidence 1–4条、quote每条≤500字符、uncertainties≤12，禁止额外字段。模型不知道/不能判断必须表达 uncertainty。允许事件 kind 固定枚举覆盖提交/审核/资料收到/协议发送/签名完成/条件批准/批准/拒绝/撤回/复审受理/开通/受限/暂停/停用/关闭/普通通知；动作只reply/action/review。
- [ ] **4. 实现验证及来源分段。** 使用原文证据位置区分新正文/引用历史；只能引用输入来源和服务器候选集合；完成建议必须明确对应义务。结构/引用不存在为failed，不应用；标签非法使用分类安全标签并needs_review；语义冲突、信息不足、来源未确认的关键决定只建议。全文直接引用存在只是必要条件，不当真伪/推理正确性认证。
- [ ] **5. 固定安全标签词库与提示。** 八类默认分别「资料请求/客服问询/进度通知/完成回执/申请结果/账户事件/安全验证/普通通知」；采用 `Array.from(tag)` 与 Unicode Han 范围验证2–6字，拒绝不可见字符与敏感字串。提示角色是网关申请专员，只判断邮件声称的事实、请求、局部回执和风险；不访问链接、不发信、不补编事实。
- [ ] **6. 跑绿灯与检查点。** analyzer/context测试全通过；为每个反例保存脱敏 fixture ID 和预期，不存真实邮件。保留模型提取质量与确定性验证的区别。

### Task 6: 申请关联、稳定义务、周期与三列投影

**Files:** Create `F:/projects/website-gen/src/backend/mail-case-projector.ts`、`F:/projects/website-gen/src/backend/mail-case-projector.test.ts`。

**Interfaces:** `resolveCaseLinks(input:{assessment:ValidatedAssessment,candidates:CaseCandidate[],source:SourceFacts,confirmedMappings:ContactMapping[]}):LinkResolution`（matched/candidate/ambiguous）；`projectCase(input:CaseProjectionInput):CaseProjection` 为纯函数；`applyAssessment(db:DatabaseSync,input:{sourceId:string,assessment:ValidatedAssessment,fence:Fence,now:number}):{affectedCaseIds:string[]}` 只允许调用者事务内使用。`CaseProjectionInput` 含当前case身份、各周期事件、有效任务、manual decisions、支持来源状态、当前now；`SourceFacts/CaseCandidate/ContactMapping/LinkResolution` 在此模块导出明确字段，不传任意DB行。

- [ ] **1. 写 B01–B10/B12/B13/B15–B21/B26/B27/B45/B47–B51/B56/B62 与 RF2/RF3 失败测试。** 精确编号+确认映射+唯一才自动关联；新编号只候选；明确风险即使无请求也核对；批准+激活/拒绝+答复留需要你处理；signature只关签名；补件只关对应项；旧邮件迟到不覆盖新事件；矛盾进核对；申诉新周期显示待确认受理，旧拒绝为历史。
  ```ts
  assert.equal(signedWithOpenDocs.column, 'needs_you');
  assert.equal(signedWithOpenDocs.decision, 'pending');
  assert.equal(approvedWithActivation.column, 'needs_you');
  assert.equal(confirmedFinalNoTasks.column, 'results');
  assert.equal(resultCaseAfterNewMail.column, 'needs_you');
  assert.equal(newUnconfirmedCase.column, null);
  assert.equal(contactMappedReceipt.tasks[0].state, 'open');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-case-projector.test.ts"`；预期 projector/业务规则缺失。
- [ ] **3. 实现关联与事件稳定键。** 仅确认映射和eligible候选计算资格，忽略模型needsReview=false授权效果。按sourceVersion+证据区间+固定kind建立event_slot；同义改写通过原来源稳定槽匹配，不按title重复造任务；无法唯一匹配重审差异则needs_review。多申请事件逐项绑定，不广播待办。
- [ ] **4. 实现义务与周期。** 自动明确正向义务可添加；无动作不清旧义务。解除必须同case/同obligation、active且该封source经人工确认、明确回执、不冲突、不覆盖人工锁；no_action只能由任务12资格门解除自身临时核对。日期正文保留raw，缺时区或DST歧义deadlineAt=null，不从邮件Date推造；future Date只展示不抢排序。
- [ ] **5. 实现投影和提醒。** 有open/blocked reply/action/review→needs_you；否则有明确外部等待→awaiting_platform；否则有明确最终决定→results；证据不足建立review避免无列消失。账户状态不覆盖申请历史；结果标「邮件显示」或「人工核验」，不写支付/站点readiness。稳定优先序为账户/安全风险→已证实逾期/临期→动作→核对，再有效事件观察时间与ID；提醒按稳定事件键去重。
- [ ] **6. 跑绿灯与检查点。** 投影器全部反例通过，分别断言cases/emails/tasks计数单位；reducer对相同输入可重复得到同输出，重放不重复任务/提醒。

### Task 7: Worker 编排、提交栅栏与中断恢复

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-worker.ts`、`F:/projects/website-gen/src/backend/mail-triage-worker.test.ts`。

**Interfaces:** `createTriageWorker(deps:{db:DatabaseSync,key:Buffer,workspaceKey:string,queue:TriageQueue,scheduler:TriageScheduler,callOnce:TriageModelCaller,clock:()=>number,push:()=>void}):TriageWorker`；导入任务4的TriageModelCaller和任务5的prepareTriageRequest/analyzeTriage；worker方法 `start():void`、`wake():void`、`abortSources(ids:string[]):void`、`stopAccepting():void`、`close():Promise<void>`。`commitAssessment(db:DatabaseSync,fence:Fence,assessment:ValidatedAssessment):'applied'|'stale'|'cancelled'|'manual_reproject'`。

- [ ] **1. 写 B31–B36/B41/B47/B53/B58/B60 失败测试。** 包含claim前、reserve后未dispatch、dispatch中崩溃、响应后提交前、配置/源/人工版本变化、旧fence、停用、删除、持续上下文变化。假model内部抓到的真实调用总数最多3；manual变化不触发无限再分析。
  ```ts
  assert.equal(actualModelDispatchesAfterThreeRetries, 3);
  assert.equal(commitWithOldFence, 'stale');
  assert.equal(cancelledAssessmentRows, 0);
  assert.equal(modelCallsAfterManualOverride, modelCallsBeforeManualOverride);
  assert.equal(temporaryReviewTaskStillVisible, true);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-worker.test.ts"`；预期worker缺失。
- [ ] **3. 实现调用顺序。** peekPriority→获得公平许可→claim（此时才启动租约）→buildTriageContext→prepareTriageRequest（大小/窗口预检，尚未扣出站预算）→最后重验授权→reserve预算→按持久deadlineAt减当前时间开启AbortController与15s续租→analyzeTriage调用single caller并严格验证→短事务提交。许可到手时若无可用job立即释放，避免排队等许可期间租约早已过期。若时间已到则不出站；不能reserve后再重新计完整60秒。所有路径 finally 清timer/lease/许可，失去租约立即abort；不以 Promise.race 伪装底层停止。
- [ ] **4. 实现提交/重算。** 同事务比对sourceHash/sourceVersion、locator世代、epoch、上下文支持集合版本、manualVersion和fence，再写assessment/events/tasks/projection。取消后只记去敏用量；context改变只为新context登记一个后继，同链最多2次后继（额外实施上限）后转需人确认；人工版本改变仅按人工规则重投影。
- [ ] **5. 跑绿灯与检查点。** worker/queue/projector测试全通过；确认SSE只在提交后推送，不作为持久任务源；close等待自身请求终止且无DBclose后写入。

### Task 8: 授权撤销、来源失效与删除溯源闭环

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-lifecycle.ts`、`F:/projects/website-gen/src/backend/mail-triage-lifecycle.test.ts`；Modify `F:/projects/website-gen/src/backend/mailbox-service.ts`（删除/失效回调）、`F:/projects/website-gen/src/backend/abandon.ts`（与本地清理事务协作）。

**Interfaces:** `invalidateTriageScope(db,input:{mailboxIds:number[],reason:'disable'|'scope_removed'|'mailbox_delete'|'abandon'},now:number):{abortSourceIds:string[]}`；`invalidateSource(db,sourceId:string,reason:'stale'|'missing'|'explicit_delete',now:number):void`；`purgeExpiredSources(db,now:number):number`；`rebuildSupportedCase(db,caseId:string):void`。事务先撤epoch/lease，abort是事务后最佳努力；调用方保留原业务删除确认和远端结果验证。

- [ ] **1. 写 B30/B31/B36/B37/B53/B54/B59/B62 与 RF5 失败测试。** 已授权A的payload引用B，B撤权后A在途结果也不能提交；source唯一支持被删，普通人工改标签/关联不算独立事实；跨邮箱副本不可共享assessment；stale立即needs_you，7天后清摘要/摘录/派生申请号；明确independent_manual才保留；取消job重启不复活。
  ```ts
  assert.equal(staleOnlyCase.requiresReview, true);
  assert.equal(deletedSourceQuotes.length, 0);
  assert.equal(ordinaryManualRelabelSurvives, false);
  assert.equal(independentVerifiedFactSurvives, true);
  assert.equal(commitUsingRevokedContext, 'cancelled');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-lifecycle.test.ts"`；预期支持链清理和撤权缺失。
- [ ] **3. 实现来源支持集合清理。** 在单事务内撤jobs、删assessment/quotes/summaries、裁剪所有支持集合（含case身份和manual before/after），空支持衍生项清除，再重投影仍有证据的事项；minimal audit不留申请号/地址/tag。人工独立事实必须独立说明、reason和核验时间，不是简单勾选「我看过」。
- [ ] **4. 接入暂失/删除顺序。** 完整snapshot丢失先stale/missing并建来源核对；同账户/地址、全指纹/关键头一致且唯一才alias恢复。显式移垃圾箱先阻止新调用/旧写回，远端确定成功后执行删除清理；远端未知不猜成功、不恢复自动化。邮箱delete/abandon先撤权再等待清理，沿用tombstone和远端复核，不能使放弃站点复活。
- [ ] **5. 跑绿灯与检查点。** lifecycle/source/abandon/mailbox回归通过；对已删除source的所有表JSON文本做sentinel扫描，确保没有引用残留；在途取消后只有去敏attempt账允许更新。

### Task 9: 设置、启用水位、补审与工作区 RPC 集成

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-service.ts`、`F:/projects/website-gen/src/backend/workspace-rpc-policy.ts`、`F:/projects/website-gen/src/backend/mail-triage-workspace.test.ts`；Modify `F:/projects/website-gen/src/backend/index.ts`、`F:/projects/website-gen/src/backend/workspaces.ts`、`F:/projects/website-gen/src/backend/models.ts`、`F:/projects/website-gen/src/backend/assistant-tools.ts`、`F:/projects/website-gen/src/shared/protocol.ts`；Test `F:/projects/website-gen/src/backend/workspaces.test.ts`、`F:/projects/website-gen/src/server/http.test.ts`（会话/actor伪造回归）。

**Interfaces:** `createMailTriageService(deps:{db:DatabaseSync,key:Buffer,mailboxes:MailboxService,worker:TriageWorker,clock:()=>number,push:()=>void,readOnly:boolean,actor:ServerActor|null}):MailTriageService`；方法由以下 RPC 一对一映射，类型在 shared DTO 中导出，不把客户端 userId/workspaceId 传入 service。`workspaceRpcRisk(method:string):'read'|'write'|'confirm'|undefined` 对新 RPC 显式表，其他沿用现有 assistantRpcToolByMethod；未知 fail-closed。`createWorkspace` 内部增加 `ownerUserId?:number`，只由 `WorkspaceManager.open()` 根据通过验证的管理库用户ID填入；人工写操作无actor时拒绝，测试明确提供fixture用户ID，不能从userDir字符串反推操作者。

| RPC | 输入/输出摘要与风险 |
|---|---|
| `mail.triage.settings` | `{}`→TriageSettings；read；不返回Key |
| `mail.triage.status` | `{}`→TriageStatus；read |
| `mail.triage.result` | `{sourceId}`→授权的评估/证据/来源状态；read |
| `mail.cases.list/detail` | `{...PageRequest,column?,mailboxId?,query?}` / `{caseId}`→分页投影/CaseDetail；read |
| `mail.triage.reviewQueue` | `{...PageRequest,filter:'unreviewed'|'unlinked'|'failed'|'review'|'audit'|'notifications'}`→PageResult<ReviewRow>；read |
| `mail.triage.configure` | `{...MutationMeta,enabled,mailboxIds,mode,modelBinding:{providerId,modelId,thinking},dailyAttemptLimit,consentProviderRevision}`→TriageSettings；confirm |
| `mail.triage.backfillPreview` | `{mailboxIds,days:7|30}`→previewId/count/limit/expiresAt；read（仅本地缓存，不自动抓远端） |
| `mail.triage.enqueue` | `{requestId,previewId}` 或 `{requestId,sourceIds}`→批次IDs；confirm，最多200 |
| `mail.triage.retry/cancel` | `{requestId,jobId,expectedVersion}`→JobView；confirm |
| `mail.triage.contacts.list/save/remove` | `{...PageRequest}` / `{...MutationMeta,mapping:{id?,providerKey,siteId,mailboxIds,senderAddresses,domains}}` / `{...MutationMeta,id}`→分页ContactMapping/最新version；read/confirm/confirm；保存只确认辅助映射，不认证单封邮件 |

- [ ] **1. 写 B31/B35–B37/B40/B42/B47/B57/B59/B61 失败测试。** workspace A/B不同临时DB，恶意id/actor越界被拒；readOnly/backgroundTasks=false只允许登记的read；角色不就绪不能启用；多邮箱初始化期间第一箱已完成水位、第二箱尚未完成仍不漏第一箱新信；中途崩溃可恢复；provider原ID原modelId但baseUrl/Key改变也失效旧任务；重复preview提交幂等、换内容冲突；未授权新邮箱不自动进入；打开/搜索/翻译不入队。
  ```ts
  assert.equal(firstBaselineMailWasEnqueued, false);
  assert.equal(mailArrivingAfterSnapshotWasEnqueued, true);
  assert.equal(queueRowsAfterSameRequestId, initialQueueRows);
  assert.equal(crossWorkspaceReadAllowed, false);
  assert.equal(readOnlyModelCalls, 0);
  assert.equal(newMailboxIsAuthorized, false);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-workspace.test.ts"`；预期RPC缺失/握手不成立。
- [ ] **3. 实现启用握手与模型变更。** configure先CAS保存initializing及同意的服务商revision；逐邮箱使用任务2串行完整INBOX snapshot。在同步槽内短事务写有效UIDVALIDITY、完整snapshot maxUID（空箱0）、epoch/effectiveAt及该scope的enabled，随后安排立即第二次同步。全局在所有选中scope完成后才enabled；先完成scope的新信在initializing期间照常持久登记但worker不出站。失败/崩溃保留已经提交水位和待登记来源，恢复只重做未完成scope，不重新抬高已完成水位跳过邮件；用户取消则整体撤epoch。不能用缓存maxUID/邮件Date/过期清单当边界；开启水位不是历史重审。
- [ ] **4. 实现模型绑定与补审。** triage configure在同一业务操作更新mail_triage角色、modelConfigRevision及epoch，provider改变必须新同意且不自动回扫旧信；仍授权的新来信按新epoch仅入队一次。通用模型设置对mail_triage改绑转到专用设置确认流程，不允许助手用models.setRole隐式改收件数据目的地。`updateProviderConfig/setProviderKey/deleteProviderConfig` 若影响绑定中的provider，必须在同一SQL事务中增加revision/epoch、撤旧job并暂停对应预审；提交后abort，修复/重新同意后才能恢复。特别是原providerId改baseUrl不能绕过外发目的地确认；不改变其它角色原有调用策略。preview有10分钟有效期及epoch/来源范围哈希，enqueue重新授权校验；范围变化返回冲突要求重新预览；每日预算最低1、默认500、UI最大5000。
- [ ] **5. 集成生命周期/RPC风险。** createWorkspace只在backgroundEnabled启动worker；dependencies增加triageCaller/clock测试缝并使用单服务实例的scheduler。关闭顺序stopAccepting→停止mail生产者→abort/drain triage→等待其它background→db.close。abandon.start落tombstone后立即invalidate，在原stopDomain drain逻辑中保持阻断。新RPC全列入assistant exclusions（读写风险另表），不自动成为通用助手能力。联系人CRUD复用工作区site/mailbox归属校验和CAS；每分钟本地提醒扫描仅重投影临期/逾期及等待过久，稳定提醒键去重，不调用模型/发信。等待跟进默认7天可配置，文案是人工建议而非平台期限；延期仅snoozedUntil，不改变open状态或列。
- [ ] **6. 跑绿灯与检查点。** workspace+assistant工具覆盖+旧翻译workspace测试通过。`Push.changed.topic` 加 `mail_triage`；仅推IDs/versions/counts，不推正文；无权限通过SSE/错误绕过的情况。

### Task 10: 人工纠正、关联/拆分、独立核验与撤销

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-actions.ts`、`F:/projects/website-gen/src/backend/mail-triage-actions.test.ts`；Modify `F:/projects/website-gen/src/backend/mail-triage-service.ts`、`F:/projects/website-gen/src/backend/index.ts`、`F:/projects/website-gen/src/backend/workspace-rpc-policy.ts`、`F:/projects/website-gen/src/backend/assistant-tools.ts`。

**Interfaces:** `applyManualDecision(db:DatabaseSync,input:ManualMutation,actor:ServerActor):{decisionId:string,version:number}`；`undoManualDecision(db:DatabaseSync,input:{decisionId:string}&MutationMeta,actor:ServerActor):{version:number}`。`ManualMutation` 为discriminated union：correct(有类型的target与field/value：tag/category/sourceTrust/task title或requestedItems/task state/decision explanation/deadlineRaw与deadlineAt/snoozedUntil)、link(sourceIds,caseId)、split(caseId,eventIds,newIdentity)、confirm_case(identity)、independent_fact(fact,verifiedAt)、appeal_requested(caseId)。纠正不能采用任意字段名；每种target有固定schema和允许字段。所有分支必须MutationMeta；`ServerActor={id:string}` 由任务9的服务端身份提供。

- [ ] **1. 写 B15/B16/B26/B27/B37/B41/B49/B51/B54 失败测试。** 两页同时改expectedVersion只一方成功；人工锁不会被AI覆盖；跨邮箱关联重新授权但不跨workspace；undo追加补偿事件不删审计；普通改tag不是独立事实；已签名来源确认只解除签名；新申请号不能复审复活旧case；人工改期限须保留说明和核验来源，延期后仍open/needs_you且不假称外部等待。
  ```ts
  assert.equal(secondMutation.errorCode, 'version_conflict');
  assert.equal(manualTagAfterReanalysis, manualTagBeforeReanalysis);
  assert.equal(undoAudit.undoOf, originalDecisionId);
  assert.equal(appealProjection.decisionCycle, previousCycle + 1);
  assert.equal(independentFactRequiresVerifiedAt, true);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-actions.test.ts"`；预期人工事务缺失。
- [ ] **3. 实现CAS/审计与RPC。** `mail.triage.correct`、`mail.cases.link/split/confirm`、`mail.cases.independentFact/appeal`、`mail.triage.undo` 均confirm风险并assistant excluded；事务检查所有引用归属、active/tombstone和version，写field级锁+审计再重投影。undo要求当前版本仍可补偿，冲突要求人选择，不强覆盖。
- [ ] **4. 实现差异展示数据。** 返回改前/改后投影、受影响义务ID与仍需核对的来源，不能返回原始Key/完整模型结果；显示「人工确认邮件来源」与「人工核验平台」不同证据等级。
- [ ] **5. 跑绿灯与检查点。** actions/projector/lifecycle测试通过，确认每个写RPC都有schema/risk/assistant排除/幂等/CAS测试。

### Task 11: 显式发信收据与逐项义务履行

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-send.ts`、`F:/projects/website-gen/src/backend/mail-triage-send.test.ts`；Modify `F:/projects/website-gen/src/backend/mailbox-service.ts`（send前后）、`F:/projects/website-gen/src/shared/mail-types.ts`、`F:/projects/website-gen/src/backend/index.ts`、`F:/projects/website-gen/src/backend/workspace-rpc-policy.ts`、`F:/projects/website-gen/src/backend/assistant-tools.ts`。

**Interfaces:** `recordTaskOutcome(db,input:{caseId:string,taskIds:string[],outcome:'reply_sent'|'action_completed'|'dismissed'|'blocked',sendReceiptId?:string,evidenceNote?:string}&MutationMeta,actor:ServerActor):CaseProjection`。`MailSendInput` 可选新增 `requestId`；成功返回保留 `{messageId,appended}` 并附 `sendReceiptId`。客户端不能直接写SMTP成功/服务商确认。

- [ ] **1. 写 B06/B07/B22–B25/B43/B54 失败测试。** 草稿/点击按钮无state变化；只有可信本地smtp_accepted receipt+用户明确勾选reply义务才awaiting_external；上传义务不被一起关；SMTP失败/未知保留待办；Sent append失败仍提示已发出不可重发；bounce唯一匹配才blocked；跨邮箱卡片回复仍原收件身份。
  ```ts
  assert.equal(taskAfterDraft.state, 'open');
  assert.equal(replyTaskAfterConfirmedReceipt.state, 'awaiting_external');
  assert.equal(uploadTaskAfterReply.state, 'open');
  assert.equal(appendFailure.smtpStatus, 'smtp_accepted');
  assert.equal(smtpDispatchCountAfterRepeatedRequestId, 1);
  assert.equal(senderMailboxId, originalReceivingMailboxId);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-send.test.ts"`；预期无持久权威send receipt。
- [ ] **3. 实现发信收据。** 显式用户发送前短事务准备requestId收据，发送后持久化服务端结果；崩溃/不能确认SMTP是否接受记unknown，不自动重发；仅有网络未出站的明确失败才允许用户新操作。保留已有SMTP/append语义和原文引用，不用翻译/AI摘要替换正文。SMTP accepted但append失败时可记录被选reply义务等待，同时保留独立「发件副本待核对」review义务，使卡片仍需核对，不能显示完整成功。
- [ ] **4. 实现recordOutcome。** `mail.tasks.recordOutcome` confirm+assistant excluded；逐项校验receipt归属/收件源/所履行对象、task版本、操作者，动作完成只声明自己做了什么，不等于平台已接受；材料部分完成保留其它requestedItems/独立义务。人工确认完成没有独立事实说明时仍source_derived，不绕过删除。
- [ ] **5. 跑绿灯与检查点。** send/旧SMTP/mail交互测试通过；截图文案区分「已提交发送」「发送状态未知」「发送成功，但未保存到已发送」；本任务不发送真实邮件。

### Task 12: 模型评估门、通知抽查与漏判补救

**Files:** Create `F:/projects/website-gen/src/backend/mail-triage-evaluation.ts`、`F:/projects/website-gen/src/backend/mail-triage-evaluation.test.ts`、`F:/projects/website-gen/scripts/evaluate-mail-triage.ts`；Modify `F:/projects/website-gen/src/backend/mail-triage-service.ts`、`F:/projects/website-gen/src/backend/mail-case-projector.ts`（窄资格gate）、`F:/projects/website-gen/src/backend/index.ts`、`F:/projects/website-gen/src/backend/workspace-rpc-policy.ts`、`F:/projects/website-gen/src/backend/assistant-tools.ts`。

**Interfaces:** `evaluateNotificationGate(input:{tuple:VersionTuple,report:EvaluationReport}):{eligible:boolean,reasons:string[]}`；`canAutoRouteNotification(input:{assessment:ValidatedAssessment,qualification:Qualification|null,enabled:boolean}):boolean`；`recordNotificationAudit(db,input:{assessmentId:string,verdict:'correct'|'missed_action'}&MutationMeta,actor:ServerActor):{paused:boolean,recheckSourceIds:string[]}`。评估report含数据集来源、标注确认、总数、五类stratum计数、漏待办/错误关键转移数、注入回归结果及artifact hash。

- [ ] **1. 写 B10/B38/B42/B44/B48/B52 失败测试。** 99条不合格；100条但任一高风险类<20不放开该流；tuple改变失效；未批准模式绝不清临时review；已合格也不能清既有业务义务；100条全抽查、101–110至少1条；一次漏待办暂停并恢复上次通过抽查后相关核对。
  ```ts
  assert.equal(gateFor99.eligible, false);
  assert.equal(autoRouteWithUnapprovedTuple, false);
  assert.equal(auditRowsForFirst100, 100);
  assert.ok(auditRowsForNext10 >= 1);
  assert.equal(resultAfterOneMiss.paused, true);
  assert.equal(existingBusinessObligation.state, 'open');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/backend/mail-triage-evaluation.test.ts"`。
- [ ] **3. 实现资格与抽查。** 五层为需动作、最终/条件决定、关联冲突、引用旧请求、信息不足，每层≥20可重叠，合计≥100真实脱敏且人工标注邮件；注入用独立对抗集。关键漏待办/错误关键状态转移必须0才可请求启用相应流；这是本地门槛，不宣称总体准确率。抽查序号跨重启持久化；每十封第十封必入队，不用随机概率代替最低覆盖。
- [ ] **4. 实现评估/批准RPC及脚本。** 增加 `mail.triage.evaluationStatus` read、`mail.triage.approveNotificationRouting` confirm、`mail.triage.auditOutcome` confirm，全部assistant excluded；批准必须提供同tuple已保存的报告hash并CAS。脚本默认只校验本地label+预测结果文件，参数为`--labels <path> --predictions <path> --output <path>`；缺真实样本输出NOT_QUALIFIED，不自动调用模型或捏造样本数。
- [ ] **5. 跑绿灯与检查点。** evaluation/projector测试通过；保存合成fixture回归结果与真实评估「尚未进行」两种不同状态。此执行阶段默认仍关闭自动通知分流，直到用户提供授权样本、完成评估并明确批准。

### Task 13: 邮件模块壳、路由、SSE 与计数语义

**Files:** Create `F:/projects/website-gen/src/renderer/src/features/mail/mail-layout.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-triage-client.ts`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-layout.test.ts`；Modify `F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.tsx`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.index.tsx`、现有 `F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.$mailboxId.tsx` 及其folder/uid子路由、`F:/projects/website-gen/src/renderer/src/components/layout/app-sidebar.tsx`、`F:/projects/website-gen/src/renderer/src/components/layout/nav-group.tsx`、`F:/projects/website-gen/src/renderer/src/lib/backend.ts`、`F:/projects/website-gen/src/renderer/src/lib/query-client.ts`、`F:/projects/website-gen/src/renderer/src/lib/query-client.test.ts`、`F:/projects/website-gen/src/renderer/src/lib/router-runtime.test.ts`、`F:/projects/website-gen/src/renderer/src/features/settings/settings.tsx`。

**Interfaces:** `MailLayout():ReactNode` 只布局+Outlet；`useTriageStatus():UseRpcDataResult<TriageStatus>`（使用现有useRpcData实际返回类型，导出别名不自行捏造hook结果）；`invalidateTriageViews():void`；导航badge改为 `{value:number,label:string}`。settings中mail_triage角色行进入专用配置页，translation保持原交互。

- [ ] **1. 写 B35/B45/B46 与 RF4 失败测试。** `/mail`默认看板，旧`/mail/7/Sent%20Messages/42`仍读同邮件；静态 `/mail/review/settings/inbox/manage` 不被当mailboxId；folder切换不无谓remount；sidebar取needsActionCaseCount不是unreadCount；reset/reconnect invalidates triage全部query，普通mail scoped事件仍只刷目标邮箱。
  ```ts
  assert.equal(sidebarBadge.value, status.needsActionCaseCount);
  assert.equal(sidebarBadge.label, '需要处理的申请');
  assert.equal(modelCallsAfterSseReconnect, 0);
  assert.equal(legacyRoute.params.folder, 'Sent Messages');
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/renderer/src/features/mail/mail-layout.test.ts" "F:/projects/website-gen/src/renderer/src/lib/router-runtime.test.ts" "F:/projects/website-gen/src/renderer/src/lib/query-client.test.ts"`；预期route/计数不符合。
- [ ] **3. 实现路由壳。** 新静态路由文件在任务14/15创建；父级不再重复渲染阅读器，动态mailbox分支只在父层挂原MailPage，保持folder/uid Outlet与参数安全guard。新 `cases/$caseId` UUIDguard；routeTree由Vite插件生成，不手写覆盖生成结果。
- [ ] **4. 实现数据失效和模型角色入口。** topics=['mail_triage']；worker/人工提交后的changed事件+写RPC成功后method/exact invalidation；重连/reset拉当前授权状态，不把旧SSE payload合并成权威投影。保留150ms去抖和按user/query隔离；补reset现有仅connectListeners的缺口。侧栏无权限/未启用时不显示假0已清空。
- [ ] **5. 跑绿灯与检查点。** 布局/route/query及现有translation-role测试通过；`npm run typecheck`；确认新角色入口不改变agent/translation绑定。

### Task 14: 三列看板、申请详情与处理结果交互

**Files:** Create `F:/projects/website-gen/src/renderer/src/features/mail/mail-board-page.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-case-card.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-case-drawer.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-task-outcome-dialog.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-case-correction-dialog.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-board.test.ts`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.cases.$caseId.tsx`；Modify `F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.index.tsx`。

**Interfaces:** `MailBoardPage({caseId?:string})`；`MailCaseCard({item:CaseProjection,onOpen:(id:string)=>void})`；`MailCaseDrawer({caseId:string,onClose:()=>void})`；`MailTaskOutcomeDialog({caseId:string,tasks:TaskView[],expectedVersion:number})`。CaseDetail由授权RPC返回projection、来源时间线、当前摘要/证据、历史/当前周期，不由前端推断业务状态。

- [ ] **1. 写 B01/B04/B05/B12/B18–B20/B26/B42/B45–B51 失败交互测试。** 卡片显示平台/站点/邮箱上下文、2–6字tag、待办数/最新有效进度；签名完成不是获批；新信临时核对即从结果列到处理列；任务勾选和CAS冲突展示；未知来源仅候选；禁拖拽改状态；待确认/未预审入口不被空看板隐藏。
  ```ts
  assert.equal(renderedColumnTitles.join('/'), '需要你处理/等待平台/结果回执');
  assert.equal(successClaimForSignedMail, false);
  assert.equal(markWholeApplicationApprovedButtonPresent, false);
  assert.equal(remainingUploadTaskVisibleAfterReply, true);
  assert.equal(sourceUnavailableOpenButtonDisabled, true);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/renderer/src/features/mail/mail-board.test.ts"`；预期无页面/交互。
- [ ] **3. 实现页面。** 按第三版视觉保留三列而非扩展八列；顶部邮箱范围选择、待确认/未预审入口、搜索筛选；卡片不放停止监听/删除邮箱；详情分「下一步 / 邮件时间线 / 判定依据与人工记录」，原文与AI建议分别标识。
- [ ] **4. 实现操作与小屏。** 记录处理结果必须选择具体义务和结果；查看来源转安全reader，失效源禁假链接；纠正使用expectedVersion、冲突后重拉并显示差异。小屏分段列表、详情全屏；Radix焦点管理/Escape返回/键盘卡片访问；颜色外有文字图标。支付请求只提示独立官方核验，不提供支付按钮。
- [ ] **5. 跑绿灯与检查点。** board交互+typecheck通过；真正浏览器版式/焦点验证留任务16，不能用源代码字符串断言冒充视觉验收。

### Task 15: 分层邮箱、待确认/通知/抽查、设置与管理页

**Files:** Create `F:/projects/website-gen/src/renderer/src/features/mail/mail-review-page.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-triage-settings-page.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-management-page.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mailbox-pane.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/message-list-pane.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/message-reader-pane.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/compose-dialog.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/credential-dialog.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-triage-pages.test.ts`；Create route files `F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.inbox.tsx`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.review.tsx`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.notifications.tsx`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.settings.tsx`、`F:/projects/website-gen/src/renderer/src/routes/_authenticated.mail.manage.tsx`；Modify `F:/projects/website-gen/src/renderer/src/features/mail/mail-page.tsx`、`F:/projects/website-gen/src/renderer/src/features/mail/mail-interaction.test.ts`。

**Interfaces:** `MailReviewPage({filter?:ReviewFilter})` 复用授权reviewQueue分页；`MailTriageSettingsPage()`、`MailManagementPage()`；阅读pane均为纯props UI，既有MailPage继续持有route/list identity、RPC、seen串行、translation pending identity和Compose源文状态。不要再造第二套读取/翻译controller。

- [ ] **1. 写 B11/B14/B22–B24/B35/B38/B40/B42–B46/B48/B52/B59 与 RF4 失败测试。** 域名→邮箱→folder层级；暂停/删除放管理页；AI设置未配置/队列暂停/预算/失败/无申请/空通知各不同；模型/范围同意、7/30天补审预览≤200；A→B→A翻译不串信；打开/已读/搜索/SSE不调用预审；URL及恶意HTML均textContent无anchor/img。
  ```ts
  assert.equal(mailBodyAnchors, 0);
  assert.equal(remoteImages, 0);
  assert.equal(previewAcceptedWithoutConfirmation, false);
  assert.equal(modelCallsOnOpenSearchAndSeen, 0);
  assert.equal(composeQuotedText, originalText);
  assert.equal(auditQueueVisibleWhileAutoRouting, true);
  ```
- [ ] **2. 跑红灯。** `node --test "F:/projects/website-gen/src/renderer/src/features/mail/mail-triage-pages.test.ts" "F:/projects/website-gen/src/renderer/src/features/mail/mail-interaction.test.ts"`；确认新增行为确实失败，原先测试仍能执行真实controller。
- [ ] **3. 拆纯UI并保留控制逻辑。** 去掉混在每个邮箱卡片中的监听/删除大块操作；显示账号/域名分组、邮箱范围和folder，当前邮箱清晰突出。原read/unread、250ms搜索、发送/附件/翻译行为保留；附件仅点击下载，不自动解析/预览。调整Vite/VM测试harness使新本地pane实际执行，不externalize成空stub。
- [ ] **4. 实现review与通知。** 队列按未预审/待关联/判定待确认/失败/通知抽查过滤；摘要、原文证据、来源状态、具体建议、原因和人工纠正可见。通知不自动删除/归档/改已读；未知失败不归入通知；未确认case允许查看证据后确认身份；联系人映射与每封来源确认明确分开。
- [ ] **5. 实现专用设置与管理。** 基础开关/独立模型/范围/模式/历史补审，高级预算/提醒/联系人映射；自动通知分流显示版本、评估缺口、单独批准开关；服务商变更显示数据目的地/无法撤回声明。管理页沿用原监听/凭据/删除确认接口，不引入新远端操作。未来新邮箱默认不勾选。
- [ ] **6. 跑绿灯与检查点。** triage-pages/mail-interaction/translation角色+typecheck通过；文字截断有可读展开但不把URL变链接；不创建假完整完成状态。

### Task 16: 离线浏览器验收、全量回归与发布/回滚记录

**Files:** Create `F:/projects/website-gen/scripts/mail-triage-smoke.ts`、`F:/projects/website-gen/scripts/mail-triage-smoke-fixture.ts`、`F:/projects/website-gen/src/backend/mail-triage-acceptance.test.ts`、`F:/projects/website-gen/docs/superpowers/plans/mail-triage-runbook.md`；Modify `F:/projects/website-gen/package.json`（添加smoke:mail脚本）、必要时 `F:/projects/website-gen/scripts/smoke.ts`（仅复用测试帮助函数，不注入生产测试后门）。

**Interfaces:** `startMailTriageFixture():Promise<{baseUrl:string,dispose:()=>Promise<void>,stats:()=>FixtureStats}>` 仅脚本导出，创建临时SQLite/密钥/身份与seed邮箱、fake IMAP/SMTP/model；生产 `src/server/index.ts` 不添加跳过鉴权的测试环境开关。fixture服务使用真实Workspace RPC/SSE适配器和built renderer，HTTP仅loopback；真实SMTP/Hostinger transport未实例化。`FixtureStats` 含model/SMTP调用数及禁止外连次数，不含正文。

- [ ] **1. 写验收测试矩阵与失败断言。** 将下节B01–B62每条映射到具名node:test；另实现浏览器脚本：三列+counts→新信临时核对→签名但待补件→拒绝+回复→发送收据仅处理选中项→来源失效→冲突人工纠正→独立模型设置→禁用与在途取消→SSE reset重连→旧URL/翻译/原文回复→管理页。缺任一核心路径脚本非零退出。
- [ ] **2. 跑新增验收并记录基线。** 先写可执行harness骨架和明确断言，再 `npm run build` 与 `node "F:/projects/website-gen/scripts/mail-triage-smoke.ts"`；若产品行为不满足则记录具体红灯。此前任务已实现全部行为时允许首次即绿灯，不故意破坏代码制造失败；缺脚本、浏览器不存在或harness自身错误均不算业务红灯。浏览器不可用记录环境阻断，不降低断言。
- [ ] **3. 实现隔离harness。** 复用现有smoke的Edge优先/QA_CHROMIUM_PATH支持，使用临时目录且删除前确认真实路径在该临时根；后端依赖注入fake，网络guard拒绝非fixture端点；浏览器route拦所有非loopback请求并令其成为失败，不只记录。登录/会话仍走真实已认证fixture用户，不将client userId当授权。
- [ ] **4. 跑确定性总回归。** 工作目录 `F:/projects/website-gen` 执行 `npm test`、`npm run typecheck`、`npm run build`、`git diff --check`。若 `npm test` 出现已知spawn EPERM，记录原命令失败，再单列 `node --test --test-isolation=none "F:/projects/website-gen/src/**/*.test.ts"` 结果；这不替代标准隔离/浏览器验收，其他失败不得归咎为EPERM。
- [ ] **5. 跑真实浏览器离线验收。** `npm run smoke` 和新增 `npm run smoke:mail`。1440/1280/390宽度各截图；断言无横向溢出、键盘聚焦/返回、无pageerror/非预期console error；模型/邮箱/SMTP全部fixture，邮件URL网络尝试为0。把截图和日志复制到独立验收目录留hash，而不是仅称「视觉看起来正确」。
- [ ] **6. 写runbook与灰度/回滚演练。** 默认预审关闭→管理员配置单个测试邮箱→只建议模式→确定性回归通过→用户授权真实样本评估→逐邮箱放开自动建议→资格门批准通知分流。每步列入退出条件、关闭开关、旧reader可用性。完整db备份用停服一致性SQLite backup/VACUUM INTO，不复制活跃WAL中单一db冒充备份；先演练恢复到另一临时路径再hash/foreign_key_check/读取旧绑定。
- [ ] **7. 最终检查点。** 记录所有变化文件、测试命令/退出码/数目、截图hash、迁移/备份恢复证据、没有真实外部调用的证据和仍未验证项。生产启用、真实IMAP/SMTP/模型兼容性、真实标注集准确性及出站策略未验时必须标未验；存在P1或关键矩阵缺测不能称上线完成。

## 3. 完整验收追踪表

下表指向未来测试，**不是已通过的执行记录**。每组需在对应测试文件中使用 `Bxx` 前缀命名；不能只有一条宽泛测试声称覆盖整组。

| 设计验收ID | 归属任务 | 必须固定的判断 |
|---|---|---|
| B01 | 5/6/14 | 签名仅里程碑，不获批 |
| B02 | 5/6 | 正式批准无新动作，来源合格后结果列，标邮件声称非平台核验 |
| B03 | 5/6 | 条件批准不是最终批准 |
| B04 | 5/6/14 | 拒绝并要求回复，仍需处理 |
| B05 | 5/6/14 | 获批并激活，仍需处理 |
| B06 | 5/6/11 | 只回执一项材料，其余不解除 |
| B07 | 5/6/11 | 回复与上传拆两义务 |
| B08 | 5 | 无问号的明确客服请求 |
| B09 | 5 | no-reply不决定无需处理 |
| B10 | 5/6/12 | 明确无动作仍过资格门，仅解除本信临时核对 |
| B11 | 5/15 | OTP不制造申请待办、不泄漏标签 |
| B12 | 5/6/14 | 停用不覆盖历史获批 |
| B13 | 5/6 | 引用旧要求不是新请求 |
| B14 | 4/5/15 | 仅链接/附件/图片需人工核对，不访问 |
| B15 | 6/10 | 同平台两个申请不混合 |
| B16 | 6/10 | 多申请歧义人工拆分 |
| B17 | 6 | 旧邮件迟到不盖新事实 |
| B18 | 6/14 | 批准拒绝冲突不能猜 |
| B19 | 6/14 | 获批后新问询重新需处理 |
| B20 | 6/14 | 签名后缺材料仍待办 |
| B21 | 5/6 | 未知期限不编造 |
| B22 | 11/15 | 草稿不改变状态 |
| B23 | 11/15 | 已发收据+选定义务才转外部等待 |
| B24 | 11/15 | SMTP失败/未知/append失败分别呈现，不重发 |
| B25 | 11 | 唯一退信匹配才阻塞义务 |
| B26 | 6/10/14 | 人工覆盖不被重审冲掉 |
| B27 | 6/10 | 人工关旧义务不吞新请求 |
| B28 | 2 | 同Message-ID不同body不是同信 |
| B29 | 2/3 | 重复同步/入队/应用幂等 |
| B30 | 2/8 | UIDVALIDITY重用与alias安全 |
| B31 | 7/8/9 | 删除/放弃期间旧结果不能写回 |
| B32 | 3/7 | 重启可恢复，SSE不是队列 |
| B33 | 2/7 | cache+登记同事务/恢复不漏单 |
| B34 | 5/7 | JSON、假引文、超时错误保留未判定 |
| B35 | 4/9/13/15 | 独立用途/Key不回退 |
| B36 | 7/8/9 | 禁用/模型切换作废在途结果 |
| B37 | 8/9/10 | RPC/worker/source/上下文全链路工作区隔离 |
| B38 | 4/5/12/15/16 | 提示注入、HTML、URL无能力/网络执行 |
| B39 | 5 | 标签及未知ID白名单校验 |
| B40 | 3/4/9/15 | 预算、大小、补审上限 |
| B41 | 7/10 | 人工/AI并发CAS |
| B42 | 9/12/14/15 | 未预审和失败不能显示全部完成 |
| B43 | 11/15 | 跨邮箱事项仍用原收件身份回复 |
| B44 | 12/15 | 通知不删、不归档、不改已读 |
| B45 | 6/13/14 | cases/emails/tasks计数不混 |
| B46 | 13–16 | 键盘/小屏/空态/重连 |
| B47 | 6/7/9/14 | AI暂停也因新信马上临时核对 |
| B48 | 6/12/15 | 未评估no_action保留复核 |
| B49 | 6/10/14 | 联系人映射不等于单封认证 |
| B50 | 6/14 | 账户停用无请求仍核对 |
| B51 | 6/10/14 | 复审新周期不伪造受理 |
| B52 | 12/15 | 一次漏判暂停并追查 |
| B53 | 3/7/8 | 取消不可租约恢复复活 |
| B54 | 8/10/11 | 删除支持链，人工标签非独立证据 |
| B55 | 2/4 | sourceHash不使用脱敏promptHash |
| B56 | 6 | 邮件自称平台/编号只候选 |
| B57 | 2/9 | 三新信/一SSE仍三个持久任务 |
| B58 | 3/4/7 | 实际3次不是嵌套9次 |
| B59 | 4/8/9/15 | 未授权邮箱上下文/派生摘要不外发 |
| B60 | 3/7 | 出站崩溃扣预算、deadline+30s后才恢复 |
| B61 | 2/9 | 启用水位与同步竞态不漏新信/不扫历史 |
| B62 | 6/8 | stale唯一证据立即人工核对 |

## 4. 发布、回滚与完成条件

### 分层证据，不能混写

1. **计划自检：**本文件与批准设计对齐、16任务、B01–B62和RF1–RF5都有归属，类型/文件/命令一致。仅此项属于当前计划交付。
2. **实施本地验收：**任务1–16真正跑过的测试/构建/离线浏览器与恢复演练，完成后另填日志、截图和hash。不能从计划矩阵推断已通过。
3. **真实模型评估：**需用户提供/批准的脱敏真实邮件及人工真值，版本绑定评估结果；没有数据就保持未合格，不用合成fixtures替代。
4. **真实服务/部署：**以后另获授权检查实际邮件监听、模型、SMTP、部署出站限制及生产配置；本轮不进行，不承诺已上线。

### 运行回滚优先级

- 最小止损：关闭预审、递增epoch、撤销租约、尝试abort；确认原邮箱阅读/人工发送仍能用。已发往模型的内容不能承诺撤回。
- 业务误判：人工纠正/撤销产生补偿事件，旧评估可追溯；不回滚整个数据库覆盖后续真实邮件或人工工作。
- 代码回滚：只恢复本任务拥有且当前hash未被他人改变的文件；关闭功能后保持向前兼容schema，**不自动drop新增表**。
- 数据迁移失败：停止应用写入，验证一致性备份，在独立路径演练后再人工决定恢复；不能覆盖正在收新信的DB或只恢复db忽略WAL。任何恢复都重新跑绑定/外键/来源隔离/基础读信验证。
- 本次计划回滚：仅移除新增计划及其baseline/verification文件；不删除整个 `docs/superpowers`，不碰批准设计/原型图/他人新增文件。

### 最终完成闸门

- 功能：指定独立模型、自动安全预审、短标签、义务级处理、分层邮箱、三列申请看板均有实现和证据。
- 安全：禁止邮件链接访问、无自动发信/删信、范围与工作区隔离、来源/世代/人工版本/fence、清理溯源全部通过；关键P1=0。
- 回归：现有邮件翻译、已读竞态、原文回复、SMTP/append、删除/放弃、模型密钥隔离、旧路由均无新增失败；基线失败单独保留记录，不悄悄删测试。
- 报告：源文件变化、测试计数/退出码、截图/hash、备份/回滚证据和外部未验项完整。默认关闭自动通知分流，未完成真实评估不能宣布AI判定可靠。

## 5. 根代理自检与待用户选择

- 本计划使用当前代码接缝，特别保留 migration014/translation、SSE非任务源、原MailPage竞态、两类provider adapter、SMTP收据与工作区RPC风险边界。
- 根代理在落盘后执行设计覆盖、步骤粒度、类型/签名一致性、Review Focus覆盖、篇幅比例自检；结果写入旁置verification文件，不由子代理替代自检。
- 推荐 **Subagent-driven**：每任务新实施者、独立审查后再进入下一任务，最后整体审查；原因是数据撤权、队列崩溃和义务状态相互影响，错误可能造成邮件内容外发或漏待办。
- 备选 **Native**：本会话逐任务执行，最后独立整体审查；开销更低，但中途没有逐任务独立审查。
- 等用户审阅计划并选择执行方式后才开始实现；当前不创建worktree、不改业务代码、不提交、不部署。
