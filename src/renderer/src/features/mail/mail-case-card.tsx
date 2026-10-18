import { Clock3, Mail, ShieldAlert } from "lucide-react";
import type { CaseSummary } from "../../../../shared/mail-triage-types.ts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const time = (value: number | null) => value == null ? "暂无有效进展时间" : new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function MailCaseCard({ item, onOpen }: { item: CaseSummary; onOpen: (id: string) => void }) {
  const title = item.siteLabel ?? item.applicationId ?? item.provider ?? "待确认申请";
  return <button type="button" onClick={() => onOpen(item.caseId)} className="w-full rounded-xl border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`打开申请 ${title}`}>
    <span className="flex items-start justify-between gap-3">
      <span className="min-w-0">
        <strong className="block truncate text-base font-semibold tracking-[-0.015em]">{title}</strong>
        <span className="mt-1 block truncate text-sm text-muted-foreground">{item.provider ?? "平台待确认"}{item.applicationId ? ` · ${item.applicationId}` : ""}</span>
      </span>
      {item.identityState === "unconfirmed_case" ? <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"><ShieldAlert className="size-3.5" />待确认</span> : null}
    </span>
    <span className="mt-3 flex flex-wrap items-center gap-2">
      <Badge variant={item.column === "needs_you" ? "destructive" : item.column === "awaiting_platform" ? "secondary" : "outline"}>{item.tag}</Badge>
      {item.openTaskCount > 0 ? <Badge variant="outline">{item.openTaskCount} 项待办</Badge> : null}
    </span>
    <span className={cn("mt-3 block text-sm leading-6", item.nextStep ? "text-foreground" : "text-muted-foreground")}>{item.nextStep ?? item.latestValidSummary ?? "暂无已验证的下一步"}</span>
    <span className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5"><Mail className="size-3.5 shrink-0" /><span className="truncate">{item.mailboxCount > 1 ? `${item.mailboxCount} 个邮箱` : item.mailboxAddress ?? "来源邮箱不可用"}</span></span>
      <span className="inline-flex shrink-0 items-center gap-1.5"><Clock3 className="size-3.5" />{time(item.latestValidAt)}</span>
    </span>
  </button>;
}
