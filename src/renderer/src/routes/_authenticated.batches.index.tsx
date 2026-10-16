import { createFileRoute, Outlet } from '@tanstack/react-router';
import { BatchesPage } from '@/features/batches';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/batches/')({component:()=>{const go=usePageNavigate();return <BatchesPage initialBatch={null} onNew={()=>go('/new')} onNavigate={go}/>;}});
