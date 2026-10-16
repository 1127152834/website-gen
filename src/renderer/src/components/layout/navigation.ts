import { Globe, KeyRound, Layers, LayoutDashboard, Mail, Settings, Store, Table2, Users, type LucideIcon } from 'lucide-react';
export type NavItem={title:string;url:string;icon:LucideIcon;admin?:boolean};
export const navGroups:{title:string;items:NavItem[]}[]=[
  {title:'建站与运营',items:[{title:'总览',url:'/',icon:LayoutDashboard},{title:'建站',url:'/new',icon:Store},{title:'批次',url:'/batches',icon:Layers},{title:'站点',url:'/sites',icon:Globe}]},
  {title:'资源',items:[{title:'账号',url:'/accounts',icon:KeyRound},{title:'邮箱',url:'/mail',icon:Mail},{title:'表格',url:'/tables',icon:Table2}]},
  {title:'系统',items:[{title:'设置',url:'/settings',icon:Settings},{title:'用户管理',url:'/users',icon:Users,admin:true}]},
];
export const pageTitle=(pathname:string)=>navGroups.flatMap(g=>g.items).find(i=>i.url==='/'?pathname==='/':pathname===i.url||pathname.startsWith(i.url+'/'))?.title??'工作区';
