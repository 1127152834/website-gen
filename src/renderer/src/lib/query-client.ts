import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, gcTime: 5 * 60_000, retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
export const stableRpcParams = (params: unknown) => JSON.stringify(canonical(params)) ?? 'undefined';
export const rpcQueryKey = (userId: number | null, method: string, params?: unknown) => ['rpc', userId, method.split('.')[0], method, stableRpcParams(params)] as const;
type QueryMatch = { queryKey: readonly unknown[]; meta?: Record<string, unknown> };
export function matchesRpc(query: QueryMatch, method?: string, params?: unknown, exactParams=false): boolean {
  return query.queryKey[0]==='rpc' && (!method || query.queryKey[3]===method) && (!exactParams || query.queryKey[4]===stableRpcParams(params));
}

function isTriageViewMethod(method: string): boolean {
  return method.startsWith('mail.triage.') || method.startsWith('mail.cases.') || method.startsWith('mail.tasks.');
}
const mailboxScopedReadMethods = new Set(['mail.folders', 'mail.messages', 'mail.message']);

/** SSE resource scoping is shared by the transport and covered without a DOM. */
export function matchesPush(query: QueryMatch, push: { topic?: string; siteId?: string | number | null; batchId?: string | number | null; mailboxId?: number; kind: 'changed'|'event'|'chat'|'mail'|'assistant' }, userId: number | null): boolean {
  if (userId == null || query.queryKey[0]!=='rpc' || query.queryKey[1]!==userId) return false;
  const method=String(query.queryKey[3]);
  const resource=String(query.queryKey[2]);
  let params: Record<string,unknown>={};
  try { const value=JSON.parse(String(query.queryKey[4])); if(value && typeof value==='object')params=value; } catch { /* undefined params */ }
  if (push.kind==='changed') return resource===push.topic || ((query.meta?.topics as readonly string[] | undefined) ?? []).includes(push.topic ?? '') || (push.topic==='mail_triage' && isTriageViewMethod(method)) || (push.topic==='sites' && ['overview','batches','domains','qa'].includes(resource));
  if (push.kind==='mail') return method==='mail.list' || (mailboxScopedReadMethods.has(method) && Number.isSafeInteger(params.mailboxId) && Number(params.mailboxId)>0 && params.mailboxId===push.mailboxId);
  if (push.kind==='chat') return ['chat','changes','sites','qa','overview'].includes(resource) && (params.siteId==null || String(params.siteId)===String(push.siteId));
  if (push.kind==='assistant') return resource==='assistant';
  if (!['overview','sites','batches','qa'].includes(resource)) return false;
  return (params.siteId==null || String(params.siteId)===String(push.siteId)) && (params.batchId==null || String(params.batchId)===String(push.batchId));
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Bounded per-query debounce coalesces streaming bursts and refetches active observers only. */
export function invalidatePush(push: Parameters<typeof matchesPush>[1], userId: number | null): void {
  if (userId == null) return;
  for (const query of queryClient.getQueryCache().findAll({predicate:q=>matchesPush(q,push,userId)})) {
    if(pending.has(query.queryHash))continue;
    const hash=query.queryHash;
    pending.set(hash,setTimeout(()=>{pending.delete(hash);void queryClient.invalidateQueries({queryKey:query.queryKey,exact:true});},150));
  }
}
export function clearRpcQueries(): void {
  for(const timer of pending.values())clearTimeout(timer);
  pending.clear();
  void queryClient.cancelQueries();
  queryClient.clear();
}

/** Re-fetch persisted state after an SSE reset/reconnect without crossing user identities. */
export function invalidateRpcState(userId: number | null, client: QueryClient = queryClient): Promise<void> {
  if (userId == null) return Promise.resolve();
  return client.invalidateQueries({ predicate: query => query.queryKey[0] === 'rpc' && query.queryKey[1] === userId });
}

/** Direct invalidation for successful triage writes; SSE remains the cross-client notification path. */
export function invalidateTriageQueries(userId: number | null, client: QueryClient = queryClient): Promise<void> {
  if (userId == null) return Promise.resolve();
  return client.invalidateQueries({ predicate: query => query.queryKey[0] === 'rpc' && query.queryKey[1] === userId && isTriageViewMethod(String(query.queryKey[3])) });
}
