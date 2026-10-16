import assert from "node:assert/strict";
import test from "node:test";
import { gristClient } from "./grist.ts";

const publicBase = "https://8.8.8.8";
const apiKey = "retry-secret-key";

function networkError(cause: { code?: string; message?: string } = { code: "ECONNRESET" }) {
  return new TypeError("fetch failed", { cause });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sequenceFetch(...steps: (Response | Error)[]) {
  const calls: { input: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init });
    const step = steps[calls.length - 1];
    if (!step) throw new Error("unexpected fetch call");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function assertNetworkDetail(error: Error, detail: RegExp) {
  assert.match(error.message, /Grist/);
  assert.match(error.message, detail);
  assert.doesNotMatch(error.message, new RegExp(apiKey));
  return true;
}

test("GET 网络层失败会自动重试一次并返回第二次响应", async () => {
  const fake = sequenceFetch(
    networkError(),
    jsonResponse([{ id: 1, name: "Team", domain: null }]),
  );
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  assert.deepEqual(await client.listOrgs(), [{ id: 1, name: "Team", domain: null }]);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map((call) => call.init?.method), ["GET", "GET"]);
});

test("只读 SQL 的网络层失败会自动重试一次", async () => {
  const result = { statement: "SELECT 1", records: [{ fields: { value: 1 } }] };
  const fake = sequenceFetch(networkError(), jsonResponse(result));
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  assert.deepEqual(await client.queryDocument("doc", "SELECT 1"), result);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls.map((call) => call.init?.method), ["POST", "POST"]);
});

test("POST、PATCH、DELETE 写操作遇到网络层失败均不重试", async () => {
  const cases = [
    ["POST", (client: ReturnType<typeof gristClient>) => client.addRecords("doc", "T", [{ fields: { A: 1 } }])],
    ["PATCH", (client: ReturnType<typeof gristClient>) => client.updateRecords("doc", "T", [{ id: 1, fields: { A: 2 } }])],
    ["DELETE", (client: ReturnType<typeof gristClient>) => client.removeTableColumn("doc", "T", "A")],
  ] as const;

  for (const [method, invoke] of cases) {
    const fake = sequenceFetch(networkError());
    const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });
    await assert.rejects(invoke(client), (error: Error) => assertNetworkDetail(error, /ECONNRESET/));
    assert.equal(fake.calls.length, 1, method);
    assert.equal(fake.calls[0]?.init?.method, method);
  }
});

test("HTTP 500 已取得响应，不重试", async () => {
  const fake = sequenceFetch(jsonResponse({ error: "upstream failed" }, 500));
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  await assert.rejects(client.listOrgs(), /HTTP 500/);
  assert.equal(fake.calls.length, 1);
});

test("只读网络错误最多调用两次，并脱敏最终 cause code", async () => {
  const fake = sequenceFetch(
    networkError(),
    networkError({ code: `ECONNRESET-${apiKey}`, message: "socket closed" }),
  );
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  await assert.rejects(client.listOrgs(), (error: Error) => assertNetworkDetail(error, /ECONNRESET/));
  assert.equal(fake.calls.length, 2);
});

test("cause 只有 message 时使用该详情并脱敏", async () => {
  const fake = sequenceFetch(networkError({ message: `proxy reset ${apiKey}` }));
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  await assert.rejects(client.addRecords("doc", "T", []), (error: Error) => assertNetworkDetail(error, /proxy reset/));
  assert.equal(fake.calls.length, 1);
});

test("取消、超时及非网络 TypeError 不重试", async () => {
  const errors = [
    new DOMException("aborted", "AbortError"),
    new DOMException("timed out", "TimeoutError"),
    networkError({ code: "UND_ERR_CONNECT_TIMEOUT" }),
    networkError({ message: "connect timed out" }),
    new TypeError("Invalid URL"),
    new Error("generic failure"),
  ];

  for (const injected of errors) {
    const fake = sequenceFetch(injected);
    const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });
    await assert.rejects(client.listOrgs());
    assert.equal(fake.calls.length, 1, `${injected.name}: ${injected.message}`);
  }
});

test("取得响应后正文流失败不重试", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(networkError()); },
  });
  const fake = sequenceFetch(new Response(body));
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  await assert.rejects(client.listOrgs());
  assert.equal(fake.calls.length, 1);
});

test("附件下载在返回响应前网络失败会重试，且成功响应流保持原样", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array([7])); controller.close(); },
  }, { highWaterMark: 0 });
  const response = new Response(body, { headers: { "Content-Type": "application/octet-stream" } });
  const fake = sequenceFetch(networkError(), response);
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch: fake.fetch });

  const result = await client.downloadAttachment("doc", 3);
  assert.strictEqual(result, response);
  assert.equal(pulls, 0);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [7]);
});

test("附件下载最多重试一次，最终 cause 脱敏；HTTP 500 不重试", async () => {
  const network = sequenceFetch(networkError(), networkError({ message: `socket reset ${apiKey}` }));
  const networkClient = gristClient({ baseUrl: publicBase, apiKey, fetch: network.fetch });
  await assert.rejects(networkClient.downloadAttachment("doc", 3), (error: Error) => assertNetworkDetail(error, /socket reset/));
  assert.equal(network.calls.length, 2);

  const http = sequenceFetch(new Response("failed", { status: 500 }));
  const httpClient = gristClient({ baseUrl: publicBase, apiKey, fetch: http.fetch });
  await assert.rejects(httpClient.downloadAttachment("doc", 3), /HTTP 500/);
  assert.equal(http.calls.length, 1);
});

test("重试等待期间主动取消会阻止第二次 fetch", async () => {
  let releaseFirstCall!: () => void;
  const firstCall = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
  let calls = 0;
  const fetch = (async () => {
    calls++;
    releaseFirstCall();
    throw networkError();
  }) as typeof globalThis.fetch;
  const controller = new AbortController();
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch });

  const pending = client.listRecords("doc", "T", { signal: controller.signal });
  await firstCall;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /取消/);
  assert.equal(calls, 1);
});

test("总超时在重试等待期间到期会阻止第二次 fetch", async () => {
  let calls = 0;
  const fetch = (async () => {
    calls++;
    throw networkError();
  }) as typeof globalThis.fetch;
  const client = gristClient({ baseUrl: publicBase, apiKey, fetch, timeoutMs: 25 });

  await assert.rejects(client.listOrgs(), /超时/);
  assert.equal(calls, 1);
});
