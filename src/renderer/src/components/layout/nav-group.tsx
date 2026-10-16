// Adapted from shadcn-admin (MIT), see renderer/THIRD_PARTY_NOTICES.
import { Link, useLocation } from '@tanstack/react-router';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import type { NavItem } from './navigation';
export function NavGroup({title,items,unread=0}:{title:string;items:NavItem[];unread?:number}){
  const pathname=useLocation({select:l=>l.pathname});
  const {setOpenMobile}=useSidebar();
  return <SidebarGroup><SidebarGroupLabel>{title}</SidebarGroupLabel><SidebarMenu>{items.map(item=><SidebarMenuItem key={item.url}><SidebarMenuButton asChild tooltip={item.title} isActive={item.url==='/'?pathname==='/':pathname===item.url||pathname.startsWith(item.url+'/')}><Link to={item.url} activeOptions={{exact:item.url==="/"}} onClick={()=>setOpenMobile(false)}><item.icon aria-hidden/><span>{item.title}</span>{item.url==='/mail' && unread>0 && <span className="ml-auto rounded-md bg-primary px-1.5 text-xs tabular-nums text-primary-foreground group-data-[collapsible=icon]:hidden" aria-label={`${unread} 封未读邮件`}>{unread>99?'99+':unread}</span>}</Link></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>;
}
