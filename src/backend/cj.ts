// CJdropshipping 只当商品资料库：只用只读接口（搜索、详情），不授权店铺、不刊登、不下单。
// accessToken 由 API Key 换取（有效期约半年），和 Key 一起加密存在 secrets 表；CJ 每个接口每秒只允许 1 次。
import type { DatabaseSync } from "node:sqlite";
import { createLimiter } from "./rate-limit.ts";
import { getSecret, setSecret } from "./secrets.ts";

const API = "https://developers.cjdropshipping.com/api2.0/v1";
export type CjGet = (path: string) => Promise<any>;

async function call(fetchImpl: typeof fetch, path: string, init: RequestInit = {}) {
  const res = await fetchImpl(API + path, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = (await res.json().catch(() => null)) as { result?: boolean; message?: string; data?: unknown } | null;
  if (!body?.result) throw new Error(`CJ ${path.split("?")[0]}：${body?.message ?? `HTTP ${res.status}`}`);
  return body.data;
}

async function exchange(fetchImpl: typeof fetch, apiKey: string) {
  const data = (await call(fetchImpl, "/authentication/getAccessToken", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey }),
  })) as { accessToken: string; accessTokenExpiryDate: string };
  return { accessToken: data.accessToken, expiresAt: Date.parse(data.accessTokenExpiryDate) };
}

/** 保存前先换一次 token，Key 不对就报错、不保存。 */
export async function setCjKey(db: DatabaseSync, key: Buffer, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const k = apiKey.trim();
  if (!k) throw new Error("请填写 CJ API Key");
  const token = await exchange(fetchImpl, k).catch((e: Error) => {
    throw new Error(`CJ 拒绝了这个 Key：${e.message}`);
  });
  setSecret(db, key, "cj.apiKey", k, k.slice(-4));
  setSecret(db, key, "cj.token", JSON.stringify(token));
}

export function createCj(db: DatabaseSync, key: Buffer, fetchImpl: typeof fetch = fetch): CjGet {
  const limiter = createLimiter(1, 1100);
  async function token(fresh: boolean): Promise<string> {
    const cached = getSecret(db, key, "cj.token");
    const t = cached ? (JSON.parse(cached) as { accessToken: string; expiresAt: number }) : null;
    if (t && !fresh && t.expiresAt > Date.now() + 86_400_000) return t.accessToken;
    const apiKey = getSecret(db, key, "cj.apiKey");
    if (!apiKey) throw new Error("还没有设置 CJ API Key（设置页）");
    const next = await exchange(fetchImpl, apiKey);
    setSecret(db, key, "cj.token", JSON.stringify(next));
    return next.accessToken;
  }
  return async (path) => {
    for (let attempt = 0; ; attempt++) {
      await limiter.take();
      try {
        return await call(fetchImpl, path, { headers: { "CJ-Access-Token": await token(attempt > 0) } });
      } catch (e) {
        // token 被重新生成过而失效时，换一次再试
        if (attempt === 0 && /token/i.test((e as Error).message)) continue;
        throw e;
      }
    }
  };
}

// ---- 解析：只保留后面用得到的字段 ----

export interface Candidate {
  pid: string;
  name: string;
  /** 用哪个类目关键词搜到的，也决定商品进哪个分类 */
  keyword: string;
  costMin: number;
  costMax: number;
  listed: number;
}

/** "5.99 -- 7.40"、"5.99-7.40"、"5.99" → [最低, 最高] */
export function costRange(s: unknown): [number, number] | null {
  const n = String(s ?? "").match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return n.length ? [Math.min(...n), Math.max(...n)] : null;
}

export function parseCandidates(data: any, keyword: string): Candidate[] {
  const list = ((data?.content ?? []) as { productList?: any[] }[]).flatMap((c) => c.productList ?? []);
  return list.flatMap((p) => {
    const cost = costRange(p.sellPrice);
    if (!cost || !p.bigImage || !p.nameEn) return [];
    return [{ pid: String(p.id), name: String(p.nameEn), keyword, costMin: cost[0], costMax: cost[1], listed: Number(p.listedNum ?? 0) }];
  });
}

export interface CjVariant {
  key: string;
  cost: number;
  /** 克 */
  weight: number;
  /** 毫米 */
  length: number;
  width: number;
  height: number;
  /** CJ 为该规格提供的图片；上架时必须绑定到对应 variation。 */
  image?: string;
}

export interface CjProduct {
  pid: string;
  name: string;
  category: string;
  materials: string[];
  /** 去掉标签和图片后的纯文字描述 */
  description: string;
  images: string[];
  /** 规格属性名，例如 ["Color", "Size"] */
  keyNames: string[];
  variants: CjVariant[];
}

export function parseDetail(d: any): CjProduct {
  const images: unknown[] = Array.isArray(d.productImageSet) ? d.productImageSet : JSON.parse(d.productImage ?? "[]");
  return {
    pid: String(d.pid),
    name: String(d.productNameEn ?? ""),
    category: String(d.categoryName ?? ""),
    materials: (d.materialNameEnSet ?? []).map(String),
    description: String(d.description ?? "")
      .replace(/<img[^>]*>/gi, "").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 3000),
    images: images.map(String).filter((u) => u.startsWith("https://")),
    keyNames: String(d.productKeyEn ?? "").split("-").map((s) => s.trim()).filter(Boolean),
    variants: ((d.variants ?? []) as any[]).map((v) => ({
      key: String(v.variantKey ?? v.variantNameEn ?? ""),
      cost: Number(v.variantSellPrice),
      weight: Number(v.variantWeight ?? 0),
      length: Number(v.variantLength ?? 0),
      width: Number(v.variantWidth ?? 0),
      height: Number(v.variantHeight ?? 0),
      image: /^https:\/\//.test(String(v.variantImage ?? "")) ? String(v.variantImage) : undefined,
    })).filter((v) => v.cost > 0),
  };
}

/**
 * 规格拆成属性："Light Grey-S" + ["Color","Size"] → {Color: "Light Grey", Size: "S"}。
 * 段数对不上（值里本身带连字符等）时退回单个属性 "Option"，保证每个规格都能选到。
 */
export function splitVariants(keyNames: string[], keys: string[]): Record<string, string>[] {
  const parts = keys.map((k) => k.split("-").map((s) => s.trim()));
  if (keyNames.length > 0 && parts.every((p) => p.length === keyNames.length && p.every(Boolean))) {
    return parts.map((p) => Object.fromEntries(keyNames.map((n, i) => [n, p[i]])));
  }
  return keys.map((k) => ({ Option: k }));
}
