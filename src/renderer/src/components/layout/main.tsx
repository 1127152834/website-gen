// Adapted from shadcn-admin Main (MIT).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
type MainProps = ComponentProps<'main'> & { fullBleed?: boolean };
export function Main({className,fullBleed=false,...props}:MainProps){return <main id="page-content" tabIndex={-1} className={cn('w-full min-w-0 flex-1',fullBleed ? 'flex min-h-0 flex-col overflow-hidden' : 'mx-auto max-w-[1440px] px-4 pt-6 pb-20 md:px-6 lg:px-8',className)} {...props}/>;}
