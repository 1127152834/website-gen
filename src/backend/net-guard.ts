// 模型厂商的 Base URL 由用户填写、由服务端去请求：拒绝指向本机、内网、链路本地的地址（防 SSRF，例如读云主机元数据）。
// 要接局域网里自建的模型（如 Ollama），部署者设 ALLOW_PRIVATE_MODEL_HOSTS=1。
// ponytail: 只在保存、拉取模型、测试连接时解析一次，挡不住 DNS rebinding；要挡需把连接钉到校验过的 IP。
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]] as const) blocked.addSubnet(net, prefix, "ipv6");

type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

function isBlocked(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return blocked.check(mapped, "ipv4");
  return blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

export async function assertPublicBaseUrl(baseUrl: string, env: NodeJS.ProcessEnv = process.env, resolve: Resolve = (host) => lookup(host, { all: true })): Promise<void> {
  if (env.ALLOW_PRIVATE_MODEL_HOSTS === "1") return;
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await resolve(host);
  } catch {
    throw new Error(`无法解析 ${host}，请检查 Base URL`);
  }
  if (addresses.some(({ address }) => isBlocked(address))) {
    throw new Error(`Base URL 指向本机或内网地址（${host}），不允许使用；自建模型请由部署者设置 ALLOW_PRIVATE_MODEL_HOSTS=1`);
  }
}
