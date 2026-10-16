import { createFileRoute, Outlet } from '@tanstack/react-router';
import { positiveId } from '@/lib/route-guards';
export const Route=createFileRoute('/_authenticated/mail/$mailboxId/$folder/$uid')({beforeLoad:({params})=>{positiveId(params.uid);},component:()=>null});
