import { createFileRoute, Outlet } from '@tanstack/react-router';
import { SitesPage } from '@/features/sites';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/sites/')({component:()=>{const go=usePageNavigate();return <SitesPage onNavigate={go}/>;}});
