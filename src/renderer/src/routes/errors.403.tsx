import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ForbiddenError } from '@/features/errors';
export const Route=createFileRoute('/errors/403')({component:ForbiddenError});
