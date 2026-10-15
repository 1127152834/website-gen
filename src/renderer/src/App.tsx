import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Globe, KeyRound, Layers, LogOut, Settings, Store, Users, LayoutDashboard, PanelLeftClose, PanelLeftOpen, Sun, Moon, Monitor, Plus } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { AuthUser } from "../../shared/auth.ts";
import { onConnectionStatus, startBackendTransport, stopBackendTransport } from "@/lib/backend.ts";
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
import { OverviewPage } from "./pages/overview.tsx";
import { FeedbackProvider, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { parseRoute, type Page } from "@/lib/routes.ts";

const NAV: { label: string; icon: typeof Store; page: Page; admin?: boolean }[] = [
  { label: "总览", icon: LayoutDashboard, page: "overview" },
  { label: "建站", icon: Store, page: "new" },
  { label: "批次", icon: Layers, page: "batches" },
  { label: "站点", icon: Globe, page: "sites" },
  { label: "账号", icon: KeyRound, page: "accounts" },
  { label: "设置", icon: Settings, page: "settings" },
  { label: "用户管理", icon: Users, page: "users", admin: true },
];

type AuthState = { status: "loading" } | { status: "guest"; error?: string } | { status: "user"; user: AuthUser; epoch: number };

export default function App() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      let value = "system";
      try { value = localStorage.getItem("console-theme") ?? "system"; } catch { /* 禁用存储时仍使用系统主题 */ }
      document.documentElement.classList.toggle("dark", value === "dark" || (value === "system" && media.matches));
      document.documentElement.style.colorScheme = document.documentElement.classList.contains("dark") ? "dark" : "light";
    };
    apply(); media.addEventListener("change", apply); window.addEventListener("console:theme", apply); window.addEventListener("storage", apply);
    return () => { media.removeEventListener("change", apply); window.removeEventListener("console:theme", apply); window.removeEventListener("storage", apply); };
  }, []);
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

  if (auth.status === "loading") return <main className="mx-auto max-w-xl p-8"><Skeleton label="正在读取登录状态" /></main>;
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
    <FeedbackProvider key={`${auth.user.id}:${auth.epoch}`}><WorkspaceShell
      key={`${auth.user.id}:${auth.epoch}`}
      user={auth.user}
      onUserChange={(user) => { authCheck.current++; invalidateApiRequests(); setAuth({ status: "user", user, epoch: auth.epoch + 1 }); }}
      onLogout={() => { authCheck.current++; invalidateApiRequests(); setAuth({ status: "guest" }); }}
    /></FeedbackProvider>
  );
}

function WorkspaceShell({ user, onUserChange, onLogout }: { user: AuthUser; onUserChange: (user: AuthUser) => void; onLogout: () => void }) {
  const [connected, setConnected] = useState(false);
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const navToggle = useRef<HTMLButtonElement>(null);
  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parseRoute(path)); setMobileOpen(false);
    contentRef.current?.scrollTo(0, 0);
  }, []);
  useEffect(() => { const back = () => { setRoute(parseRoute(window.location.pathname)); setMobileOpen(false); }; window.addEventListener("popstate", back); return () => window.removeEventListener("popstate", back); }, []);
  useEffect(() => { document.title = `${NAV.find((item) => item.page === route.page)?.label ?? "页面未找到"} · 独立站 AI 工厂`; }, [route]);
  useEffect(() => onConnectionStatus(setConnected), []);
  useEffect(() => { startBackendTransport(user.id, true); return () => stopBackendTransport(true); }, [user.id]);
  const signOut = async () => {
    try { await logout(); stopBackendTransport(true); onLogout(); }
    catch (error) { if (error instanceof HttpError && error.status === 401) { stopBackendTransport(true); onLogout(); } else toast(`退出失败：${(error as Error).message}`, "error"); }
  };
  const theme = (value: string) => { try { localStorage.setItem("console-theme", value); } catch { /* 只切换本次会话 */ } document.documentElement.classList.toggle("dark", value === "dark" || (value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)); window.dispatchEvent(new Event("console:theme")); };
  const visibleNav = NAV.filter((item) => !item.admin || user.role === "admin");
  const pageTitle = NAV.find((item) => item.page === route.page)?.label ?? "页面未找到";
  const menuItem = "flex cursor-default items-center gap-2 rounded px-3 py-2 text-sm outline-none data-highlighted:bg-accent";
  return <div className="console-shell flex h-dvh min-h-0 bg-background text-foreground">
    <a href="#page-content" className="skip-link">跳到主要内容</a>
    {mobileOpen && <button type="button" aria-label="关闭导航" className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => { setMobileOpen(false); navToggle.current?.focus(); }} />}
    <aside id="console-navigation" className={cn("console-sidebar flex shrink-0 flex-col border-r bg-sidebar p-3", collapsed ? "md:w-[4.5rem]" : "md:w-52", mobileOpen ? "mobile-open" : "")} onKeyDown={(event) => { if (event.key === "Escape") { setMobileOpen(false); navToggle.current?.focus(); } }}>
      <div className="mb-7 flex h-9 items-center gap-2 overflow-hidden px-2"><img src={iconUrl} alt="" className="size-7 shrink-0 rounded-md" /><span className={cn("whitespace-nowrap text-sm font-semibold", collapsed && "md:hidden")}>独立站 AI 工厂</span></div>
      <nav aria-label="主导航" className="flex flex-col gap-1">{visibleNav.map(({ label, icon: Icon, page: target }) => <a key={target} href={target === "overview" ? "/" : `/${target}`} title={collapsed ? label : undefined} aria-current={target === route.page ? "page" : undefined} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(target === "overview" ? "/" : `/${target}`); } }} className={cn("flex min-h-10 items-center gap-3 rounded-md px-3 text-sm", target === route.page ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}><Icon className="size-4 shrink-0" aria-hidden /><span className={collapsed ? "md:sr-only" : ""}>{label}</span></a>)}</nav>
      <div className={cn("mt-auto border-t px-2 pt-4 text-xs text-muted-foreground", collapsed && "md:hidden")}><p>独立工作区 · {user.username}</p><p className="mt-1">仅显示当前用户的业务数据</p></div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b bg-card px-4 md:px-6">
        <Button ref={navToggle} variant="ghost" size="icon" aria-label="切换侧边栏" aria-controls="console-navigation" aria-expanded={window.matchMedia("(min-width: 768px)").matches ? !collapsed : mobileOpen} onClick={() => { if (window.matchMedia("(min-width: 768px)").matches) setCollapsed((v) => !v); else setMobileOpen((v) => !v); }}>{collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}</Button>
        <span className="flex items-center gap-2 text-xs text-muted-foreground"><span className={cn("size-1.5 rounded-full", connected ? "bg-[var(--status-done)]" : "bg-[var(--status-waiting)]")} aria-hidden />{connected ? "后台已连接" : "正在连接后台…"}</span>
        <div className="ml-auto flex items-center gap-1"><Button variant="ghost" size="sm" className="hidden sm:inline-flex" onClick={() => navigate("/new")}><Plus aria-hidden />新建批次</Button>
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="ghost" size="sm" aria-label={`用户菜单：${user.username}`}>{user.username}<ChevronDown aria-hidden /></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="z-40 min-w-48 rounded-lg border bg-popover p-1 shadow-lg"><DropdownMenu.Label className="px-3 py-2 text-xs text-muted-foreground">{user.role === "admin" ? "管理员" : "普通用户"}</DropdownMenu.Label><DropdownMenu.Item className={menuItem} onSelect={() => setPasswordOpen(true)}><KeyRound className="size-4" />修改密码</DropdownMenu.Item>{user.role === "admin" && <DropdownMenu.Item className={menuItem} onSelect={() => navigate("/users")}><Users className="size-4" />用户管理</DropdownMenu.Item>}<DropdownMenu.Separator className="my-1 h-px bg-border" />{([['light', '浅色模式', Sun], ['dark', '深色模式', Moon], ['system', '跟随系统', Monitor]] as const).map(([value, label, Icon]) => <DropdownMenu.Item key={value} className={menuItem} onSelect={() => theme(value)}><Icon className="size-4" />{label}</DropdownMenu.Item>)}<DropdownMenu.Separator className="my-1 h-px bg-border" /><DropdownMenu.Item className={cn(menuItem, "text-destructive")} onSelect={() => void signOut()}><LogOut className="size-4" />退出登录</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </div>
      </header>
      <div ref={contentRef} id="page-content" tabIndex={-1} className="min-h-0 flex-1 overflow-auto px-4 py-5 md:px-8 md:py-7">
        <div className="mx-auto w-full max-w-[1440px]">
          {route.id && route.page !== "sites" && <nav aria-label="面包屑" className="mb-5 flex items-center gap-2 text-sm text-muted-foreground"><a href={`/${route.page}`} className="hover:text-primary" onClick={(event) => { event.preventDefault(); navigate(`/${route.page}`); }}>{pageTitle}</a><span aria-hidden>/</span><span className="text-foreground">#{route.id}</span></nav>}
          {route.page === "overview" && <OverviewPage onNavigate={navigate} />}
          {route.page === "new" && <NewBatchPage onCreated={(id) => navigate(`/batches/${id}`)} userId={user.id} />}
          {route.page === "batches" && <BatchesPage key={route.id ?? "list"} initialBatch={route.id ?? null} onNew={() => navigate("/new")} onNavigate={navigate} />}
          {route.page === "accounts" && <AccountsPage />}
          {route.page === "sites" && <SitesPage siteId={route.id} tab={route.tab} onNavigate={navigate} />}
          {route.page === "settings" && <SettingsPage onPasswordChanged={onUserChange} />}
          {route.page === "users" && (user.role === "admin" ? <UsersPage currentUser={user} /> : <p role="alert">此页面仅限管理员访问。你的业务数据与其他用户隔离。</p>)}
          {route.page === "not-found" && <div className="space-y-4"><h1>页面未找到</h1><p className="text-muted-foreground">地址可能已更改，请从导航进入工作区。</p><Button onClick={() => navigate("/")}>返回总览</Button></div>}
        </div>
      </div>
    </main>
    <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}><DialogContent><DialogHeader><DialogTitle>修改密码</DialogTitle><DialogDescription>修改后，当前设备以外的登录会话都会退出。</DialogDescription></DialogHeader><ChangePasswordForm onCancel={() => setPasswordOpen(false)} onChanged={(changed) => { setPasswordOpen(false); onUserChange(changed); }} /></DialogContent></Dialog>
  </div>;
}