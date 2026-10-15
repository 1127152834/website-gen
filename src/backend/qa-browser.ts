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
}
export interface BrowseCapture {
  name: string;
  path: string;
  url: string;
  text: string;
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
  { loginUrl, origin, outDir, pages, cart }: BrowseInput,
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
      const text = await page.locator("body").innerText();
      if (!res || res.status() >= 400) problems.push(`${name} 返回 HTTP ${res?.status() ?? "无响应"}`);
      if (/there has been a critical error|fatal error:|parse error:/i.test(text)) problems.push(`${name} 页面有 PHP 错误`);
      if (expect && !text.includes(expect)) problems.push(`${name} 页面上找不到「${expect.slice(0, 40)}」`);
      // 名字来自站点标题；文件名只保留稳定的安全字符，避免 Windows 路径字符和目录穿越。
      const safe = name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `page-${shots.length + 1}`;
      const file = join(outDir, `${String(shots.length + 1).padStart(3, "0")}-${safe}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push({ name, file });
      captures.push({ name, path, url: page.url(), text, shot: file });
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

export const browseWithEdge: Browse = async (input) => {
  const { chromium } = await import("playwright-core");
  return browseWithLauncher(input, (options) => chromium.launch(options));
};
