// Adapted from shadcn-admin AppSidebar/NavGroup/NavUser (MIT).
import { Factory } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail } from '@/components/ui/sidebar';
import { ProfileDropdown } from '@/components/profile-dropdown';
import { useSession } from '@/hooks/use-session';
import { useRpcData } from '@/lib/backend';
import { navGroups } from './navigation';
import { NavGroup } from './nav-group';
export function AppSidebar(){
  const {user}=useSession();
  const {data}=useRpcData<{unreadCount:number}[]|{unread:number}>('mail.list',undefined,{topics:['mail']});
  const unread=Array.isArray(data)?data.reduce((sum,m)=>sum+(m.unreadCount??0),0):data?.unread??0;
  return <Sidebar collapsible="icon" variant="inset"><SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" asChild><Link to="/"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Factory className="size-4" aria-hidden/></span><span className="grid text-left text-sm leading-tight"><span className="font-semibold">独立站 AI 工厂</span><span className="text-xs text-muted-foreground">建站与运营工作台</span></span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader><SidebarContent><nav aria-label="主导航">{navGroups.map(group=><NavGroup key={group.title} title={group.title} items={group.items.filter(item=>!item.admin||user?.role==='admin')} unread={unread}/>)}</nav></SidebarContent><SidebarFooter><ProfileDropdown sidebar/></SidebarFooter><SidebarRail/></Sidebar>;
}
