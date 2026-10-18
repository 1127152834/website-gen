/** 邮件预审固定领域字典；不包含凭据或原始模型响应。 */
export const MAIL_CATEGORIES = ["action_request", "customer_inquiry", "progress", "milestone_receipt", "application_decision", "account_operations", "security_verification", "general_other"] as const;
export type MailCategory = typeof MAIL_CATEGORIES[number];
export const BOARD_COLUMNS = ["needs_you", "awaiting_platform", "results"] as const;
export type BoardColumn = typeof BOARD_COLUMNS[number];
export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = { needs_you: "需要你处理", awaiting_platform: "等待平台", results: "结果回执" };
export const CASE_IDENTITY_STATES = ["unconfirmed_case", "confirmed"] as const;
export type CaseIdentityState = typeof CASE_IDENTITY_STATES[number];
export const APPLICATION_STAGES = ["unknown", "preparing", "submitted", "reviewing", "ended"] as const;
export type ApplicationStage = typeof APPLICATION_STAGES[number];
export const APPLICATION_DECISIONS = ["unknown", "pending", "conditional", "approved", "declined", "withdrawn"] as const;
export type ApplicationDecision = typeof APPLICATION_DECISIONS[number];
export const APPLICATION_DECISION_LABELS:Record<ApplicationDecision,string>={unknown:"尚未确认",pending:"等待决定",conditional:"有条件批准",approved:"已批准",declined:"已拒绝",withdrawn:"已撤回"};
export const SOURCE_STATES = ["active", "stale", "missing", "deleted"] as const;
export type SourceState = typeof SOURCE_STATES[number];
export const SOURCE_TRUST = ["unconfirmed", "contact_mapped", "human_confirmed"] as const;
export type SourceTrust = typeof SOURCE_TRUST[number];
export const OBLIGATION_KINDS = ["reply", "action", "review"] as const;
export type ObligationKind = typeof OBLIGATION_KINDS[number];
export const OBLIGATION_STATES = ["open", "awaiting_external", "resolved_by_evidence", "resolved_by_human", "dismissed", "blocked"] as const;
export type ObligationState = typeof OBLIGATION_STATES[number];
export const TRIAGE_JOB_STATES = ["queued", "running", "retry_wait", "succeeded", "needs_review", "failed", "paused_budget", "blocked_config", "stale_source", "cancelled"] as const;
export type TriageJobState = typeof TRIAGE_JOB_STATES[number];
export const ASSESSMENT_GRADES = ["evidence_complete", "needs_review", "failed"] as const;
export type AssessmentGrade = typeof ASSESSMENT_GRADES[number];
export const TRIAGE_STATES = ["disabled", "initializing", "enabled", "paused_budget", "blocked_config", "paused_audit"] as const;
export type TriageState = typeof TRIAGE_STATES[number];
export const TRIAGE_MODES = ["auto_suggest", "suggest_only"] as const;
export type TriageMode = typeof TRIAGE_MODES[number];
export const MAIL_TRIAGE_SCHEMA_VERSION = 1 as const;
export const MAIL_TRIAGE_LIMITS = {
  workspaceConcurrency: 1, serviceConcurrency: 4, requestTimeoutMs: 60_000, maxAttempts: 3,
  retryDelaysMs: [30_000, 120_000], dailyAttemptLimit: 500, historyBatchSize: 200,
  bodyCharacters: 30_000, contextCharacters: 30_000, contextSources: 8,
  requestBytes: 256 * 1024, outputBytes: 16 * 1024, leaseTtlMs: 90_000,
  leaseRenewMs: 15_000, unknownResultGraceMs: 30_000, staleRetentionMs: 7 * 24 * 60 * 60 * 1000,
  initialAuditCount: 100, auditEvery: 10, defaultPage: 1, defaultPageSize: 30, maxPageSize: 100,
} as const;
export interface SourceLocator { mailboxId: number; folder: string; uidValidity: string; uid: number }
export interface SourceReaderRef extends SourceLocator { sourceId: string; sourceVersion: number }
export interface CaseSourceReaderRef extends SourceLocator { caseId: string; sourceId: string; sourceVersion: number }
export interface VersionTuple { providerId: number; modelId: string; modelConfigRevision: number; promptVersion: number; ruleVersion: number; schemaVersion: number }
export interface MutationMeta { requestId: string; expectedVersion: number; reason: string }
export interface Fence { jobId: string; leaseToken: string; attemptSeq: number; configEpoch: number; sourceVersion: number; contextVersion: string; manualVersion: number }
export interface EvidenceRef { sourceId: string; quote: string }
export interface Provenance { supportSourceIds: string[]; kind: "source_derived" | "independent_manual"; verifiedAt: number | null; reason: string | null }
export interface TaskView { id: string; kind: ObligationKind; state: ObligationState; title: string; requestedItems: string[]; deadlineRaw: string | null; deadlineAt: number | null; snoozedUntil?: number | null; provenance: Provenance }
export interface CaseProjection { caseId: string; version: number; identityState: CaseIdentityState; column: BoardColumn | null; stage: ApplicationStage; decision: ApplicationDecision; decisionCycle: number; decisionExplanation?: string | null; milestones: string[]; tasks: TaskView[]; sourceUnavailable: boolean; requiresReply: boolean; requiresAction: boolean; requiresReview: boolean }
export interface TriageStatus { needsActionCaseCount: number; awaitingCaseCount: number; resultCaseCount: number; unlinkedMailCount: number; unreviewedMailCount: number; failedMailCount: number; openTaskCount: number; auditPendingMailCount: number; dailyAttemptsUsed: number; dailyAttemptLimit: number; enabled: boolean; state: TriageState; configEpoch: number }
export interface PageRequest { page: number; pageSize: number }
export interface PageResult<T> extends PageRequest { items: T[]; total: number }
export interface BoardCasePage extends PageResult<CaseSummary> { columnTotals: Record<BoardColumn, number>; facets: { sites: string[]; mailboxes: string[]; providers: string[] } }
export interface TriageConfig { enabled: boolean; mailboxIds: number[]; mode: TriageMode; modelBinding: { providerId: number; modelId: string; thinking: string } | null; dailyAttemptLimit: number; consentProviderRevision: number | null; reminderEnabled: boolean; reminderSettings: { followUpDays: number; leadDays: number }; autoNotifications: boolean }
export interface TriageSettings extends TriageConfig { state: TriageState; configEpoch: number; modelConfigRevision: number; version: number }
export interface TriageResult { sourceId: string; sourceVersion: number; manualVersion: number; sourceState: SourceState; sourceTrust: SourceTrust; mailboxId: number; assessment: AssessmentOutput | null; grade: AssessmentGrade | null; jobState: TriageJobState | null }
export interface CaseSummary {
  caseId: string; version: number; manualVersion: number; identityState: CaseIdentityState; column: BoardColumn | null;
  provider: string | null; siteId: number | null; siteLabel: string | null; applicationId: string | null;
  mailboxAddress: string | null; mailboxCount: number; mailboxAddresses: string[]; tag: string; openTaskCount: number;
  nextStep: string | null; latestValidSummary: string | null; latestValidAt: number | null;
  requiresReply: boolean; requiresAction: boolean; requiresReview: boolean;
}
export interface CaseSourceView {
  sourceId: string; sourceVersion: number; manualVersion: number; sourceState: SourceState; sourceTrust: SourceTrust; mailboxId: number;
  mailboxAddress: string; observedAt: number; mailDate: number | null; tag: string | null; summary: string | null;
  readerRef: CaseSourceReaderRef | null;
}
export interface CaseTimelineEntry { id: string; sourceId: string | null; kind: string; label: string; decisionCycle: number; claimedAt: number | null; observedAt: number; evidence: EvidenceRef[] }
export interface CaseEvidenceExcerpt { sourceId: string; quote: string; observedAt: number; sourceLabel: string; sourceDate: number }
export interface CaseDecisionCycle { cycle: number; decision: ApplicationDecision; explanation: string | null; current: boolean }
export interface CaseManualRecord { id: string; field: string; reason: string; createdAt: number; label: "人工记录" }
export interface CaseDetail extends CaseSummary {
  projection: CaseProjection; sourceIds: string[]; sources: CaseSourceView[]; timeline: CaseTimelineEntry[];
  evidence: CaseEvidenceExcerpt[]; currentCycle: CaseDecisionCycle; historicalCycles: CaseDecisionCycle[]; manualRecords: CaseManualRecord[];
}
export interface ReviewRow {
  sourceId: string | null; jobId: string | null; caseId: string | null; state: string; reason: string | null; updatedAt: number;
  mailboxId: number | null; mailboxAddress: string | null; mailDate: number | null; sourceVersion: number | null; manualVersion: number | null;
  sourceState: SourceState | null; sourceTrust: SourceTrust | null; tag: string | null; summary: string | null; displayError: string | null;
  readerRef: CaseSourceReaderRef | null;
}
export interface ReviewSourcePreview { sourceRef: SourceReaderRef; readerRef: CaseSourceReaderRef | null; message: import("./mail-types.ts").MailMessageDetail; assessment: AssessmentOutput | null; grade: AssessmentGrade | null; displayError: string | null }
export interface MailMessageAnnotation {
  uid: number; readIdentity: string; sourceId: string; sourceVersion: number; manualVersion: number;
  tag: string; summary: string; grade: AssessmentGrade; reviewState: TriageJobState;
  sourceRef: SourceReaderRef;
}
export interface MailMessageAnnotationsResult { items: MailMessageAnnotation[] }
export interface JobView { jobId: string; sourceId: string; state: TriageJobState; version: number; updatedAt: number; lastError: string | null }
export interface BackfillPreview { previewId: string; count: number; limit: number; expiresAt: number }
export interface BackfillBatch { requestId: string; jobIds: string[]; sourceIds: string[] }
export interface ContactMapping { id: string; providerKey: string; siteId: number | null; mailboxIds: number[]; senderAddresses: string[]; domains: string[]; version: number; reason: string; confirmedAt: number }
/** 模型只能引用服务器提供的 sourceId；不得生成内部实体 ID 或展示布尔值。 */
export interface AssessmentEvent { kind: string; evidence: EvidenceRef[] }
export interface AssessmentAction { kind: ObligationKind; title: string; requestedItems: string[]; deadlineRaw: string | null; satisfiesTaskIds: string[]; evidence: EvidenceRef[] }
export interface CompletionSuggestion { taskId: string; evidence: EvidenceRef[] }
export interface AssessmentOutput { schemaVersion: typeof MAIL_TRIAGE_SCHEMA_VERSION; primaryCategory: MailCategory; tag: string; summary: string; caseSuggestion: { providerCandidate: string | null; applicationId: string | null; candidateCaseId: string | null; matchBasis: string[]; needsReview: boolean }; events: AssessmentEvent[]; actions: AssessmentAction[]; completionSuggestions: CompletionSuggestion[]; uncertainties: string[]; requiresHumanReview: boolean }
