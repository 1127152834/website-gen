// Adapted from shadcn-admin (MIT), see renderer/THIRD_PARTY_NOTICES.
import { Link, useLocation } from '@tanstack/react-router';
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import type { NavItem } from './navigation';
type NavBadge={value:number;label:string};
export function NavGroup({title,items,badge}:{title:string;items:NavItem[];badge?:NavBadge}){
  const pathname=useLocation({select:l=>l.pathname});
  const {setOpenMobile}=useSidebar();
  return <SidebarGroup><SidebarGroupLabel>{title}</SidebarGroupLabel><SidebarMenu>{items.map(item=><SidebarMenuItem key={item.url}><SidebarMenuButton asChild tooltip={item.title} isActive={item.url==='/'?pathname==='/':pathname===item.url||pathname.startsWith(item.url+'/')}><Link to={item.url} activeOptions={{exact:item.url==="/"}} onClick={()=>setOpenMobile(false)}><item.icon aria-hidden/><span>{item.title}</span>{item.url==='/mail' && badge && <span className="ml-auto rounded-md bg-primary px-1.5 text-xs tabular-nums text-primary-foreground group-data-[collapsible=icon]:hidden" aria-label={`${badge.value} ${badge.label}`}>{badge.value>99?'99+':badge.value}</span>}</Link></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>;
}
