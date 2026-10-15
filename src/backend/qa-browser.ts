// QA 用的浏览器：Windows 优先 Edge，其余用 Playwright Chromium。先用 Hostinger 的一次性登录链接登录管理员，
// 这样维护模式下也能看到真实页面；逐页截图、检查 PHP 报错，再把一个商品加入购物车走到结账页。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LaunchOptions } from "playwright-core";

export interface BrowseInput {
  loginUrl: string;
  /** https://域名 */
  origin: string;
  outDir: string;
  pages: { name: string; path: string; expect?: string }[];
  /** 加购地址（/?add-to-cart=ID）和购物车、结账页上应出现的商品名 */
  cart?: { addPath: string; expect: string };
  /** 整站复核才开启：只读检查本次抓取清单中的站内公开链接。 */
  auditInternalLinks?: boolean;
}
export interface BrowseCapture {
  name: string;
  path: string;
  url: string;
  text: string;
  /** 页面实际渲染的商品链接，用于限定 CJ 事实范围，不能从商品短名称猜测。 */
  productLinks?: string[];
  /** 页眉、页脚和正文分开保存，避免页脚中的主体信息掩盖正文缺失。 */
  sections?: { header: string; footer: string; body: string };
  links?: { url: string; text: string; location: "header" | "footer" | "body" }[];
  /** 当前页面中、指向本次抓取清单的站内链接状态；相同 URL 全程只请求一次。 */
  linkStatuses?: { url: string; status: number }[];
  status?: number;
  /** 未截图的兼容实现可以省略；正式浏览器始终填写。 */
  shot?: string;
}
export interface BrowseResult {
  shots: { name: string; file: string }[];
  problems: string[];
  /** 阶段三整站复核使用。旧测试替身可以不返回，复核会 fail closed。 */
  captures?: BrowseCapture[];
}
export type Browse = (input: BrowseInput) => Promise<BrowseResult>;

/** 启动不了浏览器：QA 记一条提醒并跳过截图，而不是让整个站失败。 */
export class BrowserUnavailable extends Error {}

export function browserLaunchOptions(platform: string = process.platform, path: string | undefined = process.env.QA_CHROMIUM_PATH): LaunchOptions[] {
  return [
    ...(path ? [{ headless: true, executablePath: path }] : []),
    ...(platform === "win32" ? [{ headless: true, channel: "msedge" }] : []),
    { headless: true },
  ];
}

export async function browseWithLauncher(
  { loginUrl, origin, outDir, pages, cart, auditInternalLinks = false }: BrowseInput,
  launch: (options: LaunchOptions) => Promise<any>,
): Promise<BrowseResult> {
  mkdirSync(outDir, { recursive: true });
  let browser;
  for (const options of browserLaunchOptions()) {
    browser = await launch(options).catch(() => undefined);
    if (browser) break;
  }
  if (!browser) throw new BrowserUnavailable("无法启动 Edge 或 Playwright Chromium，请安装 Chromium 或设置 QA_CHROMIUM_PATH");
  const shots: { name: string; file: string }[] = [];
  const problems: string[] = [];
  const captures: BrowseCapture[] = [];
  const auditRequests = new Map<string, Promise<number>>();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // 只等 HTML 到；图片等资源再给 15 秒，慢就不等了（网络抖动时 load 事件可能迟迟不来）
    const go = async (url: string) => {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
      return res;
    };
    // 一次性登录链接相当于临时凭据：出错时不把它带进错误信息和日志
    await go(loginUrl).catch((e: Error) => {
      throw new Error(`一次性登录链接打不开：${e.message.split("\n")[0].replaceAll(loginUrl, "<登录链接>")}`);
    });
    const visit = async (name: string, path: string, expect?: string) => {
      const res = await go(origin + path);
      // 购物车、结账是 Woo 区块，加载完才用 JS 拉内容：等要找的文字出现（最多 20 秒）再检查和截图
      if (expect) await page.getByText(expect).first().waitFor({ timeout: 20_000 }).catch(() => {});
      const sections = await page.locator("body").evaluate((body: HTMLElement) => {
        const regionText = (selector: string) => Array.from(body.querySelectorAll<HTMLElement>(selector))
          .map((region) => region.innerText.trim()).filter(Boolean).join("\n");
        const excluded = Array.from(body.querySelectorAll<HTMLElement>("header, footer, #wpadminbar"));
        const displays = excluded.map((element) => element.style.getPropertyValue("display"));
        const priorities = excluded.map((element) => element.style.getPropertyPriority("display"));
        for (const element of excluded.filter((element) => element.matches("#wpadminbar"))) element.style.setProperty("display", "none", "important");
        const header = regionText("header");
        const footer = regionText("footer");
        for (const element of excluded.filter((element) => !element.matches("#wpadminbar"))) element.style.setProperty("display", "none", "important");
        const main = body.innerText.trim();
        excluded.forEach((element, index) => {
          if (displays[index]) element.style.setProperty("display", displays[index], priorities[index]);
          else element.style.removeProperty("display");
        });
        return { header, footer, body: main };
      });
      const text = [sections.header, sections.body, sections.footer].filter(Boolean).join("\n\n");
      const links = await page.locator("a[href]").evaluateAll((elements: Element[]) => elements.flatMap((element) => {
        const link = element as HTMLAnchorElement;
        if (link.closest("#wpadminbar")) return [];
        const url = new URL(link.href);
        if (!/^https?:$/.test(url.protocol) || /(?:\/wp-admin(?:\/|$)|\/wp-login\.php(?:\/|$))/i.test(url.pathname)
          || /(?:logout|log-out|add-to-cart|remove_item|remove-item|wc-ajax)/i.test(url.pathname + url.search)
          || url.searchParams.has("_wpnonce")) return [];
        const style = getComputedStyle(link);
        if (style.display === "none" || style.visibility === "hidden" || link.getClientRects().length === 0) return [];
        return [{
          url: url.href,
          text: link.innerText.trim(),
          location: link.closest("footer") ? "footer" as const : link.closest("header") ? "header" as const : "body" as const,
        }];
      }));
      const productLinks = links.map((link: { url: string }) => link.url);
      const status = res?.status();
      if (!auditInternalLinks && (!res || (status !== undefined && status >= 400))) problems.push(`${name} 返回 HTTP ${status ?? "无响应"}`);
      if (/there has been a critical error|fatal error:|parse error:/i.test(text)) problems.push(`${name} 页面有 PHP 错误`);
      if (expect && !text.includes(expect)) problems.push(`${name} 页面上找不到「${expect.slice(0, 40)}」`);
      // 名字来自站点标题；文件名只保留稳定的安全字符，避免 Windows 路径字符和目录穿越。
      const safe = name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `page-${shots.length + 1}`;
      const file = join(outDir, `${String(shots.length + 1).padStart(3, "0")}-${safe}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push({ name, file });
      const audited: string[] = [];
      if (auditInternalLinks) for (const link of links as { url: string }[]) {
        const url = publicAuditUrl(link.url, origin);
        if (url && !audited.some((existing) => canonicalAuditKey(existing) === canonicalAuditKey(url))) audited.push(url);
      }
      const linkStatuses = auditInternalLinks ? await Promise.all(audited.map(async (url: string) => {
        const key = canonicalAuditKey(url);
        let request = auditRequests.get(key);
        if (!request) {
          const created = auditLinkStatus(page, url, origin);
          auditRequests.set(key, created);
          request = created;
        }
        return { url, status: await request };
      })) : undefined;
      captures.push({ name, path, url: page.url(), text, productLinks, sections, links, linkStatuses, status, shot: file });
    };
    // 管理员的购物车会跨会话保存：加购前先清空（结账页只有这一件），检查完再清空，不留痕迹
    const clearCart = async () => {
      await go(origin + "/cart/");
      // 购物车区块页面上有 wp.apiFetch，自带登录和 Store API 的 nonce
      const viaApi = await page.evaluate(async () => {
        const apiFetch = (window as { wp?: { apiFetch?: (o: object) => Promise<unknown> } }).wp?.apiFetch;
        if (!apiFetch) return false;
        await apiFetch({ path: "/wc/store/v1/cart/items", method: "DELETE" });
        return true;
      }).catch(() => false);
      if (viaApi) return;
      for (let i = 0; i < 20; i++) {
        const remove = page.locator(".wc-block-cart-item__remove-link").first();
        if ((await remove.count()) === 0) break;
        await remove.click();
        await page.waitForTimeout(1500);
      }
    };
    for (const p of pages) await visit(p.name, p.path, p.expect);
    if (cart) {
      await clearCart().catch(() => {});
      await go(origin + cart.addPath);
      try {
        await visit("cart", "/cart/", cart.expect);
        await visit("checkout", "/checkout/", cart.expect);
      } finally {
        await clearCart().catch(() => {});
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await visit("home-mobile", "/");
  } finally {
    await browser.close();
  }
  return { shots, problems, captures };
}

/** 只允许无副作用的公开 GET 地址，且保留规范化后的完整地址供去重。 */
function publicAuditUrl(value: string, origin: string, base: string = origin): string | undefined {
  let url: URL;
  try { url = new URL(value, base); } catch { return undefined; }
  if (url.origin !== new URL(origin).origin || !/^https?:$/.test(url.protocol)) return undefined;
  if (/(?:\/wp-admin(?:\/|$)|\/wp-login\.php(?:\/|$)|\/cart(?:\/|$)|\/checkout(?:\/|$)|\/my-account(?:\/|$))/i.test(url.pathname)) return undefined;
  if (/(?:logout|log-out|add-to-cart|remove_item|remove-item|wc-ajax)/i.test(url.pathname + url.search) || url.searchParams.has("_wpnonce")) return undefined;
  if (/\.(?:avif|bmp|css|csv|docx?|eot|gif|ico|jpe?g|js|json|mp3|mp4|pdf|png|pptx?|svg|tar|tiff?|ttf|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(url.pathname)) return undefined;
  url.hash = "";
  return url.href;
}

/** 只去掉片段；斜杠和查询参数的不同 URL 可能返回不同状态，不能推定等价。 */
function canonicalAuditKey(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

/** 禁止自动跟随重定向；仅手工跟随同源公开地址，外跳或循环保留 3xx 供复核判定。 */
async function auditLinkStatus(page: any, initialUrl: string, origin: string): Promise<number> {
  let url = initialUrl;
  const seen = new Set<string>();
  let lastRedirectStatus = 310;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (seen.has(url)) return lastRedirectStatus;
    seen.add(url);
    const response = await page.request.get(url, { timeout: 20_000, maxRedirects: 0, failOnStatusCode: false }).catch(() => undefined);
    if (!response) return 0;
    const status = response.status();
    if (status < 300 || status >= 400) return status;
    lastRedirectStatus = status;
    const location = response.headers()["location"];
    if (!location || redirects === 5) return status;
    const next = publicAuditUrl(location, origin, url);
    if (!next) return status;
    url = next;
  }
  return lastRedirectStatus;
}

export const browseWithEdge: Browse = async (input) => {
  const { chromium } = await import("playwright-core");
  return browseWithLauncher(input, (options) => chromium.launch(options));
};
