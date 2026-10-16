import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GristClient } from "../backend/grist.ts";

export const GRIST_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

export class AttachmentHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function parseAttachmentRequest(url: URL): { docId: string; attachmentId: number } {
  const docId = url.searchParams.get("docId") ?? "";
  const attachmentId = Number(url.searchParams.get("id"));
  if (!docId.trim() || docId.length > 512 || /[\u0000-\u001f\u007f]/.test(docId) || !Number.isSafeInteger(attachmentId) || attachmentId <= 0) {
    throw new AttachmentHttpError(400, "附件参数无效");
  }
  return { docId, attachmentId };
}

function attachmentName(disposition: string | null, attachmentId: number): string {
  let value = "";
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition ?? "")?.[1];
  if (extended) try { value = decodeURIComponent(extended.trim()); } catch { /* use fallback */ }
  if (!value) value = /(?:^|;)\s*filename\s*=\s*"([^"]*)"/i.exec(disposition ?? "")?.[1]
    ?? /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(disposition ?? "")?.[1]?.trim() ?? "";
  return value.replace(/[\r\n\u0000-\u001f\u007f/\\]/g, "_").slice(0, 200) || `attachment-${attachmentId}`;
}

export function attachmentResponseHeaders(upstream: Headers, attachmentId: number): Record<string, string> {
  const contentType = (upstream.get("content-type") ?? "application/octet-stream").trim() || "application/octet-stream";
  const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
  const inline = INLINE_TYPES.has(mime);
  const fileName = attachmentName(upstream.get("content-disposition"), attachmentId);
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=86400",
    // Browser private caches are shared by app accounts in the same browser profile.
    Vary: "Cookie",
  };
  if (!inline) headers["Content-Security-Policy"] = "sandbox";
  const declared = upstream.get("content-length");
  const contentEncoding = upstream.get("content-encoding")?.trim().toLowerCase();
  if (declared && /^\d+$/.test(declared) && (!contentEncoding || contentEncoding === "identity")) {
    const length = Number(declared);
    if (length > GRIST_ATTACHMENT_MAX_BYTES) throw new AttachmentHttpError(413, "附件超过 100 MB 上限");
    headers["Content-Length"] = declared;
  }
  return headers;
}

/** Streams the decompressed fetch body and enforces the cap even if Content-Length is absent or false. */
export async function streamGristAttachment(
  req: IncomingMessage, res: ServerResponse, client: GristClient, docId: string, attachmentId: number,
  beforeHeaders?: () => void | Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => { if (!controller.signal.aborted) controller.abort(new Error("客户端已断开")); };
  req.once("aborted", cancel);
  res.once("close", cancel);
  try {
    const upstream = await client.downloadAttachment(docId, attachmentId, { signal: controller.signal });
    if (!upstream.body) throw new AttachmentHttpError(502, "Grist 附件响应没有正文");
    let headers: Record<string, string>;
    try {
      headers = attachmentResponseHeaders(upstream.headers, attachmentId);
      await beforeHeaders?.();
    } catch (error) {
      await upstream.body.cancel(error).catch(() => {});
      throw error;
    }
    let bytes = 0;
    const declaredLength = headers["Content-Length"] === undefined ? undefined : Number(headers["Content-Length"]);
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      const next = bytes + chunk.length;
      if (next > GRIST_ATTACHMENT_MAX_BYTES) { callback(new AttachmentHttpError(413, "附件超过 100 MB 上限")); return; }
      if (declaredLength !== undefined && next > declaredLength) { callback(new AttachmentHttpError(502, "Grist 附件正文超过 Content-Length")); return; }
      bytes = next; callback(null, chunk);
    }, flush(callback) {
      callback(declaredLength !== undefined && bytes !== declaredLength ? new AttachmentHttpError(502, "Grist 附件正文短于 Content-Length") : null);
    } });
    const source = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream<Uint8Array>);
    res.writeHead(200, headers);
    await pipeline(source, limiter, res);
  } finally {
    req.off("aborted", cancel);
    res.off("close", cancel);
  }
}
