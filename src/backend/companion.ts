// 站点伴侣插件：为每个站准备一份带一次性注册配置的插件副本；注册时用令牌换应用密码；健康检查。
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface CompanionCreds {
  username: string;
  password: string;
}

/** 复制插件模板，写入只含令牌哈希的 enroll.php；返回要部署的插件目录。 */
export function prepareCompanion(templateDir: string, workDir: string, domain: string, token: string, generation: number, expiresAt: number): string {
  const dir = join(workDir, "companion", domain, "site-companion");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(templateDir, dir, { recursive: true });
  const hash = createHash("sha256").update(token).digest("hex");
  writeFileSync(join(dir, "enroll.php"), `<?php\nreturn array( 'token_hash' => '${hash}', 'expires' => ${Math.floor(expiresAt / 1000)}, 'generation' => ${generation} );\n`);
  return dir;
}

/** 注册被拒（令牌过期、已用过、插件版本不对）：需要重新部署一份新令牌的插件。 */
export class EnrollRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollRejected";
  }
}

export async function enrollCompanion(domain: string, token: string, fetchImpl: typeof fetch = fetch): Promise<CompanionCreds> {
  const res = await fetchImpl(`https://${domain}/wp-json/site-agent/v1/enroll`, {
    method: "POST",
    headers: { "X-Site-Agent-Enroll": token },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 403) throw new EnrollRejected("注册令牌被拒绝（过期或已用过），需要重新部署伴侣插件");
  if (!res.ok) throw new Error(`注册请求失败：HTTP ${res.status}`);
  const body = (await res.json()) as Partial<CompanionCreds>;
  if (!body.username || !body.password) throw new Error("注册返回的数据不完整");
  return { username: body.username, password: body.password };
}

export async function companionHealth(domain: string, creds: CompanionCreds, fetchImpl: typeof fetch = fetch): Promise<Record<string, string | null>> {
  const res = await fetchImpl(`https://${domain}/wp-json/site-agent/v1/health`, {
    headers: { Authorization: "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64") },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`健康检查失败：HTTP ${res.status}`);
  return (await res.json()) as Record<string, string | null>;
}
