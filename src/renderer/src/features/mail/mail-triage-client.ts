import type { TriageStatus } from "../../../../shared/mail-triage-types.ts";
import { invalidateCurrentTriageViews, useRpcData, type RpcDataResult } from "../../lib/backend.ts";

export type UseRpcDataResult<T> = RpcDataResult<T>;
export type NavigationBadge = { value: number; label: string };

export function useTriageStatus(): UseRpcDataResult<TriageStatus> {
  return useRpcData<TriageStatus>("mail.triage.status", undefined, { topics: ["mail_triage"] });
}

export function invalidateTriageViews(): void {
  invalidateCurrentTriageViews();
}

export function getTriageNavigationBadge(status: TriageStatus | undefined): NavigationBadge | undefined {
  if (!status?.enabled || status.state === "disabled") return undefined;
  return { value: status.needsActionCaseCount, label: "需要处理的申请" };
}
