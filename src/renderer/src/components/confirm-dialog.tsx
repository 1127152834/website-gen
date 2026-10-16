// Adapted from shadcn-admin (MIT), see renderer/THIRD_PARTY_NOTICES.
import type { ReactNode } from 'react';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
export type ConfirmDialogProps={open:boolean;onOpenChange:(open:boolean)=>void;title:ReactNode;desc:ReactNode;confirmText?:string;destructive?:boolean;disabled?:boolean;handleConfirm:()=>void;children?:ReactNode};
export function ConfirmDialog({open,onOpenChange,title,desc,confirmText='确认',destructive,disabled,handleConfirm,children}:ConfirmDialogProps){return <AlertDialog open={open} onOpenChange={onOpenChange}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription asChild><div>{desc}</div></AlertDialogDescription></AlertDialogHeader>{children}<AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><Button disabled={disabled} variant={destructive?'destructive':'default'} onClick={handleConfirm}>{confirmText}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>;}
