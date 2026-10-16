import { createFileRoute, Outlet } from '@tanstack/react-router';
import { OverviewPage } from '@/features/overview';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/')({component:()=>{const go=usePageNavigate();return <OverviewPage onNavigate={go}/>;}});
