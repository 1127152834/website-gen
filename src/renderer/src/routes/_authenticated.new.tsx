import { createFileRoute, Outlet } from '@tanstack/react-router';
import { NewBatchPage } from '@/features/new-batch';
import { useSession } from '@/hooks/use-session';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/new')({component:()=>{const {user}=useSession();const go=usePageNavigate();return <NewBatchPage userId={user!.id} onCreated={id=>go('/batches/'+id)}/>;}});
