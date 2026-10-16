import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { queryClient } from '@/lib/query-client';
import { router } from '@/lib/router';
import { session } from '@/lib/session';
import { AUTH_SYNC_KEY } from '@/lib/auth';
import { ThemeProvider } from '@/context/theme-provider';
import { FeedbackProvider, toast } from '@/components/feedback';
import { useSession } from '@/hooks/use-session';
export default function App(){
  const {epoch}=useSession();
  useEffect(()=>{
    const refresh=async(suspend=false,preserveUser=false)=>{try{if(suspend)session.suspend(preserveUser);await session.ensure(true);await router.invalidate();}catch(error){toast(`无法复核登录状态：${(error as Error).message}`,'error');}};
    const auth=(event:Event)=>{const problem=(event as CustomEvent<string>).detail;if(problem==='identity_changed'){void refresh(true);return;}if(problem==='password_required'){const user=session.snapshot().user;if(user)session.set({...user,mustChangePassword:true});else session.set(null);}else session.set(null);void router.invalidate();};
    const storage=(event:StorageEvent)=>{if(event.key===AUTH_SYNC_KEY)void refresh(true);};
    const focus=()=>{void refresh(true,true);};
    const off=session.subscribe(()=>{void router.invalidate();});
    window.addEventListener('website-gen:auth',auth);window.addEventListener('storage',storage);window.addEventListener('focus',focus);
    return()=>{off();window.removeEventListener('website-gen:auth',auth);window.removeEventListener('storage',storage);window.removeEventListener('focus',focus);};
  },[]);
  return <QueryClientProvider client={queryClient}><ThemeProvider><FeedbackProvider key={epoch}><SessionBoundary/></FeedbackProvider></ThemeProvider></QueryClientProvider>;
}
function SessionBoundary(){const {verifying}=useSession();return <><div inert={verifying||undefined} aria-busy={verifying}><RouterProvider router={router}/></div>{verifying&&<div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/90"><div className="space-y-4 rounded-lg border bg-card p-6 text-center"><p role="status">正在复核登录身份…</p><button type="button" className="text-sm underline" onClick={()=>void session.ensure(true).catch(error=>toast((error as Error).message,'error'))}>连接异常？重试</button></div></div>}</>;}
