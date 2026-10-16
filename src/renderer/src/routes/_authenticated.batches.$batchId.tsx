import { createFileRoute, Outlet } from '@tanstack/react-router';
import { BatchesPage } from '@/features/batches';
import { positiveId } from '@/lib/route-guards';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/batches/$batchId')({beforeLoad:({params})=>{positiveId(params.batchId);},component:()=>{const {batchId}=Route.useParams();const go=usePageNavigate();return <BatchesPage key={batchId} initialBatch={positiveId(batchId)} onNew={()=>go('/new')} onNavigate={go}/>;}});
