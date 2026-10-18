import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { before, beforeEach, test } from "node:test";
import { runInThisContext } from "node:vm";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { build } from "vite";

type BuildItem = { type: "chunk"; isEntry: boolean; code: string } | { type: "asset"; fileName: string };
type NewBatchPageProps = { onCreated: (batchId: number) => void };
type SiteMailboxFieldProps = { index: number; domain: string; value: string; onChange: (value: string) => void; error?: string };

const root = process.cwd();
const rendererSource = path.join(root, "src/renderer/src");
const entryFile = path.join(rendererSource, "features/new-batch/index.tsx");
const virtualBackend = "\0website-gen-new-batch-test-backend";
const bundleFilename = path.join(root, "src/renderer/.migration/new-batch-page-test-bundle.cjs");
const rpcRequests: string[] = [];
let mailboxState: { data?: unknown; error?: Error | null; loading?: boolean; refreshing?: boolean } = {};
const requireFromTest = createRequire(import.meta.url);

(globalThis as Record<string, unknown>).__newBatchPageRpcRequests = rpcRequests;
(globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;

let NewBatchPage: ComponentType<NewBatchPageProps>;
let SiteMailboxField: ComponentType<SiteMailboxFieldProps>;

before(async () => {
  const result = await build({
    configFile: false,
    envDir: false,
    root,
    logLevel: "silent",
    plugins: [
      {
        name: "website-gen-new-batch-test-backend",
        enforce: "pre",
        resolveId(id) {
          const normalized = id.replaceAll("\\", "/");
          if (id === "@/lib/backend" || id === "@/lib/backend.ts" || normalized.endsWith("/src/renderer/src/lib/backend.ts")) return virtualBackend;
          return null;
        },
        load(id) {
          if (id !== virtualBackend) return null;
          return `
            const requests = globalThis.__newBatchPageRpcRequests;
            export function useRpcData(method) {
              requests.push(method);
              if (method === "domains.mailboxes") {
                const state = globalThis.__newBatchMailboxState;
                return {
                  data: state.data,
                  error: state.error ?? null,
                  refreshing: state.refreshing ?? false,
                  loading: state.loading ?? false,
                  refresh: async () => state.data,
                  invalidate: () => undefined,
                };
              }
              const data = method === "domains.free"
                ? [{ domain: "unused-example.com", accountId: 1, accountLabel: "测试账号" }]
                : method === "templates.list" ? [] : undefined;
              return {
                data,
                error: null,
                refreshing: false,
                loading: false,
                refresh: async () => data,
                invalidate: () => undefined,
              };
            }
            export async function call() { throw new Error("SSR 回归不应执行写入 RPC"); }
          `;
        },
      },
      react(),
    ],
    resolve: { alias: [{ find: /^@\//, replacement: `${rendererSource.replaceAll("\\", "/")}/` }] },
    build: {
      write: false,
      ssr: entryFile,
      rollupOptions: {
        external: (id) => !id.startsWith(".") && !path.isAbsolute(id) && !id.startsWith("@/") && !id.startsWith("\0"),
        output: { format: "cjs", exports: "named" },
      },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: BuildItem[] };
  const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert.ok(entry && entry.type === "chunk", "Vite should emit the new-batch page as an in-memory SSR entry chunk");

  const pageModule: { exports: Record<string, unknown> } = { exports: {} };
  const wrapper = runInThisContext(`(function (exports, require, module, __filename, __dirname) { ${entry.code}\n})`, { filename: bundleFilename }) as (
    exports: Record<string, unknown>, require: NodeJS.Require, module: typeof pageModule, filename: string, dirname: string,
  ) => void;
  wrapper(pageModule.exports, requireFromTest, pageModule, bundleFilename, path.dirname(bundleFilename));
  NewBatchPage = pageModule.exports.NewBatchPage as ComponentType<NewBatchPageProps>;
  SiteMailboxField = pageModule.exports.SiteMailboxField as ComponentType<SiteMailboxFieldProps>;
});

beforeEach(() => {
  rpcRequests.length = 0;
  mailboxState = {};
  (globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;
});

function renderPage(): string {
  return renderToStaticMarkup(createElement(NewBatchPage, { onCreated: () => undefined }));
}

test("建站向导直接显示经营主体录入且不显示复用模板控件", () => {
  const html = renderPage();

  for (const removedText of ["主体模板", "复用经营主体模板", "选择模板", "模板名称", "保存为模板", "管理已保存的模板"]) {
    assert.doesNotMatch(html, new RegExp(removedText), removedText);
  }
  assert.doesNotMatch(html, /客服邮箱/);
  assert.doesNotMatch(html, /support@域名/);
  for (const retainedText of ["经营主体", "主体类型", "公司法定名称", "地址", "客服电话", "发货时效（工作日）", "站点", "确认", "下一步"]) {
    assert.match(html, new RegExp(retainedText), retainedText);
  }
});

test("建站向导首屏只查询可用域名而不查询经营主体模板", () => {
  renderPage();

  assert.deepEqual(rpcRequests, ["domains.free"]);
});

test("站点邮箱组件明确显示加载、失败和未申请门禁", () => {
  const renderMailbox = () => renderToStaticMarkup(createElement(SiteMailboxField, { index: 0, domain: "example.com", value: "", onChange: () => undefined }));

  mailboxState = { loading: true };
  (globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;
  assert.match(renderMailbox(), /正在读取该站点的邮箱/);

  mailboxState = { error: new Error("remote failed") };
  (globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;
  assert.match(renderMailbox(), /邮箱读取失败，不能继续建站/);
  assert.match(renderMailbox(), /重试读取/);

  mailboxState = { data: { domain: "example.com", accountId: 1, mailboxes: [], defaultEmail: null } };
  (globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;
  const emptyHtml = renderMailbox();
  assert.match(emptyHtml, /还没有邮箱/);
  assert.match(emptyHtml, /Hostinger hPanel/);
  assert.match(emptyHtml, /重新获取/);
});

test("站点邮箱组件展示服务端确认的默认邮箱", () => {
  mailboxState = { data: { domain: "example.com", accountId: 1, mailboxes: [{ address: "support@example.com" }], defaultEmail: "support@example.com" } };
  (globalThis as Record<string, unknown>).__newBatchMailboxState = mailboxState;
  const html = renderToStaticMarkup(createElement(SiteMailboxField, { index: 0, domain: "example.com", value: "support@example.com", onChange: () => undefined }));
  assert.match(html, /客服邮箱/);
  assert.match(html, /support@example\.com/);
  assert.match(html, /重新获取/);
});
