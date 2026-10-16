import { getCurrentUser, HttpError, invalidateApiRequests } from './auth.ts';
import { pauseBackendTransport, startBackendTransport, stopBackendTransport } from './backend.ts';
import type { AuthUser } from '../../../shared/auth.ts';
export type Session = { user: AuthUser | null; epoch: number; checked: boolean; verifying: boolean };
let state: Session = {user:null,epoch:0,checked:false,verifying:false};
let generation=0;
let pending: Promise<AuthUser|null>|null=null;
const listeners=new Set<()=>void>();
export const session={
  snapshot:()=>state,
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
  set(user:AuthUser|null){
    generation++;pending=null;
    const old=state.user;
    const same=old?.id===user?.id && old?.username===user?.username && old?.role===user?.role && old?.mustChangePassword===user?.mustChangePassword;
    if(state.checked && same && !state.verifying)return;
    invalidateApiRequests();
    if(!same)stopBackendTransport(true);
    state={user,checked:true,epoch:state.epoch+(same?0:1),verifying:false};
    if(user && !user.mustChangePassword)startBackendTransport(user.id,!same,same);
    for(const listener of listeners)listener();
  },
  suspend(preserveUser=false){
    generation++;pending=null;invalidateApiRequests();
    if(preserveUser)pauseBackendTransport();else stopBackendTransport(true);
    state={user:preserveUser?state.user:null,checked:false,epoch:state.epoch+(preserveUser?0:1),verifying:true};
    for(const listener of listeners)listener();
  },
  async ensure(force=false):Promise<AuthUser|null>{
    if(pending)return pending;
    if(!force && state.checked)return state.user;
    const request=++generation;
    const promise=getCurrentUser().then(user=>{if(request!==generation)return state.user;session.set(user);return user;},error=>{if(request!==generation)return state.user;if(error instanceof HttpError && error.status===401){session.set(null);return null;}throw error;});
    pending=promise;
    try{return await promise;}finally{if(pending===promise)pending=null;}
  },
};
