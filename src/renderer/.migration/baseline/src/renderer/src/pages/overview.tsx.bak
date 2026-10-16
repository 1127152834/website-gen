import { Plus, RefreshCw } from "lucide-react";
import type { Overview } from "../../../backend/overview.ts";
import { useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/page-state";

export function OverviewPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { data, error, loading, refreshing, refresh } = useRpcData<Overview>("overview.get", undefined, { topics: ["batches", "accounts"] });
  return <div className="space-y-8">
    <div className="page-header"><div><h1>总览</h1><p>关注进行中的建站任务，以及需要你决策的事项。</p></div><Button onClick={() => onNavigate("/new")}><Plus aria-hidden />新建批次</Button></div>
    {refreshing && data && <p role="status" className="fixed right-4 bottom-4 text-xs text-muted-foreground">刷新中…</p>}
    {error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive">{error.message}<Button size="sm" variant="outline" onClick={() => void refresh().catch(() => undefined)}><RefreshCw aria-hidden />重新加载</Button></div>}
    {loading ? <Skeleton label="正在加载运营总览" /> : data ? <>
      <dl className="grid grid-cols-2 gap-y-5 border-y py-5 sm:grid-cols-4 lg:grid-cols-7">{([['total','全部站点'],['queued','排队中'],['running','建站中'],['waiting','待外部服务'],['done','已建成'],['failed','失败'],['launched','已上线']] as const).map(([key, label]) => <div key={key} className="px-4 first:pl-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-2 text-2xl font-semibold tabular-nums">{data.counts[key]}</dd></div>)}</dl>
      {data.counts.total === 0 && <EmptyState title="还没有站点" action={<Button variant="outline" onClick={() => onNavigate("/accounts")}>接入 Hostinger 账号</Button>}>先接入账号并同步域名，在设置中配置模型与 CJ 资料，然后创建第一个建站批次。</EmptyState>}
      <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)]">
        <section aria-labelledby="attention-title"><h2 id="attention-title" className="section-title">待你操作 <span className="status-waiting ml-2 rounded px-2 py-0.5 text-xs tabular-nums">{data.attention.length}</span></h2>{data.attention.length ? <ul className="divide-y">{data.attention.map((site) => <li key={site.siteId} className="flex flex-wrap items-start justify-between gap-3 py-4"><div className="min-w-0"><button type="button" onClick={() => onNavigate(`/sites/${site.siteId}/${site.tab}`)} className="text-left font-medium text-primary hover:underline">{site.domain}</button><ul className="mt-2 space-y-1 text-sm text-muted-foreground">{site.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div><Button size="sm" variant="outline" onClick={() => onNavigate(`/sites/${site.siteId}/${site.tab}`)}>{site.tab === "qa" ? "查看复核报告" : site.tab === "mail" ? "去配置邮箱" : "去处理"}</Button></li>)}</ul> : <p className="py-6 text-sm text-muted-foreground">暂无待处理事项。新的 QA 问题和失败任务会出现在这里。</p>}</section>
        <section aria-labelledby="expiry-title"><h2 id="expiry-title" className="section-title">30 天内到期的域名</h2>{data.expiringDomains.length ? <ul className="divide-y">{data.expiringDomains.map((domain) => <li key={`${domain.accountId}:${domain.domain}`} className="flex justify-between gap-4 py-4 text-sm"><div><p className="break-all font-medium">{domain.domain}</p><p className="mt-1 text-muted-foreground">{domain.accountLabel} · {new Date(domain.expiresAt).toLocaleDateString("zh-CN")}</p></div><span className="shrink-0 text-[var(--status-waiting)] tabular-nums">{domain.daysLeft} 天</span></li>)}</ul> : <p className="py-6 text-sm text-muted-foreground">暂无即将到期的域名。接入账号后会按同步快照提醒。</p>}</section>
      </div>
      <section aria-labelledby="running-title"><h2 id="running-title" className="section-title">进行中批次</h2>{data.runningBatches.length ? <ul className="divide-y">{data.runningBatches.map((batch) => <li key={batch.id}><button type="button" className="flex w-full flex-wrap items-center justify-between gap-3 py-4 text-left hover:text-primary" onClick={() => onNavigate(`/batches/${batch.id}`)}><span className="font-medium">批次 #{batch.id}</span><span className="text-sm text-muted-foreground tabular-nums">{batch.done}/{batch.total} 已完成 · {batch.active} 个进行中{batch.failed > 0 ? ` · ${batch.failed} 个失败` : ''}</span></button></li>)}</ul> : <p className="py-6 text-sm text-muted-foreground">暂无进行中的批次。创建批次后可以在这里跟进。</p>}</section>
    </> : null}
  </div>;
}
