import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { before, test } from "node:test";
import { runInThisContext } from "node:vm";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, type AnyRoute } from "@tanstack/react-router";
import react from "@vitejs/plugin-react";
import { build } from "vite";

type TestUser = { id: number; username: string; role: "admin" | "user"; mustChangePassword: boolean } | null;
type SessionModule = { setRouteTestUser: (user: TestUser) => void };
type BuildItem = { type: "chunk"; isEntry: boolean; code: string } | { type: "asset"; fileName: string };

const root = process.cwd();
const rendererSource = path.join(root, "src/renderer/src");
const virtualSession = "\0website-gen-route-test-session";
const bundleFilename = path.join(root, "src/renderer/.migration/router-runtime-test-bundle.cjs");
const sessionState: { user: TestUser; epoch: number } = { user: null, epoch: 0 };
(globalThis as Record<string, unknown>).__routeTestSessionState = sessionState;
let routeTree: AnyRoute;
let mockedSession: SessionModule;
let bundleCode: string;
const requireFromTest = createRequire(import.meta.url);

function evaluateRouteBundle(): { routeTree: AnyRoute } {
  const routeModule: { exports: Record<string, unknown> } = { exports: {} };
  const wrapper = runInThisContext(`(function (exports, require, module, __filename, __dirname) { ${bundleCode}\n})`, { filename: bundleFilename }) as (
    exports: Record<string, unknown>, require: NodeJS.Require, module: typeof routeModule, filename: string, dirname: string,
  ) => void;
  wrapper(routeModule.exports, requireFromTest, routeModule, bundleFilename, path.dirname(bundleFilename));
  return routeModule.exports as { routeTree: AnyRoute };
}

before(async () => {
  const result = await build({
    configFile: false,
    envDir: false,
    root,
    logLevel: "silent",
    plugins: [
      {
        name: "website-gen-route-test-session",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:website-gen-route-test-session") return virtualSession;
          if (id === "@/lib/session" || id === "@/lib/session.ts") return virtualSession;
          if (id === "./session" || id === "./session.ts") return virtualSession;
          return null;
        },
        load(id) {
          if (id !== virtualSession) return null;
          return `
            const state = globalThis.__routeTestSessionState;
            export const session = {
              snapshot: () => ({ user: state.user, epoch: state.epoch, checked: true, verifying: false }),
              subscribe: () => () => undefined,
              set: (next) => { state.user = next; state.epoch++; },
              suspend: () => undefined,
              ensure: async () => state.user,
            };
          `;
        },
      },
      react(),
    ],
    resolve: { alias: [{ find: /^@\//, replacement: `${rendererSource.replaceAll("\\", "/")}/` }] },
    build: {
      write: false,
      ssr: path.join(rendererSource, "routeTree.gen.ts"),
      rollupOptions: {
        external: (id) => !id.startsWith(".") && !path.isAbsolute(id) && !id.startsWith("@/") && !id.startsWith("\0"),
        output: { format: "cjs", exports: "named" },
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: BuildItem[] };
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert.ok(entry && entry.type === "chunk", "Vite should emit the generated route tree as one SSR entry chunk");
  bundleCode = entry.code;
  ({ routeTree } = evaluateRouteBundle());
  mockedSession = { setRouteTestUser: (next) => { sessionState.user = next; sessionState.epoch++; } };
});

const user = (role: "admin" | "user" = "user", mustChangePassword = false): TestUser => ({ id: role === "admin" ? 1 : 2, username: role, role, mustChangePassword });

async function load(url: string, currentUser: TestUser) {
  mockedSession.setRouteTestUser(currentUser);
  ({ routeTree } = evaluateRouteBundle());
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
    context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
    defaultPendingMs: 0,
  });
  await router.load();
  return router;
}

test("generated TanStack route tree loads every bookmarkable console URL", async () => {
  const urls = [
    "/", "/new", "/batches/12", "/sites/12", "/sites/12/overview", "/sites/12/chat", "/sites/12/mail", "/sites/12/changes", "/sites/12/qa",
    "/mail/7/Sent%20Messages/42", "/tables", "/settings", "/users",
  ];
  for (const url of urls) {
    const router = await load(url, user("admin"));
    assert.equal(router.state.location.pathname, decodeURIComponent(new URL(url, "http://test.local").pathname), url);
    assert.equal(router.state.matches.some((match) => match.status === "notFound"), false, url);
  }
});

test("generated route guards redirect guests, forced-password users and non-admin users", async () => {
  const guest = await load("/sites/12/qa", null);
  assert.equal(guest.state.redirect?.options.href, "/login?next=%2Fsites%2F12%2Fqa");

  const forced = await load("/batches/12", user("user", true));
  assert.equal(forced.state.redirect?.options.href, "/change-password?next=%2Fbatches%2F12");

  const forbidden = await load("/users", user("user"));
  assert.equal(forbidden.state.redirect?.options.href, "/errors/403");

  const admin = await load("/users", user("admin"));
  assert.equal(admin.state.location.pathname, "/users");
  assert.equal(admin.state.redirect, undefined);
});

test("generated routes reject invalid identifiers and unknown site tabs as 404", async () => {
  for (const url of ["/sites/0/chat", "/sites/2/delete", "/batches/0", "/mail/0/INBOX", "/mail/2/INBOX/0", "/mail/2/INBOX/not-a-number", "/other"]) {
    const router = await load(url, user("admin"));
    assert.equal(router.state.matches.some((match) => match.status === "notFound") || router.state.statusCode === 404, true, url);
    if (url.startsWith("/mail/")) {
      assert.equal(router.state.statusCode, 404, url);
      const notFoundMatches = router.state.matches.filter((match) => match.status === "notFound");
      assert.equal(notFoundMatches.length, 1, `${url} should have one not-found owner`);
      assert.equal((notFoundMatches[0]?.error as { routeId?: string } | undefined)?.routeId, "__root__", `${url} should resolve through the root not-found boundary`);
    }
  }
});

test("mail folder index and message reader share the generated folder parent without remount warnings", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const router = await load("/mail/7/Sent%20Messages", user("admin"));
    const folderParent = router.state.matches.find((match) => match.routeId.endsWith("/mail/$mailboxId/$folder"))?.routeId;
    assert.ok(folderParent);
    await router.navigate({ to: "/mail/$mailboxId/$folder/$uid", params: { mailboxId: "7", folder: "Sent Messages", uid: "42" } });
    await router.load();
    assert.equal(router.state.matches.some((match) => match.routeId === folderParent), true);
    assert.deepEqual(warnings.filter((args) => /remount|outlet|route match/i.test(args.map(String).join(" "))), []);
  } finally { console.warn = originalWarn; }
});
