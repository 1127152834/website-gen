import { createFileRoute } from '@tanstack/react-router';
import { requireUser } from '@/lib/route-guards';
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout';
export const Route=createFileRoute('/_authenticated')({beforeLoad:({location})=>requireUser(location.href),component:AuthenticatedLayout});
