import test from 'node:test';
import assert from 'node:assert/strict';
import { session } from './session.ts';
import { call, stopBackendTransport } from './backend.ts';
import { clearRpcQueries, queryClient, rpcQueryKey } from './query-client.ts';
import type { AuthUser } from '../../../shared/auth.ts';

test('focus identity verification freezes RPC, retains same-user cache/drafts, and clears on identity switch', async()=>{
  const originalWindow=globalThis.window;
  const originalSource=globalThis.EventSource;
  const originalFetch=globalThis.fetch;
  const target=new EventTarget();
  globalThis.window=Object.assign(target,{setTimeout,clearTimeout}) as unknown as Window & typeof globalThis;
  globalThis.EventSource=class {onopen=null;onmessage=null;onerror=null;close(){}} as unknown as typeof EventSource;
  const user={id:701,username:'alice',role:'user',mustChangePassword:false} as AuthUser;
  try{
    session.set(user);
    const epoch=session.snapshot().epoch;
    queryClient.setQueryData(rpcQueryKey(user.id,'sites.all'),[{domain:'alice.test'}]);
    session.suspend(true);
    assert.equal(session.snapshot().verifying,true);
    assert.equal(session.snapshot().epoch,epoch,'same-user UI must not remount while checking');
    await assert.rejects(call('sites.all'),/复核登录身份/);
    assert.deepEqual(queryClient.getQueryData(rpcQueryKey(user.id,'sites.all')),[{domain:'alice.test'}]);
    globalThis.fetch=async()=>new Response(JSON.stringify({user}),{headers:{'Content-Type':'application/json'}});
    await session.ensure(true);
    assert.equal(session.snapshot().verifying,false);
    assert.equal(session.snapshot().epoch,epoch);
    assert.deepEqual(queryClient.getQueryData(rpcQueryKey(user.id,'sites.all')),[{domain:'alice.test'}]);
    session.suspend(true);
    globalThis.fetch=async()=>new Response(JSON.stringify({user:{...user,id:702,username:'bob'}}),{headers:{'Content-Type':'application/json'}});
    await session.ensure(true);
    assert.equal(session.snapshot().user?.id,702);
    assert.ok(session.snapshot().epoch>epoch);
    assert.equal(queryClient.getQueryData(rpcQueryKey(user.id,'sites.all')),undefined);
  }finally{
    session.set(null);stopBackendTransport();clearRpcQueries();
    globalThis.window=originalWindow;globalThis.EventSource=originalSource;globalThis.fetch=originalFetch;
  }
});

test('late identity checks cannot restore a signed-out user',async()=>{
  const oldFetch=globalThis.fetch;const oldWindow=globalThis.window;
  globalThis.window=Object.assign(new EventTarget(),{setTimeout,clearTimeout}) as unknown as Window & typeof globalThis;
  let resolve!:(response:Response)=>void;
  globalThis.fetch=()=>new Promise<Response>(done=>{resolve=done;});
  try{
    const pending=session.ensure(true);
    session.set(null);
    resolve(new Response(JSON.stringify({user:{id:99,username:'late',role:'user',mustChangePassword:false}})));
    assert.equal(await pending,null);
    assert.equal(session.snapshot().user,null);
  }finally{stopBackendTransport();clearRpcQueries();globalThis.fetch=oldFetch;globalThis.window=oldWindow;}
});

test('RPC queued before transport start is rejected on logout instead of crossing users',async()=>{
  const oldWindow=globalThis.window;
  globalThis.window=Object.assign(new EventTarget(),{setTimeout,clearTimeout}) as unknown as Window & typeof globalThis;
  try{
    stopBackendTransport();
    const queued=call('overview.get');
    stopBackendTransport();
    await assert.rejects(queued,/登录状态已变化/);
  }finally{stopBackendTransport();globalThis.window=oldWindow;}
});
