import { createFileRoute, Outlet } from '@tanstack/react-router';
import { positiveId } from '@/lib/route-guards';
import { parseMailSourceSearch } from '@/features/mail/mail-source-search';
export const Route=createFileRoute('/_authenticated/mail/$mailboxId/$folder/$uid')({validateSearch:parseMailSourceSearch,beforeLoad:({params})=>{positiveId(params.uid);},component:()=>null});
