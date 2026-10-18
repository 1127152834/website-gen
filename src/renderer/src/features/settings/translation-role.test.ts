import test, { before } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { RoleSummary } from "../../../../shared/protocol.ts";
import type { ProviderDetail } from "./settings-types.ts";

type Node = { type: string | ((props: any) => unknown); props: Record<string, any> };
const entry = fileURLToPath(new URL("./settings.tsx", import.meta.url));
let compiled = "";

before(async () => {
  const bundle = await build({
    configFile: false, envDir: false, logLevel: "silent", oxc: { jsx: { runtime: "automatic" } },
    build: { write: false, minify: false, lib: { entry, formats: ["cjs"] },
      rolldownOptions: { external: (id) => id !== entry && !id.replaceAll("\\", "/").endsWith("/features/settings/settings.tsx") } },
  });
  const result = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in result)) throw new Error("Expected an in-memory settings bundle");
  compiled = result.output.find((output) => output.type === "chunk")!.code;
});

const providers: ProviderDetail[] = [
  { id: 1, name: "通用厂商", protocol: "openai", baseUrl: "https://general.test/v1", hasKey: true, keyHint: "1111",
    models: [{ id: "general", name: "通用模型", vision: false, thinkingLevels: ["off"], contextWindow: 1, maxOutputTokens: 1 }] },
  { id: 2, name: "翻译厂商", protocol: "openai", baseUrl: "https://translation.test/v1", hasKey: true, keyHint: "2222",
    models: [
      { id: "translate-fast", name: "翻译快速", vision: false, thinkingLevels: ["off"], contextWindow: 1, maxOutputTokens: 1 },
      { id: "translate-best", name: "翻译优质", vision: false, thinkingLevels: ["off"], contextWindow: 1, maxOutputTokens: 1 },
    ] },
];

const initialRoles: RoleSummary[] = [
  { role: "agent", providerId: 1, modelId: "general", thinking: "off", ready: true, problem: null },
  { role: "translation", providerId: 0, modelId: "", thinking: "off", ready: false, problem: "尚未配置邮件翻译模型" },
  { role: "mail_triage", providerId: 0, modelId: "", thinking: "off", ready: false, problem: "尚未配置邮件预审模型" },
];

function settingsHarness() {
  const slots: any[] = [], layoutEffects: (() => void)[] = [], requests: { method: string; params: any }[] = [];
  let index = 0, dirty = true, tree: unknown;
  let roles = structuredClone(initialRoles);
  const settingsData = { providers, roles: initialRoles, presets: [] };
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, position) => Object.is(value, b[position])));
  const hooks = {
    useState(initial: any) {
      const id = index++;
      if (!(id in slots)) slots[id] = typeof initial === "function" ? initial() : initial;
      return [slots[id], (update: any) => { slots[id] = typeof update === "function" ? update(slots[id]) : update; dirty = true; }];
    },
    useCallback(fn: unknown, deps?: unknown[]) {
      const id = index++;
      if (!slots[id] || !same(slots[id].deps, deps)) slots[id] = { deps, value: fn };
      return slots[id].value;
    },
    useEffect() { index++; },
    useLayoutEffect(effect: () => void, deps?: unknown[]) {
      const id = index++;
      if (!slots[id] || !same(slots[id].deps, deps)) { slots[id] = { deps }; layoutEffects.push(effect); }
    },
  };
  const backend = {
    async call(method: string, params: any) {
      requests.push({ method, params });
      if (method !== "models.setRole") throw new Error(`Unexpected RPC ${method}`);
      roles = roles.map((role) => role.role === params.role
        ? { ...role, providerId: params.providerId, modelId: params.modelId, thinking: params.thinking, ready: true, problem: null }
        : role);
      return structuredClone(roles);
    },
    useRpcData() {
      return { data: settingsData, loading: false, refreshing: false, error: null,
        refresh: async () => undefined, invalidate() {} };
    },
  };
  const exports: any = {};
  const components = new Proxy({}, { get: (_target, name) => String(name) });
  new Script(compiled, { filename: "settings.tsx" }).runInNewContext({
    exports, console,
    require(name: string) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime") return { jsx: (type: Node["type"], props: Node["props"]) => ({ type, props }), jsxs: (type: Node["type"], props: Node["props"]) => ({ type, props }), Fragment: "Fragment" };
      if (name.includes("/lib/backend")) return backend;
      if (name.includes("/components/feedback")) return { useConfirm: () => async () => true, toast() {} };
      return components;
    },
  });
  const walk = (value: any): Node[] => {
    if (Array.isArray(value)) return value.flatMap(walk);
    if (!value || typeof value !== "object" || !("props" in value)) return [];
    return [value, ...walk(value.props.children)];
  };
  const flush = async () => {
    for (let turn = 0; turn < 10; turn++) {
      if (dirty) { dirty = false; index = 0; tree = exports.SettingsPage({}); }
      for (const effect of layoutEffects.splice(0)) effect();
      await Promise.resolve();
    }
    assert.equal(dirty, false, "settings updates settled");
  };
  const roleTree = () => {
    const roleSection = walk(tree).find((node) => typeof node.type === "function" && node.type.name === "RoleSection");
    assert.ok(roleSection, "RoleSection");
    const renderRoleSection = roleSection.type;
    if (typeof renderRoleSection !== "function") throw new Error("RoleSection is not callable");
    return renderRoleSection(roleSection.props);
  };
  return { requests, flush, nodes: () => walk(roleTree()) };
}

test("邮件翻译用途独立选择厂商和模型且不改动其他用途", async () => {
  const h = settingsHarness();
  await h.flush();
  const nodes = h.nodes();
  assert.ok(nodes.some((node) => node.props.children === "邮件翻译"));
  assert.ok(nodes.some((node) => node.props.children === "邮件主题和正文翻译，独立配置，不使用其他用途的模型"));

  const translationProviderTrigger = nodes.find((node) => node.props["aria-label"] === "邮件翻译的模型厂商");
  assert.ok(translationProviderTrigger, "translation provider control");
  const translationProviderSelect = nodes.find((node) => node.type === "Select" && walkFor(node, translationProviderTrigger));
  assert.ok(translationProviderSelect, "translation provider Select");
  translationProviderSelect.props.onValueChange("2");
  await h.flush();
  assert.deepEqual(structuredClone(h.requests.at(-1)), { method: "models.setRole", params: { role: "translation", providerId: 2, modelId: "translate-fast", thinking: "off" } });

  const updatedNodes = h.nodes();
  const translationModelTrigger = updatedNodes.find((node) => node.props["aria-label"] === "邮件翻译的模型");
  assert.ok(translationModelTrigger, "translation model control");
  const translationModelSelect = updatedNodes.find((node) => node.type === "Select" && walkFor(node, translationModelTrigger));
  assert.ok(translationModelSelect, "translation model Select");
  translationModelSelect.props.onValueChange("translate-best");
  await h.flush();
  assert.deepEqual(structuredClone(h.requests.at(-1)), { method: "models.setRole", params: { role: "translation", providerId: 2, modelId: "translate-best", thinking: "off" } });
  assert.equal(h.requests.some((request) => request.params.role === "agent"), false);
});

test("邮件预审用途进入专用配置页且不复用通用角色绑定控件", async () => {
  const h = settingsHarness();
  await h.flush();
  const nodes = h.nodes();
  assert.ok(nodes.some((node) => node.props.children === "邮件预审"));
  assert.ok(nodes.some((node) => node.type === "a" && node.props.href === "/mail/settings" && node.props.children === "打开专用配置"));
  assert.equal(nodes.some((node) => node.props["aria-label"] === "邮件预审的模型厂商"), false);
  assert.equal(nodes.some((node) => node.props["aria-label"] === "邮件预审的模型"), false);
});

function walkFor(root: Node, target: Node): boolean {
  const children = [root.props.children].flat(Infinity).filter(Boolean) as Node[];
  return children.includes(target) || children.some((child) => child?.props && walkFor(child, target));
}
