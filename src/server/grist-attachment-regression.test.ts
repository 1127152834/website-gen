import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import test from "node:test";
import type { GristClient } from "../backend/grist.ts";
import { GRIST_ATTACHMENT_MAX_BYTES, streamGristAttachment } from "./grist-attachment.ts";

function connection() {
  const req = new EventEmitter();
  let bytes = 0;
  let status: number | undefined;
  const res = Object.assign(new Writable({ write(chunk, _encoding, callback) { bytes += chunk.length; callback(); } }), {
    writeHead(next: number) { status = next; return this; },
  });
  return { req: req as IncomingMessage, res: res as unknown as ServerResponse, bytes: () => bytes, status: () => status };
}

function clientFor(response: Response): GristClient {
  return { async downloadAttachment() { return response; } } as unknown as GristClient;
}

test("attachment proxy rejects oversized Content-Length before sending headers and cancels upstream", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "Content-Length": String(GRIST_ATTACHMENT_MAX_BYTES + 1), "Content-Type": "application/pdf" },
  });
  const fixture = connection();
  await assert.rejects(streamGristAttachment(fixture.req, fixture.res, clientFor(upstream), "doc", 1), /100 MB/);
  assert.equal(fixture.status(), undefined);
  assert.equal(fixture.bytes(), 0);
  assert.equal(cancelled, true);
  fixture.res.destroy();
});

test("attachment proxy caps actual bytes without Content-Length and cancels a continuing upstream", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const upstream = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }));
  const fixture = connection();
  await assert.rejects(streamGristAttachment(fixture.req, fixture.res, clientFor(upstream), "doc", 2), /100 MB/);
  assert.ok(fixture.bytes() <= GRIST_ATTACHMENT_MAX_BYTES);
  assert.equal(cancelled, true);
});

test("attachment proxy sends the first chunk without waiting for the complete file", async () => {
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = new Response(new ReadableStream<Uint8Array>({ start(controller) { upstreamController = controller; } }));
  const fixture = connection();
  const result = streamGristAttachment(fixture.req, fixture.res, clientFor(upstream), "doc", 3);
  upstreamController.enqueue(new Uint8Array([1, 2, 3]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.bytes(), 3);
  assert.equal(fixture.res.writableEnded, false);
  upstreamController.close();
  await result;
});

test("attachment proxy cancels an upstream body when the downstream disconnects", async () => {
  let cancelled = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const fixture = connection();
  const result = streamGristAttachment(fixture.req, fixture.res, clientFor(upstream), "doc", 4);
  await new Promise((resolve) => setImmediate(resolve));
  fixture.res.destroy();
  await assert.rejects(result);
  assert.equal(cancelled, true);
  assert.equal(fixture.req.listenerCount("aborted"), 0);
});

test("attachment proxy aborts pending upstream headers immediately on disconnect", async () => {
  let signal: AbortSignal | undefined;
  const client = {
    async downloadAttachment(_docId: string, _id: number, options?: { signal?: AbortSignal }) {
      signal = options?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
      });
    },
  } as unknown as GristClient;
  const fixture = connection();
  const result = streamGristAttachment(fixture.req, fixture.res, client, "doc", 5).catch(() => undefined);
  fixture.req.emit("aborted");
  assert.equal(signal?.aborted, true);
  await result;
  assert.equal(fixture.req.listenerCount("aborted"), 0);
});

test("attachment proxy rejects bodies longer or shorter than the forwarded Content-Length", async () => {
  for (const size of [2, 4]) {
    const fixture = connection();
    const upstream = new Response(new Uint8Array(size), { headers: { "Content-Length": "3" } });
    await assert.rejects(streamGristAttachment(fixture.req, fixture.res, clientFor(upstream), "doc", 6), /Content-Length|长度/);
    assert.ok(fixture.bytes() <= 3);
  }
});
