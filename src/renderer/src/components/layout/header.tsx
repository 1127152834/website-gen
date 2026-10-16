// Adapted from shadcn-admin Header/TopNav (MIT).
import { useEffect, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { onConnectionStatus } from '@/lib/backend';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { ThemeSwitch } from '@/components/theme-switch';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { Search } from '@/components/search';
import { pageTitle } from './navigation';
export function Header(){const [connected,setConnected]=useState(false);const pathname=useLocation({select:l=>l.pathname});useEffect(()=>onConnectionStatus(setConnected),[]);return <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6"><SidebarTrigger variant="outline" aria-label="切换侧边栏"/><Separator orientation="vertical" className="h-5"/><span className="hidden text-sm font-medium lg:block">{pageTitle(pathname)}</span><div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-3"><span role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={`size-1.5 shrink-0 rounded-full ${connected?'bg-emerald-500':'bg-amber-500'}`} aria-hidden/><span>{connected?'后台已连接':'正在连接后台…'}</span></span><Search/><ThemeSwitch/><ProfileDropdown/></div></header>;}
