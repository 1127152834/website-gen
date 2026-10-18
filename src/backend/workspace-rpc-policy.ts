import { assistantRpcToolByMethod } from "./assistant-tools.ts";

export type WorkspaceRpcRisk = "read" | "write" | "confirm";

const TRIAGE_RPC_RISK: Readonly<Record<string, WorkspaceRpcRisk>> = Object.freeze({
  "mail.triage.settings": "read",
  "mail.triage.status": "read",
  "mail.triage.result": "read",
  "mail.cases.list": "read",
  "mail.cases.detail": "read",
  "mail.cases.sourceMessage": "read",
  "mail.triage.reviewQueue": "read",
  "mail.triage.messageAnnotations": "read",
  "mail.triage.sourcePreview": "read",
  "mail.triage.evaluationStatus": "read",
  "mail.triage.saveEvaluationReport": "confirm",
  "mail.triage.approveNotificationRouting": "confirm",
  "mail.triage.auditOutcome": "confirm",
  "mail.triage.configure": "confirm",
  "mail.triage.backfillPreview": "read",
  "mail.triage.enqueue": "confirm",
  "mail.triage.retry": "confirm",
  "mail.triage.cancel": "confirm",
  "mail.triage.contacts.list": "read",
  "mail.triage.contacts.save": "confirm",
  "mail.triage.contacts.remove": "confirm",
  "mail.triage.correct": "confirm",
  "mail.cases.link": "confirm",
  "mail.cases.split": "confirm",
  "mail.cases.confirm": "confirm",
  "mail.cases.independentFact": "confirm",
  "mail.cases.appeal": "confirm",
  "mail.triage.undo": "confirm",
  "mail.tasks.recordOutcome": "confirm",
});

/** 未知方法返回 undefined，由工作区 guard 以 undefined !== read 拒绝。 */
export function workspaceRpcRisk(method: string): WorkspaceRpcRisk | undefined {
  return TRIAGE_RPC_RISK[method] ?? assistantRpcToolByMethod(method)?.risk;
}
