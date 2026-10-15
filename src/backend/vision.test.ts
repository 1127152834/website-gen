import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildVisionUserContent } from "./vision.ts";

test("vision builds native pi-ai text and image content from a bounded local file", async () => {
  const dir = join(process.cwd(), ".phase3-backup", "test-tmp");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "vision-native-content.png");
  await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  try {
    const content = await buildVisionUserContent("Inspect", [{ name: "home", file }]);
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image");
    if (content[1].type === "image") {
      assert.equal(content[1].mimeType, "image/png");
      assert.equal(content[1].data, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"));
    }
  } finally {
    await rm(file, { force: true });
  }
});

test("vision rejects oversized URL images before reading the body", async () => {
  let pulled = false;
  const fakeFetch = (async () => ({
    ok: true, status: 200,
    headers: new Headers({ "content-type": "image/png", "content-length": String(13 * 1024 * 1024) }),
    get body() { pulled = true; return new ReadableStream(); },
  })) as unknown as typeof fetch;
  await assert.rejects(buildVisionUserContent("Inspect", [{ name: "large", url: "https://images.test/large.png" }], fakeFetch), /12 MB/);
  assert.equal(pulled, false);
});
