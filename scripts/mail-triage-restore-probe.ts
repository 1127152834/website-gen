import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWorkspace, type Workspace } from "../src/backend/index.ts";
import { FakeMailTransport, fakeHostinger } from "../src/backend/testing.ts";
import { createApp, type WorkspaceManagerLike } from "../src/server/http.ts";
import { deriveUserKey, loadMasterKey } from "../src/server/keys.ts";

const [dataDirArg, userIdArg, outputPath] = process.argv.slice(2);
if (!dataDirArg || !userIdArg || !outputPath) throw new Error("restore probe arguments missing");
const dataDir = resolve(dataDirArg), userId = Number(userIdArg), masterKey = loadMasterKey(dataDir);
const transport = new FakeMailTransport(), hostinger = fakeHostinger();
const hostingerPool = { forAccount: () => hostinger.exec, close: async () => {}, closeAll: async () => {} } as never;
const workspaces = new Map<number, Workspace>();
const manager: WorkspaceManagerLike = {
  open(id) {
    const existing = workspaces.get(id); if (existing) return existing;
    if (id !== userId) throw new Error("restored fixture user mismatch");
    const workspace = createWorkspace({ userDir: join(dataDir, "users", String(id)), key: deriveUserKey(masterKey, id), ownerUserId: id, readOnly: true, backgroundTasks: false, dependencies: {
      hostingerPool, mailTransport: () => transport,
      triageCaller: async () => { throw new Error("restore probe must not invoke model"); },
      mailTranslate: async () => { throw new Error("restore probe must not translate"); },
    } });
    workspaces.set(id, workspace); return workspace;
  },
  get(id) { return workspaces.get(id); },
  async close(id) { const workspace = workspaces.get(id); if (workspace) { await workspace.close(); workspaces.delete(id); } },
  async closeAll() { for (const [id] of [...workspaces]) await manager.close(id); },
};
const originalFetch = globalThis.fetch;
let origin: string | null = null, prohibitedExternalRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!origin || url.origin !== origin) { prohibitedExternalRequests++; throw new Error(`restore probe blocked ${url.origin}`); }
  return originalFetch(input, init);
};
const app = await createApp({ dataDir, distDir: resolve(import.meta.dirname, "../dist"), workspaceManager: manager, masterKey, env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "not-used-restored", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, logger: { log() {}, warn() {}, error() {} } });
try {
  await new Promise<void>((resolveListen, reject) => app.server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("restored app did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  const login = await originalFetch(`${origin}/api/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "website-gen" }, body: JSON.stringify({ username: "admin", password: "admin changed fixture password" }) });
  if (login.status !== 200) throw new Error(`restored login status ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0]; if (!cookie) throw new Error("restored login missing cookie");
  const getJson = async (path: string) => { const response = await originalFetch(`${origin}${path}`, { headers: { Cookie: cookie } }); if (!response.ok) throw new Error(`${path} status ${response.status}`); return response.json() as Promise<Record<string, unknown>>; };
  let rpcId = 0;
  const rpc = async (method: string, params?: unknown) => { const response = await originalFetch(`${origin}/api/rpc`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "website-gen", Cookie: cookie }, body: JSON.stringify({ id: ++rpcId, method, params }) }); const body = await response.json() as { ok: boolean; result?: unknown; error?: string }; if (!response.ok || !body.ok) throw new Error(body.error ?? `${method} failed`); return body.result; };
  const me = (await getJson("/api/me")).user as { id: number; role: string; mustChangePassword: boolean };
  const roles = await rpc("models.roles") as Array<{ role: string; modelId: string }>;
  const settings = await rpc("mail.triage.settings") as { state: string };
  const board = await rpc("mail.cases.list", { page: 1, pageSize: 100 }) as { total: number };
  const cached = await rpc("mail.message", { mailboxId: 1, folder: "Sent Messages", uid: 11 }) as { subject: string };
  let disabledCaseFailClosed = false;
  try { await rpc("mail.cases.detail", { caseId: process.env.MAIL_TRIAGE_DECLINED_CASE_ID }); }
  catch (error) { disabledCaseFailClosed = /未授权来源|source/i.test(String(error)); }
  if (prohibitedExternalRequests !== 0) throw new Error("restore probe attempted external request");
  writeFileSync(outputPath, JSON.stringify({ userId: me.id, role: me.role, mustChangePassword: me.mustChangePassword, roleBinding: roles.find(item => item.role === "mail_triage")?.modelId ?? "", triageState: settings.state, caseCount: board.total, cachedSubject: cached.subject, disabledCaseFailClosed, prohibitedExternalRequests }));
} finally {
  app.server.closeAllConnections?.();
  await app.close().catch(() => {});
  globalThis.fetch = originalFetch;
}
