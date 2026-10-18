import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const MAIL_NAV_ITEMS = [
  { to: "/mail", label: "申请看板" },
  { to: "/mail/inbox", label: "按邮箱" },
  { to: "/mail/review", label: "邮件核对" },
  { to: "/mail/notifications", label: "通知邮件" },
  { to: "/mail/reminders", label: "本地跟进提醒" },
  { to: "/mail/settings", label: "预审设置" },
  { to: "/mail/manage", label: "邮箱管理" },
] as const;

/** Shared, stateless mail route shell. Individual pages retain their own controllers. */
export function MailLayout(): ReactNode {
  const pathname = useRouterState({ select: state => state.location.pathname });
  return <div className="min-w-0 space-y-5">
    <nav aria-label="邮件模块" className="flex max-w-full flex-wrap gap-2 rounded-xl border bg-card p-2">
      {MAIL_NAV_ITEMS.map(item => {
        const current = item.to === "/mail" ? pathname === item.to || pathname.startsWith("/mail/cases/") : pathname === item.to || pathname.startsWith(`${item.to}/`);
        return <Link key={item.to} to={item.to} aria-current={current ? "page" : undefined} className={`inline-flex min-h-9 items-center rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{item.label}</Link>;
      })}
    </nav>
    <Outlet />
  </div>;
}
