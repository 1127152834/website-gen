import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createGristMcpServer, type GetGristClient } from "../backend/grist-tools.ts";

/** Bearer authentication belongs to the HTTP router, before this handler is called. */
export async function handleGristMcp(
  req: IncomingMessage, res: ServerResponse, getClient: GetGristClient,
  getAttachmentUrl?: (input: { docId: string; attachmentId: number }) => { url: string; expiresAt: number } | Promise<{ url: string; expiresAt: number }>,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed. This stateless MCP endpoint accepts POST only." } }));
    return;
  }

  const server = createGristMcpServer(getClient, getAttachmentUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
  let cleanup: Promise<unknown> | undefined;
  const close = () => cleanup ??= Promise.allSettled([transport.close(), server.close()]);
  // Attach before handleRequest: a short JSON response may finish before it resolves.
  res.once("close", () => { void close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "MCP request failed." } }));
    } else if (!res.writableEnded) res.end();
    await close();
  }
}
