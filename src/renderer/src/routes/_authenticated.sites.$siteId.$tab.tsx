import { createFileRoute, Outlet } from '@tanstack/react-router';
import { notFound } from '@tanstack/react-router';
import { SitesPage } from '@/features/sites';
import { positiveId,siteTabs } from '@/lib/route-guards';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/sites/$siteId/$tab')({beforeLoad:({params})=>{if(!siteTabs.includes(params.tab as typeof siteTabs[number]))throw notFound();},component:()=>{const {siteId,tab}=Route.useParams();const go=usePageNavigate();return <SitesPage siteId={positiveId(siteId)} tab={tab} onNavigate={go}/>;}});
