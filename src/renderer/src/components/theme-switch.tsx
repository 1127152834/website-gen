// Adapted from shadcn-admin ThemeSwitch (MIT).
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/context/theme-provider';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
export function ThemeSwitch(){const {theme,setTheme}=useTheme();return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="切换主题"><Sun className="dark:hidden"/><Moon className="hidden dark:block"/></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{([{value:'light',label:'浅色模式',icon:Sun},{value:'dark',label:'深色模式',icon:Moon},{value:'system',label:'跟随系统',icon:Monitor}] as const).map(({value,label,icon:Icon})=><DropdownMenuItem key={value} onSelect={()=>setTheme(value)}><Icon/>{label}{theme===value&&<Check className="ml-auto"/>}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;}
