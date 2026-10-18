import { useState } from "react";
import type { MailboxSummary } from "../../../../shared/mail-types.ts";
import type { ContactMapping, PageResult } from "../../../../shared/mail-triage-types.ts";
import { toast, useConfirm } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { call, invalidateRpcData, useRpcData } from "@/lib/backend.ts";

export function ContactMappingPane({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const confirm=useConfirm(),query=useRpcData<PageResult<ContactMapping>>("mail.triage.contacts.list",{page:1,pageSize:100},{topics:["mail_triage"]});
  const [providerKey,setProviderKey]=useState(""),[sender,setSender]=useState(""),[mailboxIds,setMailboxIds]=useState<number[]>([]);
  const save=async()=>{try{await call("mail.triage.contacts.save",{requestId:crypto.randomUUID(),expectedVersion:0,reason:"用户明确保存联系人辅助映射",mapping:{providerKey,siteId:null,mailboxIds,senderAddresses:[sender.trim()],domains:[]}});invalidateRpcData("mail.triage.contacts.list");setProviderKey("");setSender("");setMailboxIds([]);toast("映射已保存；本封来源仍需单独确认");}catch(error){toast((error as Error).message,"error");}};
  const remove=async(item:ContactMapping)=>{if(!await confirm({title:"删除联系人辅助映射？",description:"只删除匹配辅助信息，不改变来源确认状态。",confirmText:"删除",destructive:true}))return;await call("mail.triage.contacts.remove",{requestId:crypto.randomUUID(),expectedVersion:item.version,reason:"用户明确删除联系人辅助映射",id:item.id});invalidateRpcData("mail.triage.contacts.list");};
  return <section className="rounded-xl border bg-card p-5"><h2 className="font-semibold">联系人辅助映射</h2><p className="mt-1 text-sm text-muted-foreground">只提供关联候选，不授权模型判定，也不替代每封来源确认。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><Input aria-label="服务商标识" placeholder="服务商标识" value={providerKey} onChange={event=>setProviderKey(event.target.value)}/><Input aria-label="发件地址" placeholder="发件地址" value={sender} onChange={event=>setSender(event.target.value)}/></div><div className="mt-3 flex flex-wrap gap-2">{mailboxes.map(box=><label key={box.id} className="flex items-center gap-2 rounded border px-2 py-1 text-xs"><input type="checkbox" checked={mailboxIds.includes(box.id)} onChange={event=>setMailboxIds(current=>event.target.checked?[...current,box.id]:current.filter(id=>id!==box.id))}/>{box.address}</label>)}</div><Button className="mt-3" variant="outline" disabled={!providerKey.trim()||!sender.trim()||!mailboxIds.length} onClick={()=>void save()}>保存映射</Button><div className="mt-4 space-y-2">{query.data?.items.map(item=><div key={item.id} className="flex justify-between gap-3 rounded-lg bg-muted p-3 text-sm"><span><strong>{item.providerKey}</strong><small className="block text-muted-foreground">{item.senderAddresses.join("、")} · 仍须逐封确认</small></span><Button size="sm" variant="ghost" onClick={()=>void remove(item)}>删除</Button></div>)}</div></section>;
}
