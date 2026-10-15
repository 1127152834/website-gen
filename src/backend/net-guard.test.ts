import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicBaseUrl } from "./net-guard.ts";

const resolveTo = (address: string, family = 4) => async () => [{ address, family }];

test("模型 Base URL 指向本机、内网、链路本地、元数据地址时拒绝", async () => {
  for (const url of ["http://127.0.0.1:11434/v1", "http://[::1]/v1", "http://10.0.0.5/v1", "http://172.20.1.1/v1", "http://192.168.1.9/v1", "http://169.254.169.254/latest", "http://0.0.0.0/v1", "http://[fd00::1]/v1", "http://[::ffff:127.0.0.1]/v1"]) {
    await assert.rejects(assertPublicBaseUrl(url, {}), /内网|本机/, url);
  }
  // 域名解析到内网同样拒绝
  await assert.rejects(assertPublicBaseUrl("https://evil.example/v1", {}, resolveTo("10.1.2.3")), /内网|本机/);
});

test("公网地址放行；部署者显式允许时内网也放行", async () => {
  await assertPublicBaseUrl("https://api.example.com/v1", {}, resolveTo("27.21.228.118"));
  await assertPublicBaseUrl("http://127.0.0.1:11434/v1", { ALLOW_PRIVATE_MODEL_HOSTS: "1" });
});
