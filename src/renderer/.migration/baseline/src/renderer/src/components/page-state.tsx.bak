import type { ReactNode } from "react";

export function Skeleton({ label = "正在加载" }: { label?: string }) {
  return <div role="status" aria-label={label} className="space-y-4 py-4 motion-safe:animate-pulse"><span className="sr-only">{label}</span><div className="h-6 w-40 rounded bg-muted" /><div className="h-24 rounded-lg bg-muted" /><div className="h-12 rounded bg-muted" /></div>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="rounded-lg border border-dashed px-6 py-10 text-sm"><h2 className="font-medium">{title}</h2><div className="mt-2 max-w-prose text-muted-foreground">{children}</div>{action && <div className="mt-5">{action}</div>}</div>;
}
