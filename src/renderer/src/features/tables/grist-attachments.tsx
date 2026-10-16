import { useEffect, useRef, useState } from "react";
import { File, FileImage, FileText } from "lucide-react";
import { attachmentKind, formatFileSize, gristAttachmentUrl, parseAttachmentIds, type GristAttachment } from "./grist-table-helpers.ts";

function LazyThumbnail({ src, alt, className }: { src: string; alt: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    if (!("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return <span ref={ref} className={className}>{visible && <img src={src} alt={alt} loading="lazy" className="size-full object-cover" />}</span>;
}

function AttachmentIcon({ kind }: { kind: ReturnType<typeof attachmentKind> }) {
  return kind === "image" ? <FileImage className="size-3.5 shrink-0" aria-hidden /> : kind === "pdf" ? <FileText className="size-3.5 shrink-0" aria-hidden /> : <File className="size-3.5 shrink-0" aria-hidden />;
}

export function AttachmentChips({ docId, value, attachments }: { docId: string; value: unknown; attachments: ReadonlyMap<number, GristAttachment> }) {
  const ids = parseAttachmentIds(value);
  if (ids.length === 0) return <span className="text-muted-foreground">—</span>;
  return <div className="flex max-w-80 flex-wrap gap-1 p-1">{ids.map((id) => {
    const attachment = attachments.get(id);
    const name = attachment?.fileName || `附件 #${id}`;
    const kind = attachmentKind(name);
    const href = gristAttachmentUrl(docId, id);
    const title = `${name} · ${formatFileSize(attachment?.fileSize)}`;
    return <a key={id} href={href} target={kind === "file" ? undefined : "_blank"} rel={kind === "file" ? undefined : "noopener noreferrer"} download={kind === "file" ? name : undefined} title={title} className="inline-flex max-w-44 items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
      {kind === "image" ? <LazyThumbnail src={href} alt="" className="size-5 shrink-0 overflow-hidden rounded bg-muted" /> : <AttachmentIcon kind={kind} />}
      <span className="truncate">{name}</span>
    </a>;
  })}</div>;
}

export function AttachmentGrid({ docId, value, attachments }: { docId: string; value: unknown; attachments: ReadonlyMap<number, GristAttachment> }) {
  const ids = parseAttachmentIds(value);
  if (ids.length === 0) return <span className="text-sm text-muted-foreground">没有附件</span>;
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{ids.map((id) => {
    const attachment = attachments.get(id);
    const name = attachment?.fileName || `附件 #${id}`;
    const kind = attachmentKind(name);
    const href = gristAttachmentUrl(docId, id);
    const common = { href, title: `${name} · ${formatFileSize(attachment?.fileSize)}`, className: "group min-w-0 rounded-lg border bg-card p-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring" };
    return <a key={id} {...common} target={kind === "file" ? undefined : "_blank"} rel={kind === "file" ? undefined : "noopener noreferrer"} download={kind === "file" ? name : undefined}>
      {kind === "image" ? <LazyThumbnail src={href} alt={name} className="mb-2 block aspect-square w-full overflow-hidden rounded-md bg-muted" /> : <span className="mb-2 flex aspect-square w-full items-center justify-center rounded-md bg-muted"><AttachmentIcon kind={kind} /></span>}
      <span className="block truncate text-xs font-medium">{name}</span>
      <span className="block text-[11px] text-muted-foreground">{formatFileSize(attachment?.fileSize)}</span>
    </a>;
  })}</div>;
}
