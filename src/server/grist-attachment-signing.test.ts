import assert from "node:assert/strict";
import test from "node:test";
import { createSignedGristAttachmentUrl, deriveGristAttachmentSigningKey, verifySignedGristAttachmentUrl } from "./grist-attachment-signing.ts";

test("Grist 附件签名链接校验有效、过期、篡改与令牌轮换", () => {
  const key = deriveGristAttachmentSigningKey(Buffer.alloc(32, 7));
  const now = 1000;
  const signed = createSignedGristAttachmentUrl({ origin: "https://example.com", key, tokenHash: "old-token-hash", payload: { userId: 2, docId: "doc/一", attachmentId: 12, expiresAt: now + 600_000 } });
  const url = new URL(signed);
  assert.deepEqual(verifySignedGristAttachmentUrl(url, key, "old-token-hash", now), { userId: 2, docId: "doc/一", attachmentId: 12, expiresAt: now + 600_000 });
  assert.throws(() => verifySignedGristAttachmentUrl(url, key, "old-token-hash", now + 600_001), /无效|过期|撤销/);
  const tampered = new URL(signed); tampered.searchParams.set("id", "13");
  assert.throws(() => verifySignedGristAttachmentUrl(tampered, key, "old-token-hash", now), /无效|过期|撤销/);
  assert.throws(() => verifySignedGristAttachmentUrl(url, key, "replacement-token-hash", now), /无效|过期|撤销/);
});
