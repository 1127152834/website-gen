import { useRouterState } from '@tanstack/react-router';
export function NavigationProgress(){const pending=useRouterState({select:s=>s.status==='pending'});return pending?<div role="progressbar" aria-label="正在打开页面" className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-primary/10"><span className="block h-full w-2/3 animate-pulse bg-primary"/></div>:null;}
