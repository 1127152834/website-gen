// Adapted from shadcn-admin AuthenticatedLayout (MIT).
import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { SkipToMain } from '@/components/skip-to-main';
import { CommandMenu, SearchProvider } from '@/components/search';
import { GlobalAssistant } from '@/components/global-assistant';
import { onMail } from '@/lib/backend';
import { toast } from '@/components/feedback';
import { useSession } from '@/hooks/use-session';
import { AppSidebar } from './app-sidebar';
import { Header } from './header';
import { Main } from './main';
import { pageTitle } from './navigation';
export function AuthenticatedLayout(){
  const {epoch}=useSession();const navigate=useNavigate();const location=useLocation();
  useEffect(()=>{document.title=`${pageTitle(location.pathname)} · 独立站 AI 工厂`;},[location.pathname]);
  useEffect(()=>onMail(event=>{if(event.type==='new')toast('收到新邮件');}),[]);
  let defaultOpen=true;try{defaultOpen=document.cookie.split('; ').find(c=>c.startsWith('sidebar_state='))!=='sidebar_state=false';}catch{/* default expanded */}
  return <SearchProvider key={epoch}><SidebarProvider defaultOpen={defaultOpen}><SkipToMain/><AppSidebar/><SidebarInset className="min-w-0"><Header/><Main><Outlet/></Main></SidebarInset><CommandMenu/><GlobalAssistant onNavigate={path=>void navigate({to:path})}/></SidebarProvider></SearchProvider>;
}
