import { useSyncExternalStore } from 'react';
import { session } from '@/lib/session.ts';
export const useSession=()=>useSyncExternalStore(session.subscribe,session.snapshot,session.snapshot);
