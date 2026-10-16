import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

export interface SignedAttachmentPayload { userId: number; docId: string; attachmentId: number; expiresAt: number }

export function deriveGristAttachmentSigningKey(masterKey: Uint8Array): Buffer {
  if (masterKey.byteLength !== 32) throw new Error("服务端主密钥必须是 32 字节");
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "grist-attachment-url", 32));
}

function canonical(payload: SignedAttachmentPayload, tokenHash: string): string {
  return `${payload.userId}\n${payload.docId}\n${payload.attachmentId}\n${payload.expiresAt}\n${tokenHash}`;
}

function signature(key: Uint8Array, payload: SignedAttachmentPayload, tokenHash: string): string {
  return createHmac("sha256", key).update(canonical(payload, tokenHash)).digest("base64url");
}

export function createSignedGristAttachmentUrl(input: {
  origin: string; key: Uint8Array; tokenHash: string; payload: SignedAttachmentPayload;
}): string {
  const url = new URL("/api/grist/attachment/signed", input.origin);
  url.searchParams.set("uid", String(input.payload.userId));
  url.searchParams.set("docId", input.payload.docId);
  url.searchParams.set("id", String(input.payload.attachmentId));
  url.searchParams.set("exp", String(input.payload.expiresAt));
  url.searchParams.set("sig", signature(input.key, input.payload, input.tokenHash));
  return url.toString();
}

export function verifySignedGristAttachmentUrl(url: URL, key: Uint8Array, tokenHash: string, now: number): SignedAttachmentPayload {
  const payload = {
    userId: Number(url.searchParams.get("uid")), docId: url.searchParams.get("docId") ?? "",
    attachmentId: Number(url.searchParams.get("id")), expiresAt: Number(url.searchParams.get("exp")),
  };
  const supplied = url.searchParams.get("sig") ?? "";
  if (!Number.isSafeInteger(payload.userId) || payload.userId <= 0 || !payload.docId.trim() || payload.docId.length > 512
    || /[\u0000-\u001f\u007f]/.test(payload.docId) || !Number.isSafeInteger(payload.attachmentId) || payload.attachmentId <= 0
    || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + 10 * 60_000
    || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) throw new AttachmentSigningError();
  const expected = signature(key, payload, tokenHash);
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new AttachmentSigningError();
  return payload;
}

export class AttachmentSigningError extends Error {
  constructor() { super("附件链接无效、已过期或已撤销"); }
}
