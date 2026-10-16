import { createFileRoute, Outlet } from '@tanstack/react-router';
import { positiveId } from '@/lib/route-guards';
export const Route=createFileRoute('/_authenticated/sites/$siteId')({beforeLoad:({params})=>{positiveId(params.siteId);},component:Outlet});
