// 一键上线：关 Hostinger 维护模式 → 关 WooCommerce「即将上线」→ 允许搜索引擎收录 → 以访客身份确认首页能看到。
// 每一步都先看状态，重复点击是安全的。
import { setTimeout as sleep } from "node:timers/promises";
import { siteContext, type PipelineDeps } from "./pipeline.ts";

export async function launchSite(d: PipelineDeps, siteId: number, pause = (ms: number) => sleep(ms)): Promise<string> {
  const { site, domain, hx, act, inst, wp, emit, save } = siteContext(d, siteId);
  if (site.status !== "done") throw new Error("建站流程（含 QA）全部完成后才能上线");
  // 历史状态或手工修改不能绕过复核中的阻断问题。
  const qa = site.qa_json ? JSON.parse(site.qa_json) as { review?: { passed: boolean; issues: { level: string; status: string; page: string; fix: string }[] } } : null;
  if (qa?.review && (!qa.review.passed || qa.review.issues.some((i) => i.level === "P1" && i.status !== "fixed"))) {
    throw new Error(`整站 AI 复核仍有阻断项：${qa.review.issues.filter((i) => i.level === "P1" && i.status !== "fixed").map((i) => `${i.page}：${i.fix}`).join("；")}`);
  }
  const log = (status: string, detail: string | null) => emit("step", { step: "launch", name: "上线", status, detail });
  log("running", null);
  try {
    const maintenance = async () => ((await hx("wordpress_maintenance_show-status", inst())) as { status?: string }).status;
    if ((await maintenance()) === "enabled") {
      await act("wordpress_maintenance_toggle", { ...inst(), enabled: false });
      // 切换是 Hostinger 那边的异步任务，最多再等 20 秒
      for (let i = 0; i < 4 && (await maintenance()) === "enabled"; i++) await pause(5000);
      if ((await maintenance()) === "enabled") throw new Error("维护模式还没关掉，Hostinger 可能还在处理，稍后再点一次上线");
    }
    await wp("POST", "site-agent/v1/site", { options: { blog_public: 1, woocommerce_coming_soon: "no" } });

    const res = await d.fetch(`https://${domain}/`, { signal: AbortSignal.timeout(30_000) });
    const html = await res.text();
    const stillHidden = !res.ok || /coming soon|launching soon|under maintenance/i.test(html);
    if (stillHidden) throw new Error("访客首页仍不可用或仍是维护页；未记录上线成功，请确认缓存/维护状态后重试");
    save("launched_at", d.now());
    const detail = "访客已经能看到网站，搜索引擎可以收录";
    log("done", detail);
    return detail;
  } catch (e) {
    log("failed", (e as Error).message);
    throw e;
  }
}
