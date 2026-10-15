import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, KeyRound, Layers, LogOut, Settings, Store, Users } from "lucide-react";
import type { AuthUser } from "../../shared/auth.ts";
import { call, onConnect, onConnectionStatus, startBackendTransport, stopBackendTransport } from "@/lib/backend.ts";
import { AUTH_SYNC_KEY, getCurrentUser, HttpError, invalidateApiRequests, logout } from "@/lib/auth.ts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import iconUrl from "../../../resources/icon.png";
import { AccountsPage } from "./pages/accounts.tsx";
import { BatchesPage } from "./pages/batches.tsx";
import { ChangePasswordForm, ForcedChangePasswordPage } from "./pages/change-password.tsx";
import { LoginPage } from "./pages/login.tsx";
import { NewBatchPage } from "./pages/new-batch.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { SitesPage } from "./pages/sites.tsx";
import { UsersPage } from "./pages/users.tsx";

interface SystemInfo {
  node: string;
  sqlite: string;
  schemaVersion: number;
}

type Page = "new" | "batches" | "sites" | "accounts" | "settings" | "users";
const NAV: { label: string; icon: typeof Store; page: Page; admin?: boolean }[] = [
  { label: "建站", icon: Store, page: "new" },
  { label: "批次", icon: Layers, page: "batches" },
  { label: "站点", icon: Globe, page: "sites" },
  { label: "账号", icon: KeyRound, page: "accounts" },
  { label: "设置", icon: Settings, page: "settings" },
  { label: "用户管理", icon: Users, page: "users", admin: true },
];

type AuthState = { status: "loading" } | { status: "guest"; error?: string } | { status: "user"; user: AuthUser; epoch: number };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const authRef = useRef(auth);
  const authCheck = useRef(0);
  authRef.current = auth;

  const refreshSession = useCallback(async (suspend = false) => {
    const check = ++authCheck.current;
    const previous = authRef.current;
    if (suspend) {
      invalidateApiRequests();
      stopBackendTransport(true);
      setAuth({ status: "loading" });
    }
    try {
      const user = await getCurrentUser();
      if (check !== authCheck.current) return;
      const current = authRef.current;
      if (!suspend && current.status === "user" && current.user.id === user.id && current.user.username === user.username && current.user.role === user.role && current.user.mustChangePassword === user.mustChangePassword) return;
      if (!suspend && current.status === "user") invalidateApiRequests();
      stopBackendTransport(true);
      setAuth({ status: "user", user, epoch: previous.status === "user" ? previous.epoch + 1 : Date.now() });
    } catch (error) {
      if (check !== authCheck.current) return;
      if (error instanceof HttpError && error.status === 401) {
        stopBackendTransport(true);
        setAuth({ status: "guest" });
      } else if (suspend || authRef.current.status === "loading") {
        setAuth({ status: "guest", error: `无法连接服务：${(error as Error).message}` });
      }
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    return () => { authCheck.current++; };
  }, [refreshSession]);

  useEffect(() => {
    const listener = (event: Event) => {
      const problem = (event as CustomEvent<"unauthenticated" | "password_required" | "identity_changed">).detail;
      if (problem === "identity_changed") {
        void refreshSession(true);
        return;
      }
      authCheck.current++;
      invalidateApiRequests();
      stopBackendTransport();
      setAuth((current) => {
        if (problem === "password_required" && current.status === "user") {
          return { status: "user", user: { ...current.user, mustChangePassword: true }, epoch: current.epoch + 1 };
        }
        return { status: "guest" };
      });
    };
    window.addEventListener("website-gen:auth", listener);
    return () => window.removeEventListener("website-gen:auth", listener);
  }, [refreshSession]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SYNC_KEY) void refreshSession(true);
    };
    // 普通聚焦只核对身份；同一用户不卸载工作区，避免丢失尚未提交的表单。
    const onFocus = () => void refreshSession();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshSession]);

  if (auth.status === "loading") return <main className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">正在读取登录状态…</main>;
  if (auth.status === "guest") {
    return (
      <>
        {auth.error && <p role="alert" className="fixed inset-x-0 top-4 z-10 mx-auto w-fit rounded-md border bg-background px-4 py-2 text-sm text-destructive shadow-sm">{auth.error}</p>}
        <LoginPage onLogin={(user) => { authCheck.current++; invalidateApiRequests(); stopBackendTransport(true); setAuth({ status: "user", user, epoch: Date.now() }); }} />
      </>
    );
  }
  if (auth.user.mustChangePassword) {
    return <ForcedChangePasswordPage username={auth.user.username} onChanged={(user) => { authCheck.current++; invalidateApiRequests(); setAuth({ status: "user", user, epoch: auth.epoch + 1 }); }} />;
  }

  return (
    <WorkspaceShell
      key={`${auth.user.id}:${auth.epoch}`}
      user={auth.user}
      onUserChange={(user) => { authCheck.current++; invalidateApiRequests(); setAuth({ status: "user", user, epoch: auth.epoch + 1 }); }}
      onLogout={() => { authCheck.current++; invalidateApiRequests(); setAuth({ status: "guest" }); }}
    />
  );
}

function WorkspaceShell({ user, onUserChange, onLogout }: { user: AuthUser; onUserChange: (user: AuthUser) => void; onLogout: () => void }) {
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [page, setPage] = useState<Page>("batches");
  const [openBatch, setOpenBatch] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => onConnectionStatus(setConnected), []);
  useEffect(() => onConnect(() => call<SystemInfo>("system.info").then(setInfo, () => setInfo(null))), []);
  useEffect(() => {
    startBackendTransport(user.id, true);
    return () => stopBackendTransport(true);
  }, []);

  const signOut = async () => {
    setMenuOpen(false);
    setSessionError(null);
    try {
      await logout();
      stopBackendTransport(true);
      onLogout();
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        stopBackendTransport(true);
        onLogout();
      } else {
        setSessionError(`退出失败：${(error as Error).message}`);
      }
    }
  };

  const visibleNav = NAV.filter((item) => !item.admin || user.role === "admin");
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="flex w-48 shrink-0 flex-col border-r bg-sidebar px-3 py-4">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src={iconUrl} alt="" className="size-6 rounded-md" />
          <span className="font-semibold">独立站 AI 工厂</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {visibleNav.map(({ label, icon: Icon, page: target }) => (
            <button
              key={label}
              type="button"
              aria-current={target === page ? "page" : undefined}
              onClick={() => setPage(target)}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                target === page ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
              )}
            >
              <Icon className="size-4" aria-hidden />{label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 flex-wrap items-center gap-x-6 gap-y-1 border-b px-6 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium">
            <span className={cn("size-2 rounded-full", connected ? "bg-green-500" : "bg-amber-500")} aria-hidden />
            {connected ? "后台已连接" : "正在连接后台…"}
          </span>
          {info && (
            <dl className="flex flex-wrap gap-x-5 text-muted-foreground tabular-nums">
              <div className="flex gap-1.5"><dt>Node</dt><dd className="text-foreground">{info.node}</dd></div>
              <div className="flex gap-1.5"><dt>SQLite</dt><dd className="text-foreground">{info.sqlite}</dd></div>
              <div className="flex gap-1.5"><dt>数据库版本</dt><dd className="text-foreground">{info.schemaVersion}</dd></div>
            </dl>
          )}
          {sessionError && <span role="alert" className="text-destructive">{sessionError}</span>}
          <div className="relative ml-auto" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
            <Button type="button" variant="ghost" size="sm" aria-label={`用户菜单：${user.username}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              {user.username}<ChevronDown aria-hidden />
            </Button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                <p className="px-2 py-1.5 text-xs text-muted-foreground">{user.role === "admin" ? "管理员" : "普通用户"}</p>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => { setMenuOpen(false); setPasswordOpen(true); }}><KeyRound className="size-4" aria-hidden />修改密码</button>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-destructive hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => void signOut()}><LogOut className="size-4" aria-hidden />退出登录</button>
              </div>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto p-6">
          {page === "new" && <NewBatchPage onCreated={(id) => { setOpenBatch(id); setPage("batches"); }} />}
          {page === "batches" && <BatchesPage key={openBatch} initialBatch={openBatch} onNew={() => setPage("new")} />}
          {page === "accounts" && <AccountsPage />}
          {page === "sites" && <SitesPage />}
          {page === "settings" && <SettingsPage />}
          {page === "users" && user.role === "admin" && <UsersPage currentUser={user} />}
        </div>
      </main>

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>修改密码</DialogTitle><DialogDescription>修改后，当前设备以外的登录会话都会退出。</DialogDescription></DialogHeader>
          <ChangePasswordForm onCancel={() => setPasswordOpen(false)} onChanged={(changed) => { setPasswordOpen(false); onUserChange(changed); }} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
