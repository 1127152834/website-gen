import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SitesPage } from '@/features/sites';
import { positiveId } from '@/lib/route-guards';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/sites/$siteId/')({component:()=>{const {siteId}=Route.useParams();const go=usePageNavigate();return <SitesPage siteId={positiveId(siteId)} tab="overview" onNavigate={go}/>;}});
