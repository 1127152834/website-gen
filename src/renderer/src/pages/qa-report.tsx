import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, ExternalLink, Image as ImageIcon } from "lucide-react";
import type { QaView, ReviewIssue } from "../../../shared/protocol.ts";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const SHOT_TEXT: Record<string, string> = {
  home: "首页", shop: "商品列表", product: "商品页", contact: "联系页", cart: "购物车", checkout: "结账页", "home-mobile": "首页（手机）",
};

const STATUS_TEXT: Record<ReviewIssue["status"], string> = { fixed: "已修复", open: "待处理", needs_you: "待你补充" };
const KIND_ORDER: ReviewIssue["kind"][] = ["config", "policy", "product", "copy", "visual", "seo", "other"];
const KIND_TEXT: Record<ReviewIssue["kind"], string> = {
  config: "一致性与完整性",
  policy: "政策与法律一致性",
  product: "商品与合规",
  copy: "业务真实性与声明",
  visual: "品牌与视觉",
  seo: "搜索与元数据",
  other: "其他",
};

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

const safeImage = (value: string | undefined): string | null => value && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value) ? value : null;

function IssueCard({ issue, onZoom }: { issue: ReviewIssue; onZoom: (shot: string, title: string) => void }) {
  const url = safeHttpUrl(issue.url);
  const shot = safeImage(issue.shot);
  return (
    <article className="relative py-3 pl-5">
      <span className={cn("absolute top-5 left-0 size-2 rounded-full", issue.status === "needs_you" ? "bg-amber-500" : issue.status === "open" ? "bg-destructive" : "bg-emerald-500")} aria-hidden />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{issue.page}</p>
          {url ? <a href={url} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 break-all text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{url}<ExternalLink className="size-3 shrink-0" aria-hidden /></a> : issue.url && <p className="mt-0.5 break-all text-xs text-muted-foreground">{issue.url}</p>}
        </div>
        <Badge variant={issue.status === "open" ? "destructive" : issue.status === "needs_you" ? "outline" : "secondary"} className={cn(issue.status === "needs_you" && "border-amber-500/60 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300")}>{STATUS_TEXT[issue.status]}</Badge>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">证据</dt><dd className="whitespace-pre-wrap break-words">{issue.evidence}</dd>
        <dt className="text-muted-foreground">为什么</dt><dd className="whitespace-pre-wrap break-words">{issue.why}</dd>
        <dt className="text-muted-foreground">处理办法</dt><dd className="whitespace-pre-wrap break-words">{issue.fix}</dd>
      </dl>
      {shot && (
        <button type="button" className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onZoom(shot, `${issue.page} 的问题截图`)}>
          <ImageIcon className="size-3.5" aria-hidden />查看问题截图
        </button>
      )}
    </article>
  );
}

export function QaReport({ qa }: { qa: QaView | null }) {
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null);
  const groups = useMemo(() => ({
    P1: qa?.review?.issues.filter((issue) => issue.level === "P1") ?? [],
    P2: qa?.review?.issues.filter((issue) => issue.level === "P2") ?? [],
    P3: qa?.review?.issues.filter((issue) => issue.level === "P3") ?? [],
  }), [qa]);
  const needsYou = qa?.review?.issues.filter((issue) => issue.status === "needs_you") ?? [];

  if (!qa) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm">
        <p className="font-medium">还没有复核报告</p>
        <p className="mt-1 text-muted-foreground">建站流程运行到 QA 后，这里会显示商户网站规则检查、AI 复核和页面截图。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div>
          <h2 className="font-semibold">复核报告</h2>
          <p className="mt-1 text-sm text-muted-foreground tabular-nums">{new Date(qa.at).toLocaleString("zh-CN", { hour12: false })}</p>
        </div>
        {qa.review && <Badge variant={qa.review.passed ? "secondary" : "destructive"}>{qa.review.passed ? "复核通过" : "仍需处理"} · {qa.review.rounds} 轮修复</Badge>}
      </header>

      {needsYou.length > 0 && (
        <section aria-labelledby="needs-you-title" className="rounded-lg border border-amber-500/50 bg-amber-50/70 p-4 dark:bg-amber-950/20">
          <h3 id="needs-you-title" className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200"><CircleAlert className="size-4" aria-hidden />待你补充（{needsYou.length}）</h3>
          <p className="mt-1 text-sm text-amber-800/90 dark:text-amber-300">这些项目需要真实资料，系统不会猜。补齐后再运行复核。</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-900 dark:text-amber-200">
            {needsYou.map((issue) => <li key={issue.id}><span className="font-medium">{issue.page}：</span>{issue.fix}</li>)}
          </ul>
        </section>
      )}

      <section aria-labelledby="rules-title">
        <h3 id="rules-title" className="text-sm font-medium">规则检查</h3>
        <ul className="mt-3 grid gap-x-6 gap-y-3 md:grid-cols-2">
          {qa.checks.map((check) => (
            <li key={check.id} className="flex gap-2 text-sm">
              {check.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="通过" /> : <CircleAlert className={cn("mt-0.5 size-4 shrink-0", check.level === "block" ? "text-destructive" : "text-amber-600 dark:text-amber-400")} aria-label={check.level === "block" ? "没通过" : "提醒"} />}
              <div className="min-w-0"><p className="font-medium">{check.name}</p><p className={cn("mt-0.5 break-words text-xs", check.ok ? "text-muted-foreground" : check.level === "block" ? "text-destructive" : "text-amber-700 dark:text-amber-400")}>{check.detail}</p></div>
            </li>
          ))}
        </ul>
      </section>

      {qa.review ? (
        <section aria-labelledby="review-title">
          <h3 id="review-title" className="text-sm font-medium">商户网站审核（规则与 AI）</h3>
          <div className="mt-2 divide-y">
            {(["P1", "P2", "P3"] as const).map((level) => (
              <section key={level} aria-labelledby={`review-${level}`} className="py-4 first:pt-2">
                <div className="flex items-center gap-2"><h4 id={`review-${level}`} className="font-semibold tabular-nums">{level}</h4><span className="text-xs text-muted-foreground">{level === "P1" ? "阻断上线" : level === "P2" ? "应该修复" : "优化建议"} · {groups[level].length}</span></div>
                {groups[level].length === 0 ? <p className="mt-2 text-sm text-muted-foreground">没有 {level} 问题。</p> : (
                  <div className="mt-3 space-y-4">
                    {KIND_ORDER.map((kind) => {
                      const issues = groups[level].filter((issue) => issue.kind === kind);
                      return issues.length > 0 && (
                        <section key={`${level}-${kind}`} aria-labelledby={`review-${level}-${kind}`} className="rounded-lg border px-4 py-3">
                          <div className="flex items-center justify-between gap-2 border-b pb-2">
                            <h5 id={`review-${level}-${kind}`} className="text-sm font-medium">{KIND_TEXT[kind]}</h5>
                            <span className="text-xs text-muted-foreground tabular-nums">{issues.length}</span>
                          </div>
                          <div className="divide-y">{issues.map((issue) => <IssueCard key={issue.id} issue={issue} onZoom={(src, title) => setZoom({ src, title })} />)}</div>
                        </section>
                      );
                    })}
                  </div>
                )}
              </section>
            ))}
          </div>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed p-5 text-sm"><p className="font-medium">旧版 QA 报告</p><p className="mt-1 text-muted-foreground">这个报告生成时还没有 AI 整站复核，规则检查和截图仍然有效。</p></section>
      )}

      {qa.shots.length > 0 && (
        <section aria-labelledby="shots-title">
          <h3 id="shots-title" className="text-sm font-medium">页面截图</h3>
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {qa.shots.filter((shot) => safeImage(shot.src)).map((shot) => (
              <li key={shot.name}><button type="button" className="w-full overflow-hidden rounded-lg border bg-card text-left outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setZoom({ src: shot.src, title: SHOT_TEXT[shot.name] ?? shot.name })}><img src={shot.src} alt={`${SHOT_TEXT[shot.name] ?? shot.name}截图`} className="aspect-[4/3] w-full object-cover object-top" /><span className="block border-t px-3 py-2 text-xs font-medium">{SHOT_TEXT[shot.name] ?? shot.name}</span></button></li>
            ))}
          </ul>
        </section>
      )}

      <Dialog open={zoom !== null} onOpenChange={(open) => !open && setZoom(null)}>
        <DialogContent className="max-h-[92vh] overflow-auto sm:max-w-5xl"><DialogHeader><DialogTitle>{zoom?.title}</DialogTitle></DialogHeader>{zoom && <img src={zoom.src} alt="" className="w-full rounded-md border" />}</DialogContent>
      </Dialog>
    </div>
  );
}
