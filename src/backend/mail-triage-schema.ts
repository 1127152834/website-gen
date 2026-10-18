import { z } from "zod";
import { APPLICATION_DECISIONS, APPLICATION_STAGES, BOARD_COLUMNS, CASE_IDENTITY_STATES, MAIL_CATEGORIES, MAIL_TRIAGE_LIMITS, MAIL_TRIAGE_SCHEMA_VERSION, OBLIGATION_KINDS, OBLIGATION_STATES, SOURCE_STATES, SOURCE_TRUST, TRIAGE_JOB_STATES, TRIAGE_MODES } from "../shared/mail-triage-types.ts";

const positiveInt = z.number().int().positive();
const nonnegativeInt = z.number().int().nonnegative();
const text = z.string().min(1);
/** 邮件限额按 Unicode code point 计数；JS UTF-16 length 不能代替字符数。 */
const boundedText = (max:number) => text.refine(value => Array.from(value).length <= max, `最多${max}个Unicode字符`);
export const SourceLocatorSchema = z.object({ mailboxId: positiveInt, folder: text, uidValidity: text, uid: positiveInt }).strict();
export const SourceReaderRefSchema = SourceLocatorSchema.extend({ sourceId: z.uuid(), sourceVersion: positiveInt }).strict();
export const CaseSourceReaderRefSchema = SourceLocatorSchema.extend({ caseId: z.uuid(), sourceId: z.uuid(), sourceVersion: positiveInt }).strict();
export const MailSendSelectionSchema = z.object({
  mailboxId: positiveInt,
  caseId: z.uuid().optional(),
  selectedTaskIds: z.array(z.uuid()).max(100).optional(),
  replyTo: z.object({ folder: text, uid: positiveInt, readerRef: CaseSourceReaderRefSchema.optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if ((value.selectedTaskIds?.length ?? 0) > 0 && !value.replyTo?.readerRef) context.addIssue({ code: "custom", path: ["replyTo", "readerRef"], message: "所选回复义务必须提供完整来源阅读能力" });
});
const MailAttachmentSchema=z.object({partId:z.string(),name:z.string(),type:z.string(),size:nonnegativeInt}).strict();
export const MailMessageDetailSchema=z.object({uid:positiveInt,folder:z.string(),from:z.string(),to:z.array(z.string()),cc:z.array(z.string()),subject:z.string(),date:nonnegativeInt,snippet:z.string(),seen:z.boolean(),hasAttachments:z.boolean(),size:nonnegativeInt,readIdentity:z.string().regex(/^[a-f0-9]{64}$/).optional(),text:z.string(),messageId:z.string().nullable().optional(),inReplyTo:z.string().nullable().optional(),references:z.array(z.string()).optional(),attachments:z.array(MailAttachmentSchema)}).strict();
export const CaseSourceMessageOutputSchema=z.object({ref:CaseSourceReaderRefSchema,message:MailMessageDetailSchema}).strict();
export const ReviewSourceMessageOutputSchema=z.object({sourceRef:SourceReaderRefSchema,readerRef:CaseSourceReaderRefSchema.nullable(),message:MailMessageDetailSchema}).strict();
export const VersionTupleSchema = z.object({ providerId: positiveInt, modelId: text, modelConfigRevision: positiveInt, promptVersion: positiveInt, ruleVersion: positiveInt, schemaVersion: positiveInt }).strict();
export const MutationMetaSchema = z.object({ requestId: z.uuid(), expectedVersion: nonnegativeInt, reason: text.trim().min(1).max(2000) }).strict();
export const PageRequestSchema = z.object({ page: positiveInt.default(MAIL_TRIAGE_LIMITS.defaultPage), pageSize: positiveInt.max(MAIL_TRIAGE_LIMITS.maxPageSize).default(MAIL_TRIAGE_LIMITS.defaultPageSize) }).strict();
export const SourceIdInputSchema = z.object({ sourceId: z.uuid() }).strict();
export const SourceIdsSchema = z.array(z.uuid());
export const CaseIdInputSchema = z.object({ caseId: z.uuid() }).strict();
export const CaseListSchema = PageRequestSchema.extend({ column: z.enum(["needs_you", "awaiting_platform", "results"]).optional(), mailboxId: positiveInt.optional(), site: z.string().trim().max(500).optional(), mailboxAddress: z.string().trim().email().optional(), provider: z.string().trim().max(500).optional(), query: z.string().trim().max(500).optional() }).strict();
export const ReviewQueueSchema = PageRequestSchema.extend({ filter: z.enum(["unreviewed", "unlinked", "failed", "review", "audit", "notifications", "notification_mail"]), mailboxId: positiveInt.optional(), query: z.string().trim().max(500).optional() }).strict();
export const ReviewSourcePreviewInputSchema=z.object({sourceId:z.uuid(),sourceVersion:positiveInt}).strict();
export const MessageAnnotationsInputSchema=z.object({mailboxId:positiveInt,folder:text,messages:z.array(z.object({uid:positiveInt,readIdentity:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(100)}).strict();
export const ReminderSettingsSchema = z.object({ followUpDays: positiveInt.max(365).default(7), leadDays: nonnegativeInt.max(30).default(1) }).strict();
export const TriageConfigSchema = z.object({
  enabled: z.boolean().default(false), mailboxIds: z.array(positiveInt).default([]), mode: z.enum(TRIAGE_MODES).default("auto_suggest"),
  modelBinding: z.object({ providerId: positiveInt, modelId: text, thinking: z.enum(["off", "minimal", "low", "medium", "high", "max"]) }).strict().nullable().default(null),
  dailyAttemptLimit: positiveInt.default(MAIL_TRIAGE_LIMITS.dailyAttemptLimit), consentProviderRevision: positiveInt.nullable().default(null),
  reminderEnabled: z.boolean().default(false), reminderSettings: ReminderSettingsSchema.default({ followUpDays: 7, leadDays: 1 }), autoNotifications: z.boolean().default(false),
}).strict();
export const ConfigureTriageSchema = MutationMetaSchema.extend({
  enabled: z.boolean(), mailboxIds: z.array(positiveInt).max(200), mode: z.enum(TRIAGE_MODES),
  modelBinding: z.object({ providerId: positiveInt, modelId: text, thinking: z.enum(["off", "minimal", "low", "medium", "high", "max"]) }).strict().nullable(),
  dailyAttemptLimit: positiveInt.max(5000), consentProviderRevision: positiveInt.nullable(),
  reminderEnabled: z.boolean().optional(), reminderSettings: ReminderSettingsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.enabled && value.modelBinding === null) context.addIssue({ code: "custom", path: ["modelBinding"], message: "启用邮件预审必须明确模型绑定" });
  if (value.enabled && value.consentProviderRevision === null) context.addIssue({ code: "custom", path: ["consentProviderRevision"], message: "启用邮件预审必须明确同意服务商revision" });
});
export const BackfillPreviewSchema = z.object({ mailboxIds: z.array(positiveInt).min(1).max(200), days: z.union([z.literal(7), z.literal(30)]) }).strict();
export const EnqueueTriageSchema = z.union([
  z.object({ requestId: z.uuid(), previewId: text }).strict(),
  z.object({ requestId: z.uuid(), sourceIds: z.array(z.uuid()).min(1).max(MAIL_TRIAGE_LIMITS.historyBatchSize) }).strict(),
]);
export const JobMutationSchema = z.object({ requestId: z.uuid(), jobId: z.uuid(), expectedVersion: nonnegativeInt }).strict();
export const ContactMappingSchema = z.object({
  id: z.uuid().optional(), providerKey: text.trim().max(200), siteId: positiveInt.nullable(),
  mailboxIds: z.array(positiveInt).min(1).max(200), senderAddresses: z.array(text.trim().email()).max(200),
  domains: z.array(text.trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)).max(200),
}).strict().refine(value => value.senderAddresses.length > 0 || value.domains.length > 0, "至少提供一个发件地址或域名");
export const EvidenceRefSchema = z.object({ sourceId: z.uuid(), quote: boundedText(500).refine(value=>value.trim().length>0,"摘录不可为空白") }).strict();
export const ProvenanceSchema = z.object({ supportSourceIds: z.array(z.uuid()), kind: z.enum(["source_derived", "independent_manual"]), verifiedAt: nonnegativeInt.nullable(), reason: text.nullable() }).strict().refine((value) => value.kind === "source_derived" ? value.supportSourceIds.length > 0 : value.verifiedAt !== null && value.reason !== null, "来源派生信息须有支持来源；独立人工事实须有核验时间与原因");
export const ASSESSMENT_EVENT_KINDS = ["application_submitted", "review_started", "materials_received", "agreement_sent", "signature_completed", "application_conditionally_approved", "application_approved", "application_declined", "application_withdrawn", "reconsideration_accepted", "account_activated", "account_restricted", "account_suspended", "account_disabled", "account_closed", "notification"] as const;
export type AssessmentEventKind = typeof ASSESSMENT_EVENT_KINDS[number];
const evidence = z.array(EvidenceRefSchema).min(1).max(4);
/** 这里只校验形状；候选集合、摘录及业务兼容性由 analyzer 再验证。模型布尔值不产生权限。 */
export const AssessmentOutputSchema = z.object({
  schemaVersion: z.literal(MAIL_TRIAGE_SCHEMA_VERSION), primaryCategory: z.enum(MAIL_CATEGORIES), tag: text.refine(value=>Array.from(value).length>=2&&Array.from(value).length<=6&&/^\p{Script=Han}+$/u.test(value),"标签须为2–6个汉字"), summary: boundedText(240),
  caseSuggestion: z.object({ providerCandidate: boundedText(200).nullable(), applicationId: boundedText(200).nullable(), candidateCaseId: z.uuid().nullable(), matchBasis: z.array(boundedText(120)).max(8), needsReview: z.boolean() }).strict(),
  events: z.array(z.object({ kind: z.enum(ASSESSMENT_EVENT_KINDS), evidence }).strict()).max(16),
  actions: z.array(z.object({ kind: z.enum(OBLIGATION_KINDS), title: boundedText(200), requestedItems: z.array(boundedText(500)).max(16), deadlineRaw: boundedText(500).nullable(), satisfiesTaskIds: z.array(z.uuid()).max(16), evidence }).strict()).max(16),
  completionSuggestions: z.array(z.object({ taskId: z.uuid(), evidence }).strict()).max(16), uncertainties: z.array(boundedText(500)).max(12), requiresHumanReview: z.boolean(),
}).strict();
const validatedAction = AssessmentOutputSchema.shape.actions.element.extend({ deadlineAt: z.number().int().nullable() }).strict();
export const PersistedValidatedAssessmentSchema = z.object({
  ...AssessmentOutputSchema.shape,
  actions: z.array(validatedAction).max(16),
  grade: z.enum(["evidence_complete", "needs_review"]),
  usage: z.object({ inputTokens: nonnegativeInt.nullable(), outputTokens: nonnegativeInt.nullable(), estimatedCost: z.number().nonnegative().nullable() }).strict().nullable(),
  evidenceLocations: z.array(z.object({ path: text, sourceId: z.uuid(), quote: boundedText(500), locations: z.array(z.object({ field: z.enum(["text", "subject"]), segment: z.enum(["current_body", "quoted_history", "signature", "subject"]), start: nonnegativeInt, end: nonnegativeInt, coordinateUnit: z.literal("utf16") }).strict()) }).strict()),
  applicationRestrictions: z.array(text),
}).strict();
export const TaskViewSchema = z.object({ id: z.string().min(1), kind: z.enum(OBLIGATION_KINDS), state: z.enum(OBLIGATION_STATES), title: text, requestedItems: z.array(z.string()), deadlineRaw: z.string().nullable(), deadlineAt: z.number().int().nullable(), snoozedUntil: z.number().int().positive().nullable().optional().default(null), provenance: ProvenanceSchema }).strict();
export const SafeCaseProjectionSchema = z.object({ caseId: z.uuid(), version: positiveInt, identityState: z.enum(CASE_IDENTITY_STATES), column: z.enum(BOARD_COLUMNS).nullable(), stage: z.enum(APPLICATION_STAGES), decision: z.enum(APPLICATION_DECISIONS), decisionCycle: nonnegativeInt, decisionExplanation: z.string().nullable().optional().default(null), milestones: z.array(z.string()), tasks: z.array(TaskViewSchema), sourceUnavailable: z.boolean(), requiresReply: z.boolean(), requiresAction: z.boolean(), requiresReview: z.boolean() }).strict();
export const PersistedProjectedCaseSchema = SafeCaseProjectionSchema.extend({
  decisionLabel: z.enum(["邮件显示", "人工核验"]).nullable(),
  priority: z.object({ rank: nonnegativeInt, observedAt: nonnegativeInt, id: z.string() }).strict(),
  reminders: z.array(z.object({ key: z.string(), taskId: z.string(), deadlineAt: z.number().int().nullable() }).strict()),
  safetyReviews: z.array(z.object({ id: z.string(), reason: z.string(), cycle: nonnegativeInt, provenance: ProvenanceSchema }).strict()),
}).strict();
const CaseSummaryFieldsSchema = z.object({
  caseId: z.uuid(), version: positiveInt, manualVersion: nonnegativeInt, identityState: z.enum(CASE_IDENTITY_STATES), column: z.enum(BOARD_COLUMNS).nullable(),
  provider: z.string().nullable(), siteId: positiveInt.nullable(), siteLabel: z.string().nullable(), applicationId: z.string().nullable(),
  mailboxAddress: z.string().email().nullable(), mailboxCount: nonnegativeInt, mailboxAddresses: z.array(z.string().email()),
  tag: z.string().refine(value=>Array.from(value).length>=2&&Array.from(value).length<=6&&/^\p{Script=Han}+$/u.test(value),"标签须为2–6个汉字"),
  openTaskCount: nonnegativeInt, nextStep: z.string().nullable(), latestValidSummary: z.string().nullable(), latestValidAt: nonnegativeInt.nullable(),
  requiresReply: z.boolean(), requiresAction: z.boolean(), requiresReview: z.boolean(),
}).strict();
export const CaseSummaryOutputSchema = CaseSummaryFieldsSchema;
const CaseSourceViewSchema = z.object({ sourceId: z.uuid(), sourceVersion: positiveInt, manualVersion: nonnegativeInt, sourceState: z.enum(SOURCE_STATES), sourceTrust: z.enum(SOURCE_TRUST), mailboxId: positiveInt, mailboxAddress: z.string().email(), observedAt: nonnegativeInt, mailDate: nonnegativeInt.nullable(), tag: z.string().nullable(), summary: z.string().nullable(), readerRef: CaseSourceReaderRefSchema.nullable() }).strict();
const CaseTimelineEntrySchema = z.object({ id: z.uuid(), sourceId: z.uuid().nullable(), kind: z.string(), label: z.string(), decisionCycle: positiveInt, claimedAt: nonnegativeInt.nullable(), observedAt: nonnegativeInt, evidence: z.array(EvidenceRefSchema) }).strict();
const CaseEvidenceExcerptSchema = z.object({ sourceId: z.uuid(), quote: z.string(), observedAt: nonnegativeInt, sourceLabel: z.string(), sourceDate: nonnegativeInt }).strict();
const CaseDecisionCycleSchema = z.object({ cycle: positiveInt, decision: z.enum(APPLICATION_DECISIONS), explanation: z.string().nullable(), current: z.boolean() }).strict();
const CaseManualRecordSchema = z.object({ id: z.uuid(), field: z.string(), reason: z.string(), createdAt: nonnegativeInt, label: z.literal("人工记录") }).strict();
export const CaseDetailOutputSchema = CaseSummaryFieldsSchema.extend({ projection: SafeCaseProjectionSchema, sourceIds: z.array(z.uuid()), sources: z.array(CaseSourceViewSchema), timeline: z.array(CaseTimelineEntrySchema), evidence: z.array(CaseEvidenceExcerptSchema), currentCycle: CaseDecisionCycleSchema, historicalCycles: z.array(CaseDecisionCycleSchema), manualRecords: z.array(CaseManualRecordSchema) }).strict();
export const ContactMailboxIdsSchema = z.array(positiveInt);
export const ContactSenderAddressesSchema = z.array(z.string().email());
export const ContactDomainsSchema = z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/));
export const HistoricalPreviewTokenSchema = z.object({
  v: z.literal(1), configEpoch: positiveInt, mailboxIds: z.array(positiveInt).max(200),
  entries: z.array(z.object({ locator: SourceLocatorSchema, sourceHash: z.string().regex(/^[0-9a-f]{64}$/), criticalHeadersHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).max(MAIL_TRIAGE_LIMITS.historyBatchSize),
  scopeHash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: positiveInt,
}).strict();
export const BackfillBatchResultSchema = z.object({ requestId: z.uuid(), jobIds: z.array(z.uuid()), sourceIds: z.array(z.uuid()) }).strict();
export const JobViewSchema = z.object({ jobId: z.uuid(), sourceId: z.uuid(), state: z.enum(TRIAGE_JOB_STATES), version: nonnegativeInt, updatedAt: nonnegativeInt, lastError: z.string().nullable() }).strict();
export const ContactMappingOutputSchema = z.object({ id: z.uuid(), providerKey: text, siteId: positiveInt.nullable(), mailboxIds: ContactMailboxIdsSchema, senderAddresses: ContactSenderAddressesSchema, domains: ContactDomainsSchema, version: positiveInt, reason: text, confirmedAt: nonnegativeInt }).strict();
export const ContactRemoveResultSchema = z.object({ id: z.uuid(), version: positiveInt }).strict();
