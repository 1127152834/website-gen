import assert from "node:assert/strict";
import test from "node:test";
import { attachmentResponseHeaders, GRIST_ATTACHMENT_MAX_BYTES, parseAttachmentRequest } from "./grist-attachment.ts";

test("附件响应只有安全图片/PDF inline，SVG/HTML 强制下载并 sandbox", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]) {
    const headers = attachmentResponseHeaders(new Headers({ "Content-Type": type, "Content-Disposition": "attachment; filename*=UTF-8''hello%20world.pdf", "Content-Length": "12" }), 1);
    assert.match(headers["Content-Disposition"]!, /^inline;/);
    assert.equal(headers["Content-Security-Policy"], undefined);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Cache-Control"], "private, max-age=86400");
    assert.equal(headers.Vary, "Cookie", "private caches must not reuse one user's attachment after account switching");
  }
  for (const type of ["image/svg+xml", "text/html", "application/xml", "text/javascript"]) {
    const headers = attachmentResponseHeaders(new Headers({ "Content-Type": type }), 2);
    assert.match(headers["Content-Disposition"]!, /^attachment;/);
    assert.equal(headers["Content-Security-Policy"], "sandbox");
  }
  assert.equal(attachmentResponseHeaders(new Headers({ "Content-Length": "12", "Content-Encoding": "gzip" }), 4)["Content-Length"], undefined);
  assert.throws(() => attachmentResponseHeaders(new Headers({ "Content-Length": String(GRIST_ATTACHMENT_MAX_BYTES + 1) }), 3), /100 MB/);
});

test("附件下载参数严格校验", () => {
  assert.deepEqual(parseAttachmentRequest(new URL("http://x/api/grist/attachment?docId=doc&id=12")), { docId: "doc", attachmentId: 12 });
  for (const query of ["", "?docId=&id=1", "?docId=d&id=0", "?docId=d&id=1.5", "?docId=d&id=NaN"]) {
    assert.throws(() => parseAttachmentRequest(new URL(`http://x/api/grist/attachment${query}`)), /参数无效/);
  }
});
