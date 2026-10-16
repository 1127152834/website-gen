import assert from "node:assert/strict";
import test from "node:test";
import { GristError, gristClient, normalizeGristBaseUrl, assertGristBaseUrl } from "./grist.ts";

const publicBase = "https://8.8.8.8";

function fakeFetch(body: unknown = {}, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test("Grist 客户端编码 URL、发送 Bearer 认证、JSON 请求头、超时信号且拒绝重定向", async () => {
  const fake = fakeFetch({ records: [{ id: 1, fields: { Name: "Alice" } }] });
  const client = gristClient({ baseUrl: `${publicBase}///`, apiKey: "test-key", fetch: fake.fetch });
  const result = await client.listRecords("doc /?", "People /?", {
    filter: { Name: ["Alice & Bob"] }, sort: "-Name,id", limit: 1000,
  });
  const call = fake.calls[0]!;
  const url = new URL(call.url);
  assert.equal(url.pathname, "/api/docs/doc%20%2F%3F/tables/People%20%2F%3F/records");
  assert.equal(url.searchParams.get("filter"), JSON.stringify({ Name: ["Alice & Bob"] }));
  assert.equal(url.searchParams.get("sort"), "-Name,id");
  assert.equal(url.searchParams.get("limit"), "1000");
  assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer test-key");
  assert.equal(new Headers(call.init.headers).get("Accept"), "application/json");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.redirect, "error");
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(result.records[0], { id: 1, fields: { Name: "Alice" } });
});

test("Grist 发现方法与 REST 层级对应，文档列表从工作空间响应提取", async () => {
  const fake = fakeFetch({ docs: [{ id: "doc1", name: "项目" }] });
  const client = gristClient({ baseUrl: `${publicBase}/grist/`, apiKey: "key", fetch: fake.fetch });
  await client.getUserProfile();
  await client.listOrgs();
  await client.listWorkspaces(3);
  assert.deepEqual(await client.listDocs(7), [{ id: "doc1", name: "项目" }]);
  await client.getDocInfo("doc1");
  await client.getTables("doc1");
  await client.getTableColumns("doc1", "People");
  await client.listSnapshots("doc1");
  await client.listAttachments("doc1");
  assert.deepEqual(fake.calls.map(({ url }) => new URL(url).pathname), [
    "/grist/api/session/access/active", "/grist/api/orgs", "/grist/api/orgs/3/workspaces",
    "/grist/api/workspaces/7", "/grist/api/docs/doc1", "/grist/api/docs/doc1/tables",
    "/grist/api/docs/doc1/tables/People/columns", "/grist/api/docs/doc1/snapshots", "/grist/api/docs/doc1/attachments",
  ]);
});

test("Grist 增改删记录采用官方 records 信封和删除 ID 数组", async () => {
  const fake = fakeFetch(undefined);
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
  await client.addRecords("d", "People", [{ fields: { Name: "Alice", Date: 1_728_950_400 } }]);
  await client.updateRecords("d", "People", [{ id: 2, fields: { Active: false } }]);
  await client.removeRecords("d", "People", [2, 3]);
  assert.deepEqual(fake.calls.map(({ url, init }) => ({
    path: new URL(url).pathname, method: init.method, body: JSON.parse(String(init.body)),
    contentType: new Headers(init.headers).get("Content-Type"),
  })), [
    { path: "/api/docs/d/tables/People/records", method: "POST", body: { records: [{ fields: { Name: "Alice", Date: 1_728_950_400 } }] }, contentType: "application/json" },
    { path: "/api/docs/d/tables/People/records", method: "PATCH", body: { records: [{ id: 2, fields: { Active: false } }] }, contentType: "application/json" },
    { path: "/api/docs/d/tables/People/records/delete", method: "POST", body: [2, 3], contentType: "application/json" },
  ]);
});

test("Grist 文档、表和列结构写入使用 REST 信封；重命名/删除表使用用户动作", async () => {
  const fake = fakeFetch(undefined);
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
  const column = { id: "Name", fields: { type: "Text", label: "姓名" } };
  await client.createDoc(7, "客户");
  await client.createTable("d", "People", [column]);
  await client.addTableColumn("d", "People", column);
  await client.updateTableColumn("d", "People", "Name", { label: "客户姓名" });
  await client.renameTable("d", "People", "Clients");
  await client.removeTable("d", "Clients");
  await client.removeTableColumn("d", "People", "Name /?");
  assert.deepEqual(fake.calls.map(({ url, init }) => [
    new URL(url).pathname, init.method, init.body ? JSON.parse(String(init.body)) : null,
  ]), [
    ["/api/workspaces/7/docs", "POST", { name: "客户" }],
    ["/api/docs/d/tables", "POST", { tables: [{ id: "People", columns: [column] }] }],
    ["/api/docs/d/tables/People/columns", "POST", { columns: [column] }],
    ["/api/docs/d/tables/People/columns", "PATCH", { columns: [{ id: "Name", fields: { label: "客户姓名" } }] }],
    ["/api/docs/d/apply", "POST", [["RenameTable", "People", "Clients"]]],
    ["/api/docs/d/apply", "POST", [["RemoveTable", "Clients"]]],
    ["/api/docs/d/tables/People/columns/Name%20%2F%3F", "DELETE", null],
  ]);
});

test("Grist SQL 仅接受一个 SELECT，参数通过 JSON 传递，字符串内的分号不算多语句", async () => {
  const fake = fakeFetch({ statement: "SELECT * FROM People WHERE Name = ?", records: [] });
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
  await client.queryDocument("d", "SELECT * FROM People WHERE Name = ?", ["Alice"]);
  assert.deepEqual(JSON.parse(String(fake.calls[0]!.init.body)), { sql: "SELECT * FROM People WHERE Name = ?", args: ["Alice"] });
  await client.queryDocument("d", "select ';' AS value");
  for (const sql of ["DELETE FROM People", "SELECT * FROM People; DELETE FROM People", "PRAGMA table_info(People)", "WITH t AS (SELECT 1) SELECT * FROM t", "SELECT 1;", "-- comment\nDELETE FROM People", "SELECT 'unterminated"]) {
    await assert.rejects(client.queryDocument("d", sql), /SELECT|SQL/);
  }
  assert.equal(fake.calls.length, 2);
});

test("Grist HTTP 错误含中文、状态码及服务端 error，认证错误给明确提示", async () => {
  for (const status of [401, 403, 404, 500]) {
    const fake = fakeFetch({ error: "denied by Grist" }, status);
    const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
    await assert.rejects(client.listOrgs(), (error: Error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /denied by Grist/);
      if (status === 401 || status === 403) assert.match(error.message, /API Key 无效或没有权限/);
      return true;
    });
  }
});

test("Grist HTML 401/403 提示防火墙和服务器代理，而不是误报 API Key 无效", async () => {
  for (const status of [401, 403]) {
    const client = gristClient({ baseUrl: publicBase, apiKey: "secret-key", fetch: async () => new Response(
      "<html><head><title>Attention Required! | Cloudflare</title></head><body>secret-key</body></html>",
      { status, statusText: status === 403 ? "Forbidden" : "Unauthorized", headers: { "Content-Type": "text/html", server: "cloudflare", "cf-ray": "test-ray" } },
    ) });
    await assert.rejects(client.listOrgs(), (error: Error) => {
      assert.ok(error instanceof GristError);
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.match(error.message, /网页|非 JSON/);
      assert.match(error.message, /防火墙.*Cloudflare/);
      assert.match(error.message, /本服务器.*网络出口/);
      assert.match(error.message, /不是 API Key 的问题/);
      assert.match(error.message, /服务器网络或代理设置.*部署文档/);
      assert.doesNotMatch(error.message, /API Key 无效或没有权限|secret-key|<html>/);
      return true;
    });
  }
});

test("Grist JSON 401/403 没有 API error 时不臆断 Key 无效", async () => {
  for (const status of [401, 403]) {
    for (const body of [{ message: "proxy denied" }, null]) {
      const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fakeFetch(body, status).fetch });
      await assert.rejects(client.listOrgs(), (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /API Key 无效或没有权限|防火墙/);
        return true;
      });
    }
  }
});

test("Grist 非 JSON 响应、网络失败和超时均转换成可读错误，不泄露 API Key", async () => {
  const malformed = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async () => new Response("<html>oops</html>") });
  await assert.rejects(malformed.listOrgs(), /Grist.*JSON/);
  const network = gristClient({ baseUrl: publicBase, apiKey: "secret-key", fetch: async () => { throw new Error("failed secret-key"); } });
  await assert.rejects(network.listOrgs(), (error: Error) => {
    assert.match(error.message, /Grist.*失败/);
    assert.doesNotMatch(error.message, /secret-key/);
    return true;
  });
  const timeout = gristClient({ baseUrl: publicBase, apiKey: "key", timeoutMs: 10, fetch: async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }) });
  await assert.rejects(timeout.listOrgs(), /Grist.*超时/);
});

test("Grist 地址只允许 HTTP(S)，拒绝凭据、查询和片段，去除末尾斜杠", () => {
  assert.equal(normalizeGristBaseUrl(" https://example.com/grist/// "), "https://example.com/grist");
  for (const url of ["ftp://example.com", "file:///etc/passwd", "not-a-url", "https://u:p@example.com", "https://example.com?key=a", "https://example.com/#x"]) {
    assert.throws(() => normalizeGristBaseUrl(url), /Grist.*地址/);
  }
});

test("Grist 每个请求都检查 SSRF，拒绝私网和 IPv6 映射回环，即使模型允许私网", async () => {
  const previous = process.env.ALLOW_PRIVATE_MODEL_HOSTS;
  process.env.ALLOW_PRIVATE_MODEL_HOSTS = "1";
  try {
    for (const baseUrl of ["http://127.0.0.1", "http://localhost", "http://10.1.2.3", "http://172.20.1.1", "http://192.168.1.3", "http://169.254.169.254", "http://[::1]", "http://[fd00::1]", "http://[::ffff:127.0.0.1]", "http://2130706433"]) {
      const fake = fakeFetch();
      const client = gristClient({ baseUrl, apiKey: "key", fetch: fake.fetch });
      await assert.rejects(client.listOrgs(), /Grist.*(本机|内网)/, baseUrl);
      assert.equal(fake.calls.length, 0);
    }
    await assertGristBaseUrl(publicBase);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_MODEL_HOSTS;
    else process.env.ALLOW_PRIVATE_MODEL_HOSTS = previous;
  }
});

test("Grist 拒绝能改变 REST 路径的点段标识符，以及无效 limit", async () => {
  const fake = fakeFetch();
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
  for (const id of ["", ".", "..", "\u0000"]) await assert.rejects(client.getTables(id), /标识符/);
  for (const limit of [0, -1, 1.5, Infinity]) await assert.rejects(client.listRecords("d", "People", { limit }), /limit/);
  assert.equal(fake.calls.length, 0);
});

test("Grist 附件列表通过 REST limit 限制读取数量", async () => {
  const fake = fakeFetch({ records: [] });
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: fake.fetch });
  await client.listAttachments("doc", { limit: 100 });
  assert.equal(fake.calls[0]!.url, `${publicBase}/api/docs/doc/attachments?limit=100`);
  for (const limit of [0, -1, 1.5, Infinity]) await assert.rejects(client.listAttachments("doc", { limit }), /limit/);
  assert.equal(fake.calls.length, 1);
});

test("Grist 附件下载保留响应流而不整包读取", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array([1])); controller.close(); } }, { highWaterMark: 0 });
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(body, { headers: { "Content-Type": "application/pdf", "Content-Length": "1" } });
  } });
  const response = await client.downloadAttachment("doc", 12);
  assert.equal(pulled, 0);
  assert.equal(new URL(calls[0]!.url).pathname, "/api/docs/doc/attachments/12/download");
  assert.equal(calls[0]!.init?.redirect, "error");
  assert.equal(new Headers(calls[0]!.init?.headers).get("Authorization"), "Bearer key");
  assert.equal(new Headers(calls[0]!.init?.headers).get("Accept-Encoding"), "identity");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1]);
  assert.equal(pulled, 1);
  await assert.rejects(client.downloadAttachment("doc", 0), /附件 ID/);
});

test("Grist 记录读取把外部取消信号传给 fetch", async () => {
  let fetchSignal: AbortSignal | undefined;
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async (_input, init) => {
    fetchSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  } });
  const controller = new AbortController();
  const pending = client.listRecords("d", "T", { limit: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("aggregate failed"));
  await assert.rejects(pending, /取消/);
  assert.equal(fetchSignal?.aborted, true);
});

test("Grist 根据 Content-Length 提前拒绝超限成功/错误响应，不读取正文且取消请求", async () => {
  for (const [status, cap] of [[200, 16 * 1024 * 1024], [401, 64 * 1024]] as const) {
    let pulls = 0, cancels = 0;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls > 1) controller.close(); else controller.enqueue(new Uint8Array(1)); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async (_input, init) => {
      requestSignal = init?.signal;
      return new Response(body, { status, headers: { "Content-Length": String(cap + 1) } });
    } });
    await assert.rejects(client.listOrgs(), (error: Error) => {
      assert.match(error.message, /Grist.*响应.*超/);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /超时/);
      assert.doesNotMatch(error.message, /API Key 无效或没有权限/);
      return true;
    });
    assert.equal(pulls, 0);
    assert.equal(cancels, 1);
    assert.equal(requestSignal?.aborted, true);
  }
});

test("Grist 按实际流字节数限制成功/错误正文，忽略缺失或伪造的小 Content-Length", async () => {
  for (const [status, cap, declaredLength] of [[200, 16 * 1024 * 1024, null], [403, 64 * 1024, "1"]] as const) {
    let pulls = 0, cancels = 0;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls > 2) controller.close(); else controller.enqueue(new Uint8Array(cap / 2 + 1)); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async (_input, init) => {
      requestSignal = init?.signal;
      return new Response(body, { status, headers: declaredLength ? { "Content-Length": declaredLength } : {} });
    } });
    await assert.rejects(client.listOrgs(), (error: Error) => {
      assert.match(error.message, /Grist.*响应.*超/);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /超时/);
      assert.doesNotMatch(error.message, /API Key 无效或没有权限/);
      return true;
    });
    assert.equal(pulls, 2, "超限后不继续读取流");
    assert.equal(cancels, 1);
    assert.equal(requestSignal?.aborted, true);
  }
});

test("Grist 流式读取保持 UTF-8 JSON，成功空正文可用，正文超时也立即取消 reader", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify([{ id: 1, name: "表格" }]));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  }, { highWaterMark: 0 });
  const client = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async () => new Response(body) });
  assert.deepEqual(await client.listOrgs(), [{ id: 1, name: "表格" }]);
  const empty = gristClient({ baseUrl: publicBase, apiKey: "key", fetch: async () => new Response(null) });
  assert.equal(await empty.updateRecords("d", "T", []), undefined);

  let cancels = 0;
  const pending = new ReadableStream<Uint8Array>({ cancel() { cancels++; } }, { highWaterMark: 0 });
  const timeout = gristClient({ baseUrl: publicBase, apiKey: "key", timeoutMs: 10, fetch: async () => new Response(pending) });
  await assert.rejects(timeout.listOrgs(), /Grist.*超时/);
  assert.equal(cancels, 1);
});
