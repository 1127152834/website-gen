// Adapted from shadcn-admin Main (MIT).
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
export function Main({className,...props}:ComponentProps<'main'>){return <main id="page-content" tabIndex={-1} className={cn('mx-auto w-full max-w-[1440px] min-w-0 flex-1 px-4 pt-6 pb-20 md:px-6 lg:px-8',className)} {...props}/>;}
