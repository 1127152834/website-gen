import type { MailFolder, MailboxSummary } from "../../../../shared/mail-types.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { folderUnread } from "./mail-open-state.ts";

export function MailboxPane({ mailboxes, activeMailboxId, folders, activeFolder, onSelectMailbox, onSelectFolder }: {
  mailboxes: MailboxSummary[]; activeMailboxId?: number; folders: MailFolder[]; activeFolder: string;
  onSelectMailbox(id: number): void; onSelectFolder(id: number, folder: string): void;
}) {
  const domains = new Map<string, MailboxSummary[]>();
  for (const mailbox of mailboxes) domains.set(mailbox.domain, [...(domains.get(mailbox.domain) ?? []), mailbox]);
  return <aside aria-label="邮箱与文件夹" className="min-w-0 border-r">
    <div className="border-b px-4 py-3 text-sm font-medium">全部邮箱 <span className="font-normal text-muted-foreground">{mailboxes.length}</span></div>
    <div className="max-h-[calc(100dvh-16rem)] overflow-auto p-2">{[...domains].map(([domain, items]) => <section key={domain} className="mb-4">
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{domain}</h2>
      {items.map(mailbox => <div key={mailbox.id} className={cn("mb-1 rounded-lg", mailbox.id === activeMailboxId && "bg-accent ring-1 ring-primary/25")}>
        <button type="button" className="w-full rounded-lg p-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onSelectMailbox(mailbox.id)}>
          <span className="flex items-center justify-between gap-2 text-sm font-medium"><span className="truncate">{mailbox.address}</span>{mailbox.unreadCount > 0 ? <Badge>{mailbox.unreadCount}</Badge> : null}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{mailbox.credentialSaved ? "已连接" : "需要凭据"}</span>
        </button>
        {mailbox.id === activeMailboxId && mailbox.credentialSaved ? <div className="grid gap-1 px-2 pb-2" aria-label={`${mailbox.address} 文件夹`}>
          {folders.map(folder => <Button key={folder.path} size="sm" variant={folder.path === activeFolder ? "secondary" : "ghost"} className="justify-between" onClick={() => onSelectFolder(mailbox.id, folder.path)}>
            {folder.name}{folderUnread(folder, mailbox) > 0 ? <span className="tabular-nums">{folderUnread(folder, mailbox)}</span> : null}
          </Button>)}
        </div> : null}
      </div>)}
    </section>)}</div>
  </aside>;
}
