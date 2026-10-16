import { createFileRoute, Outlet } from '@tanstack/react-router';
import { UsersPage } from '@/features/users/users';
import { requireAdmin } from '@/lib/route-guards';
import { useSession } from '@/hooks/use-session';
export const Route=createFileRoute('/_authenticated/users')({beforeLoad:requireAdmin,component:()=>{const {user}=useSession();return user ? <UsersPage currentUser={user}/> : null;}});
