import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast as sonner, Toaster } from 'sonner';
import { ConfirmDialog } from './confirm-dialog';
import { useTheme } from '@/context/theme-provider';
type ConfirmOptions={title:string;description:string;confirmText?:string;destructive?:boolean};
type Confirm=(options:ConfirmOptions)=>Promise<boolean>;
const Context=createContext<Confirm>(async()=>false);
export const useConfirm=()=>useContext(Context);
export function toast(message:string,tone:'success'|'error'='success'){sonner[tone](message);}
export function FeedbackProvider({children}:{children:ReactNode}){
  const [confirmation,setConfirmation]=useState<ConfirmOptions|null>(null);
  const pending=useRef<((value:boolean)=>void)|null>(null);
  const {theme}=useTheme();
  const confirm=useCallback<Confirm>(options=>{pending.current?.(false);return new Promise(resolve=>{pending.current=resolve;setConfirmation(options);});},[]);
  const settle=(value:boolean)=>{pending.current?.(value);pending.current=null;setConfirmation(null);};
  useEffect(()=>()=>{pending.current?.(false);sonner.dismiss();},[]);
  return <Context value={confirm}>{children}<Toaster theme={theme} richColors closeButton position="bottom-right" duration={5000} toastOptions={{style:{fontFamily:'var(--font-sans)'}}}/><ConfirmDialog open={confirmation!==null} onOpenChange={open=>{if(!open)settle(false);}} title={confirmation?.title} desc={confirmation?.description} confirmText={confirmation?.confirmText} destructive={confirmation?.destructive} handleConfirm={()=>settle(true)}/></Context>;
}