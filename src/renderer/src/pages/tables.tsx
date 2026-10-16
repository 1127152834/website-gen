import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/page-state";
import { gristLoginUrl, openGristLogin, watchGristPopupClosed } from "./grist-iframe.ts";
import type { GristSettings } from "./grist-settings-helpers.ts";

const GRIST_TOPICS = ["grist"] as const;

export function TablesPage({ onNavigate }: { onNavigate: (path: string) => void }) {
  const settingsState = useRpcData<GristSettings>("grist.settings.get", undefined, { topics: GRIST_TOPICS });
  const baseUrl = settingsState.data?.baseUrl.trim() ?? "";
  const [iframeRevision, setIframeRevision] = useState(0);
  const popupPollCleanup = useRef<(() => void) | null>(null);

  const stopPopupPoll = useCallback(() => {
    popupPollCleanup.current?.();
    popupPollCleanup.current = null;
  }, []);

  useEffect(() => stopPopupPoll, [baseUrl, stopPopupPoll]);

  const reloadIframe = useCallback(() => setIframeRevision((revision) => revision + 1), []);
  const login = () => {
    stopPopupPoll();
    const popup = openGristLogin(gristLoginUrl(baseUrl), (url, target, features) => window.open(url, target, features));
    if (!popup) return;
    popupPollCleanup.current = watchGristPopupClosed(popup, () => {
      popupPollCleanup.current = null;
      reloadIframe();
    }, { setInterval, clearInterval });
  };

  if (settingsState.loading) {
    return <div className="p-4 md:p-6"><Skeleton label="正在读取 Grist 连接" /></div>;
  }

  if (settingsState.error) {
    return <div className="p-4 md:p-6"><div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><span>{settingsState.error.message}</span><Button variant="outline" size="sm" onClick={() => void settingsState.refresh()}>重试</Button></div></div>;
  }

  if (!baseUrl) {
    return <div className="p-4 md:p-6"><EmptyState title="还没有配置 Grist 地址" action={<Button onClick={() => onNavigate("/settings")}>前往设置 Grist</Button>}>在设置中保存 Grist 地址后，即可在这里直接打开完整的 Grist 表格界面。</EmptyState></div>;
  }

  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <div className="shrink-0 border-b bg-card px-3 py-3 md:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button size="sm" onClick={login}><LogIn aria-hidden />登录 Grist</Button>
        <Button size="sm" variant="outline" onClick={reloadIframe}><RefreshCw aria-hidden />刷新</Button>
        <a className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={baseUrl} target="_blank" rel="noopener noreferrer">在新标签页打开<ExternalLink className="size-3.5" aria-hidden /><span className="sr-only">（新标签页）</span></a>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">如果下面显示拒绝连接或登录页，先点「登录 Grist」在弹窗里登录，登录后关闭弹窗即可。</p>
    </div>
    <iframe
      key={`${baseUrl}:${iframeRevision}`}
      className="min-h-0 min-w-0 w-full flex-1 border-0 bg-background"
      src={baseUrl}
      title="Grist 表格"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  </div>;
}
