import { createFileRoute, Outlet } from '@tanstack/react-router';
import { TablesPage } from '@/features/tables/tables';
import { useSession } from '@/hooks/use-session';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/tables')({component:()=>{const {user}=useSession();const go=usePageNavigate();return <TablesPage userId={user!.id} onNavigate={go}/>;}});
