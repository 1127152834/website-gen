import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tables page embeds configured baseUrl with the required iframe permissions and empty state", async () => {
  const source = await readFile(new URL("./tables.tsx", import.meta.url), "utf8");
  assert.match(source, /const baseUrl = settingsState\.data\?\.baseUrl\.trim\(\) \?\? ""/);
  assert.doesNotMatch(source, /settingsState\.data\?\.configured|settings\?\.configured/);
  assert.match(source, /if \(!baseUrl\)/);
  assert.match(source, /前往设置 Grist/);
  assert.match(source, /useEffect\(\(\) => stopPopupPoll, \[baseUrl, stopPopupPoll\]\)/);
  assert.match(source, /const login = \(\) => \{\s*stopPopupPoll\(\);/);
  assert.match(source, /watchGristPopupClosed\(popup/);
  assert.match(source, /src=\{baseUrl\}/);
  assert.match(source, /title="Grist 表格"/);
  assert.match(source, /allow="clipboard-read; clipboard-write"/);
  assert.match(source, /referrerPolicy="strict-origin-when-cross-origin"/);
  assert.doesNotMatch(source, /<iframe[^>]*\ssandbox=/s);
});

test("tables layout consumes remaining height without page-level horizontal scrolling", async () => {
  const [page, layout, main, route] = await Promise.all([
    readFile(new URL("./tables.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/layout/authenticated-layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../components/layout/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../routes/_authenticated.tables.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /flex h-full min-h-0 min-w-0 flex-col overflow-hidden/);
  assert.match(page, /min-h-0 min-w-0 w-full flex-1/);
  assert.match(layout, /const isTables\s*=\s*location\.pathname === '\/tables' \|\| location\.pathname === '\/tables\/'/);
  assert.match(layout, /className=\{isTables \? 'h-svh min-h-0 overflow-hidden' : undefined\}/);
  assert.match(layout, /<SidebarInset className="min-h-0 min-w-0">/);
  assert.match(layout, /<Main fullBleed=\{isTables\}>/);
  assert.match(main, /fullBleed\s*\?\s*'flex min-h-0 flex-col overflow-hidden'/);
  assert.match(route, /<TablesPage onNavigate=\{go\}/);
  assert.doesNotMatch(route, /userId|useSession/);
});
