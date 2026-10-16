import { createFileRoute, Outlet } from '@tanstack/react-router';
import { AccountsPage } from '@/features/accounts/accounts';
export const Route=createFileRoute('/_authenticated/accounts')({component:AccountsPage});
