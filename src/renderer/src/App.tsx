import { useEffect, useState } from "react";
import { Globe, KeyRound, Layers, Settings, Store } from "lucide-react";
import { call, onConnect } from "@/lib/backend.ts";
import { cn } from "@/lib/utils";
import iconUrl from "../../../resources/icon.png";
import { NewBatchPage } from "./pages/new-batch.tsx";
import { BatchesPage } from "./pages/batches.tsx";
import { AccountsPage } from "./pages/accounts.tsx";
import { SettingsPage } from "./pages/settings.tsx";

interface SystemInfo {
  electron: string;
  node: string;
  sqlite: string;
  dbPath: string;
  schemaVersion: number;
}

type Page = "new" | "batches" | "accounts" | "settings";
const NAV: { label: string; icon: typeof Store; page?: Page }[] = [
  { label: "建站", icon: Store, page: "new" },
  { label: "批次", icon: Layers, page: "batches" },
  { label: "站点", icon: Globe },
  { label: "账号", icon: KeyRound, page: "accounts" },
  { label: "设置", icon: Settings, page: "settings" },
];

export default function App() {
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [page, setPage] = useState<Page>("batches");
  const [openBatch, setOpenBatch] = useState<number | null>(null);

  useEffect(
    () =>
      onConnect(() => {
        setConnected(true);
        call<SystemInfo>("system.info").then(setInfo, () => setInfo(null));
      }),
    [],
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-48 shrink-0 flex-col border-r bg-sidebar px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src={iconUrl} alt="" className="size-6 rounded-md" />
          <span className="font-semibold">独立站 AI 工厂</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map(({ label, icon: Icon, page: target }) => (
            <button
              key={label}
              type="button"
              disabled={!target}
              title={target ? undefined : "开发中"}
              aria-current={target === page ? "page" : undefined}
              onClick={() => target && setPage(target)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                target === page && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                target && target !== page && "hover:bg-sidebar-accent/60",
                !target && "text-muted-foreground disabled:cursor-not-allowed",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b px-6 py-2.5 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <span className={cn("size-2 rounded-full", connected ? "bg-green-500" : "bg-amber-500")} aria-hidden />
            {connected ? "后台已连接" : "正在连接后台…"}
          </span>
          {info && (
            <dl className="flex flex-wrap gap-x-5 text-muted-foreground tabular-nums">
              <div className="flex gap-1.5"><dt>Electron</dt><dd className="text-foreground">{info.electron}</dd></div>
              <div className="flex gap-1.5"><dt>Node</dt><dd className="text-foreground">{info.node}</dd></div>
              <div className="flex gap-1.5"><dt>SQLite</dt><dd className="text-foreground">{info.sqlite}</dd></div>
              <div className="flex gap-1.5"><dt>数据库版本</dt><dd className="text-foreground">{info.schemaVersion}</dd></div>
            </dl>
          )}
        </header>

        <div className="flex-1 overflow-auto p-6">
          {page === "new" && <NewBatchPage onCreated={(id) => { setOpenBatch(id); setPage("batches"); }} />}
          {page === "batches" && <BatchesPage key={openBatch} initialBatch={openBatch} onNew={() => setPage("new")} />}
          {page === "accounts" && <AccountsPage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
    </div>
  );
}
