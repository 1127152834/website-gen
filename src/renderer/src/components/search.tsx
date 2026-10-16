// Adapted from shadcn-admin Search/SearchProvider/CommandMenu (MIT).
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, Globe, Search as SearchIcon, Settings } from 'lucide-react';
import { useRpcData } from '@/lib/backend';
import { useSession } from '@/hooks/use-session';
import { Button } from './ui/button';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from './ui/command';
import { navGroups } from './layout/navigation';
const SearchContext=createContext({open:false,setOpen:(_open:boolean)=>{}});
export function SearchProvider({children}:{children:ReactNode}){
  const [open,setOpen]=useState(false);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setOpen(v=>!v);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  return <SearchContext value={{open,setOpen}}>{children}</SearchContext>;
}
export function Search(){const {setOpen}=useContext(SearchContext);return <Button variant="outline" size="sm" className="justify-start gap-2 text-muted-foreground sm:w-44 lg:w-60" aria-label="搜索页面、站点和设置" aria-keyshortcuts="Meta+K Control+K" onClick={()=>setOpen(true)}><SearchIcon aria-hidden/><span className="hidden sm:inline">搜索工作区…</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline">⌘ / Ctrl K</kbd></Button>;}
const settings=[{title:'模型厂商',id:'providers'},{title:'用途分配',id:'roles'},{title:'商品资料 CJ',id:'cj'},{title:'邮箱默认密码',id:'mailbox'},{title:'账户安全',id:'security'},{title:'Grist',id:'grist'}];
export function CommandMenu(){
  const {open,setOpen}=useContext(SearchContext);const {user}=useSession();const navigate=useNavigate();
  const {data:sites=[]}=useRpcData<{id:number;domain:string}[]>('sites.all',undefined,{enabled:open,topics:['sites']});
  const go=(path:string,hash?:string)=>{setOpen(false);void navigate({to:path,hash});};
  return <CommandDialog open={open} onOpenChange={setOpen} title="搜索工作区" description="跳转页面、按域名查找站点或打开设置分区"><CommandInput aria-label="搜索页面、域名或设置" placeholder="搜索页面、域名或设置…"/><CommandList><CommandEmpty>没有找到结果。试试站点域名或页面名称。</CommandEmpty>{navGroups.map(group=><CommandGroup key={group.title} heading={group.title}>{group.items.filter(item=>!item.admin||user?.role==='admin').map(item=><CommandItem key={item.url} value={`页面 ${item.title}`} onSelect={()=>go(item.url)}><ArrowRight aria-hidden/>{item.title}</CommandItem>)}</CommandGroup>)}<CommandSeparator/><CommandGroup heading="站点">{sites.map(site=><CommandItem key={site.id} value={`站点 ${site.domain}`} onSelect={()=>go(`/sites/${site.id}/overview`)}><Globe aria-hidden/>{site.domain}</CommandItem>)}</CommandGroup><CommandSeparator/><CommandGroup heading="设置分区">{settings.map(item=><CommandItem key={item.id} value={`设置 ${item.title}`} onSelect={()=>go('/settings',item.id)}><Settings aria-hidden/>{item.title}</CommandItem>)}</CommandGroup></CommandList></CommandDialog>;
}

