import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

type ConfirmOptions = { title: string; description: string; confirmText?: string; destructive?: boolean };
type Confirm = (options: ConfirmOptions) => Promise<boolean>;
const Context = createContext<Confirm>(async () => false);
export const useConfirm = () => useContext(Context);
export function toast(message: string, tone: "success" | "error" = "success") {
  window.dispatchEvent(new CustomEvent("website-gen:toast", { detail: { message, tone } }));
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [confirmation, setConfirmation] = useState<ConfirmOptions | null>(null);
  const pending = useRef<((value: boolean) => void) | null>(null);
  const [messages, setMessages] = useState<{ id: number; message: string; tone: string }[]>([]);
  const nextId = useRef(0);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const confirm = useCallback<Confirm>((options) => {
    pending.current?.(false);
    return new Promise((resolve) => { pending.current = resolve; setConfirmation(options); });
  }, []);
  const settle = (result: boolean) => { pending.current?.(result); pending.current = null; setConfirmation(null); };
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; tone: string }>).detail;
      const id = ++nextId.current;
      setMessages((items) => [...items.slice(-3), { ...detail, id }]);
      const timer = setTimeout(() => { setMessages((items) => items.filter((item) => item.id !== id)); timers.current.delete(timer); }, 6000);
      timers.current.add(timer);
    };
    window.addEventListener("website-gen:toast", listener);
    return () => { window.removeEventListener("website-gen:toast", listener); for (const timer of timers.current) clearTimeout(timer); pending.current?.(false); };
  }, []);
  return <Context.Provider value={confirm}>{children}
    <div aria-live="polite" aria-atomic="false" className="fixed bottom-4 right-4 z-[80] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
      {messages.map((item) => <div key={item.id} role={item.tone === "error" ? "alert" : "status"} className="flex items-start gap-3 rounded-lg bg-popover p-4 text-sm text-popover-foreground shadow-lg ring-1 ring-border"><span className={item.tone === "error" ? "flex-1 text-destructive" : "flex-1"}>{item.message}</span><button type="button" aria-label="关闭通知" onClick={() => setMessages((items) => items.filter((message) => message.id !== item.id))}><X className="size-4" /></button></div>)}
    </div>
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!open) settle(false); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle><AlertDialogDescription>{confirmation?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => settle(false)}>取消</AlertDialogCancel><AlertDialogAction variant={confirmation?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{confirmation?.confirmText ?? "确认"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </Context.Provider>;
}
