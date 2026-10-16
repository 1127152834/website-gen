import { test } from "node:test";
import assert from "node:assert/strict";
import { siteFetch } from "./site-fetch.ts";

const netError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });

// 实测 2026-10-16：整站复核取数据时一次「fetch failed」就让整轮复核中止，且看不出是哪个接口、什么原因
test("GET retries transient network errors; writes do not; errors name the path and the cause", async () => {
  let calls = 0;
  const flaky = (async () => { if (++calls < 3) throw netError(); return new Response("[]"); }) as typeof fetch;
  const res = await siteFetch(flaky, "https://shop.test/wp-json/wp/v2/pages", { method: "GET" }, [0, 0]);
  assert.equal(await res.text(), "[]");
  assert.equal(calls, 3);

  let writes = 0;
  const broken = (async () => { writes++; throw netError(); }) as typeof fetch;
  await assert.rejects(siteFetch(broken, "https://shop.test/wp-json/wc/v3/products/1", { method: "PUT" }, [0, 0]), (e: Error) => {
    assert.match(e.message, /PUT .*wc\/v3\/products\/1/);
    assert.match(e.message, /ECONNRESET|socket hang up/);
    return true;
  });
  assert.equal(writes, 1, "writes must not be retried (the server may have applied them)");
});
