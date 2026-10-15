import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkspace } from "./index.ts";

test("new workspaces and deliberately emptied workspaces do not auto-seed DeepSeek", async () => {
  const prefix = resolve(tmpdir(), "website-gen-provider-workspace-");
  const dir = mkdtempSync(prefix), key = randomBytes(32);
  let workspace = createWorkspace({ userDir: dir, key });
  try {
    assert.deepEqual(await workspace.handlers["models.providers"](undefined), []);
    const providers = await workspace.handlers["models.create"]({ name: "自建厂商", protocol: "openai", baseUrl: "https://models.example/v1", apiKey: "test-key", models: [] }) as { id: number }[];
    assert.equal(providers.length, 1);
    await workspace.handlers["models.delete"]({ providerId: providers[0].id });
    await workspace.close();
    workspace = createWorkspace({ userDir: dir, key });
    assert.deepEqual(await workspace.handlers["models.providers"](undefined), []);
  } finally {
    await workspace.close();
    if (!resolve(dir).startsWith(prefix)) throw new Error("测试临时目录越界");
    rmSync(dir, { recursive: true, force: true });
  }
});
