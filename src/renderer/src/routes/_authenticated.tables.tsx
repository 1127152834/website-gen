import { createFileRoute } from '@tanstack/react-router';
import { TablesPage } from '@/features/tables/tables';
import { useNavigate } from '@tanstack/react-router';
const usePageNavigate=()=>{const navigate=useNavigate();return (path:string)=>{void navigate({to:path});};};
export const Route=createFileRoute('/_authenticated/tables')({component:()=>{const go=usePageNavigate();return <TablesPage onNavigate={go}/>;}});
