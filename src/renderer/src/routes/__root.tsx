import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { NavigationProgress } from '@/components/navigation-progress';
import { GeneralError, NotFoundError } from '@/features/errors';
import { Skeleton } from '@/components/page-state';
export const Route=createRootRouteWithContext<{queryClient:QueryClient}>()({component:()=> <><NavigationProgress/><Outlet/></>,notFoundComponent:NotFoundError,errorComponent:GeneralError,pendingComponent:()=> <div className="mx-auto max-w-4xl p-8"><Skeleton label="正在打开工作区"/></div>});
