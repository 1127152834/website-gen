// Adapted from shadcn-admin profile-dropdown/nav-user (MIT).
import { KeyRound, LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from './ui/button';
import { Avatar, AvatarFallback } from './ui/avatar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { logout, HttpError } from '@/lib/auth';
import { useSession } from '@/hooks/use-session';
import { session } from '@/lib/session';
import { toast } from './feedback';
import { useTheme } from '@/context/theme-provider';
export function ProfileDropdown({sidebar=false}:{sidebar?:boolean}){
  const {user}=useSession();const navigate=useNavigate();const {setTheme}=useTheme();
  if(!user)return null;
  const signOut=async()=>{try{await logout();session.set(null);await navigate({to:'/login',replace:true});}catch(error){if(error instanceof HttpError && error.status===401){session.set(null);await navigate({to:'/login',replace:true});}else toast(`退出失败：${(error as Error).message}`,'error');}};
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className={sidebar?'h-12 w-full justify-start px-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0':'size-9 rounded-full p-0'} aria-label={`${sidebar ? "工作区账户" : "用户菜单"}：${user.username}`}><Avatar className="size-8 rounded-lg"><AvatarFallback className="rounded-lg bg-secondary text-xs font-semibold">{user.username.slice(0,2).toUpperCase()}</AvatarFallback></Avatar>{sidebar&&<span className="grid min-w-0 text-left group-data-[collapsible=icon]:hidden"><span className="truncate text-sm font-medium">{user.username}</span><span className="text-xs text-muted-foreground">{user.role==='admin'?'管理员':'独立工作区'}</span></span>}</Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-56"><DropdownMenuLabel><span className="flex items-center gap-2"><UserRound className="size-4"/>{user.username}</span><p className="mt-1 text-xs font-normal text-muted-foreground">{user.role==='admin'?'管理员':'普通用户'} · 数据按工作区隔离</p></DropdownMenuLabel><DropdownMenuSeparator/><DropdownMenuItem onSelect={()=>void navigate({to:'/change-password'})}><KeyRound/>修改密码</DropdownMenuItem><DropdownMenuSeparator/>{([{value:'light',label:'浅色模式',icon:Sun},{value:'dark',label:'深色模式',icon:Moon},{value:'system',label:'跟随系统',icon:Monitor}] as const).map(({value,label,icon:Icon})=><DropdownMenuItem key={value} onSelect={()=>setTheme(value)}><Icon/>{label}</DropdownMenuItem>)}<DropdownMenuSeparator/><DropdownMenuItem className="text-destructive" onSelect={()=>void signOut()}><LogOut/>退出登录</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}
