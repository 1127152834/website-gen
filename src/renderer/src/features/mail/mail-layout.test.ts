import assert from "node:assert/strict";
import { Script } from "node:vm";
import test, { before } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { TriageStatus } from "../../../../shared/mail-triage-types.ts";
import { getTriageNavigationBadge } from "./mail-triage-client.ts";

const entry = fileURLToPath(new URL("./mail-layout.tsx", import.meta.url));
let compiled = "";

before(async () => {
  const bundle = await build({
    configFile: false,
    envDir: false,
    logLevel: "silent",
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ["cjs"] },
      rolldownOptions: { external: (id) => id !== entry && !id.replaceAll("\\", "/").endsWith("/features/mail/mail-layout.tsx") },
    },
  });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in result)) throw new Error("Expected an in-memory mail layout bundle");
  compiled = result.output.find((output) => output.type === "chunk")!.code;
});

test("R24 MailLayout exposes every companion mail route through a fixed production navigation", () => {
  const exports: { MailLayout?: () => unknown; MAIL_NAV_ITEMS?: Array<{ to: string; label: string }> } = {};
  new Script(compiled, { filename: "mail-layout.tsx" }).runInNewContext({
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") { const element = (type: unknown, props: unknown) => ({ type, props }); return { jsx: element, jsxs: element, Fragment: "Fragment" }; }
      if (name === "@tanstack/react-router") return { Outlet: "Outlet", Link: "Link", useRouterState: () => ({ location: { pathname: "/mail" } }) };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  assert.equal(typeof exports.MailLayout, "function");
  assert.deepEqual(structuredClone(exports.MAIL_NAV_ITEMS), [
    { to: "/mail", label: "申请看板" }, { to: "/mail/inbox", label: "按邮箱" }, { to: "/mail/review", label: "邮件核对" },
    { to: "/mail/notifications", label: "通知邮件" }, { to: "/mail/reminders", label: "本地跟进提醒" }, { to: "/mail/settings", label: "预审设置" }, { to: "/mail/manage", label: "邮箱管理" },
  ]);
});

const status = (patch: Partial<TriageStatus> = {}): TriageStatus => ({
  needsActionCaseCount: 3,
  awaitingCaseCount: 2,
  resultCaseCount: 1,
  unlinkedMailCount: 0,
  unreviewedMailCount: 0,
  failedMailCount: 0,
  openTaskCount: 4,
  auditPendingMailCount: 0,
  dailyAttemptsUsed: 0,
  dailyAttemptLimit: 500,
  enabled: true,
  state: "enabled",
  configEpoch: 1,
  ...patch,
});

test("mail navigation badge counts applications needing action, not unread messages", () => {
  assert.deepEqual(getTriageNavigationBadge(status()), { value: 3, label: "需要处理的申请" });
  assert.equal(getTriageNavigationBadge(status({ enabled: false, state: "disabled" })), undefined);
  assert.equal(getTriageNavigationBadge(undefined), undefined);
});
