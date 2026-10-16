import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewIssue, SiteReview } from "../shared/protocol.ts";
import type { StepCtx } from "./pipeline.ts";
import { runFullSiteReview } from "./review.ts";

const origin = "https://shop.test";
const homeUrl = `${origin}/`;
const issueId = (kind: string, url: string, key: string) => `${kind}-${createHash("sha256").update(`${url.trim().toLowerCase()}|${key.trim().toLowerCase()}`).digest("hex").slice(0, 16)}`;
const underwritingId = (url: string, key: string) => `underwriting-${issueId("config", url, key)}`;

const historicalIssue = (values: Partial<ReviewIssue> & Pick<ReviewIssue, "id" | "url">): ReviewIssue => ({
  level: "P2", kind: "config", page: "Historical page", evidence: "historical sentinel", why: "Historical reason.",
  fix: "Historical fix.", status: "open", ...values,
});

async function reviewHistory(previousIssues: ReviewIssue[], options: {
  pageSlugs?: string[];
  supportEmail?: string;
  siteOptions?: Record<string, unknown>;
  payments?: Record<string, unknown>[];
  footer?: string;
  footerWithoutNamePath?: string;
  inspectError?: string;
} = {}) {
  const pageSlugs = options.pageSlugs ?? ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy", "terms"];
  const pages = pageSlugs.map((slug, index) => ({ id: index + 1, slug, status: "publish", link: `${origin}${slug === "home" ? "/" : `/${slug}/`}` }));
  const previous = { at: 1, rounds: 0, passed: true, issues: previousIssues } satisfies SiteReview;
  const site = { id: 1, qa_json: JSON.stringify({ review: previous }), picks_json: "[]", spec_json: "{}" };
  const entity = {
    name: "Harbor Goods LLC", address: "7428 Harbor Avenue, Portland, OR 97205", supportEmail: options.supportEmail ?? "support@shop.test",
    phone: "+1 207 736 1829", processingDays: [1, 3], transitDays: [5, 10],
  };
  const ctx = {
    domain: "shop.test", site, entity, form: {}, emit: () => {}, save: (_column: string, value: string) => { site.qa_json = value; },
    wp: async (_method: string, path: string) => {
      if (path.startsWith("wp/v2/pages")) return pages;
      if (path.startsWith("wc/v3/products/categories")) return [];
      if (path.startsWith("wc/v3/products")) return [];
      if (path === "site-agent/v1/site") return { options: options.siteOptions ?? { custom_logo: 12, site_icon: 13 }, info: {} };
      if (path === "wc/v3/payment_gateways") return options.payments ?? [{ id: "stripe", enabled: true }];
      if (path === "wc/v3/settings/general/woocommerce_currency") return { value: "USD" };
      throw new Error(path);
    },
    d: {
      now: () => 2, workDir: "qa", ai: async () => {
        if (options.inspectError) throw new Error(options.inspectError);
        return { text: '{"issues":[]}', cost: 0 };
      },
      browse: async (input: { pages: { name: string; path: string }[] }) => ({
        problems: [], shots: [], captures: input.pages.map((page) => {
          const shipping = page.path === "/shipping/" ? " Orders process in 1-3 business days and arrive in 5-10 business days. Customers may cancel before shipment." : "";
          const body = `Harbor Goods LLC ${entity.supportEmail} +1 207 736 1829 7428 Harbor Avenue, Portland, OR 97205.${shipping}`;
          const links = pages.filter((row) => row.slug !== "home").map((row) => ({ url: row.link, text: row.slug, location: "footer" as const }));
          const footer = options.footer ?? (page.path === options.footerWithoutNamePath ? "support@shop.test +1 207 736 1829 7428 Harbor Avenue, Portland, OR 97205" : body);
          return {
            ...page, url: `${origin}${page.path}`, text: body, sections: { header: "Harbor Goods", body, footer },
            links, linkStatuses: links.map((link) => ({ url: link.url, status: 200 })), status: 200, productLinks: [], shot: "shot.png",
          };
        }),
      }),
    },
  } as unknown as StepCtx;

  return runFullSiteReview(ctx, { loginUrl: "https://login.test", vision: async () => ({ text: '{"issues":[]}', cost: 0 }), maxRounds: 0 });
}

test("history drops stale page issues but keeps payment setup and still-crawled underwriting", async () => {
  const oldUrl = `${origin}/product-category/old/`;
  const paymentUrl = `${origin}/wp-admin/admin.php?page=wc-settings&tab=checkout`;
  const staleUnderwriting = historicalIssue({ id: underwritingId(oldUrl, "address-mismatch"), url: oldUrl, page: "Old category" });
  const staleGeneric = historicalIssue({ id: issueId("copy", oldUrl, "old-copy"), url: oldUrl, kind: "copy", page: "Old category" });
  const currentUnderwriting = historicalIssue({ id: underwritingId(`${origin}/shop/`, "foreign-currency-price"), url: `${origin}/shop/`, page: "Shop" });
  const payment = historicalIssue({
    id: issueId("config", paymentUrl, "payments"), url: paymentUrl, page: "Payment setup", status: "needs_you",
  });

  const review = await reviewHistory([staleUnderwriting, staleGeneric, currentUnderwriting, payment], { payments: [] });

  assert.equal(review.issues.some((issue) => issue.id === staleUnderwriting.id), false, "stale underwriting tied to an uncrawled page must be dropped");
  assert.equal(review.issues.some((issue) => issue.id === staleGeneric.id), false, "generic history tied to an uncrawled page must be dropped");
  assert.equal(review.issues.find((issue) => issue.id === currentUnderwriting.id)?.status, "fixed", "underwriting history for a current crawl target must be re-evaluated, not dropped");
  assert.equal(review.issues.some((issue) => issue.id === payment.id), true, "site-level payment setup must remain in review history");
});

test("configured email, required pages, logo and icon history is re-evaluated with fresh deterministic evidence", async () => {
  const branding = [
    historicalIssue({ id: issueId("config", homeUrl, "missing-custom-logo"), url: homeUrl }),
    historicalIssue({ id: issueId("config", homeUrl, "missing-site-icon"), url: homeUrl }),
  ];
  const brandingReview = await reviewHistory(branding, { siteOptions: { custom_logo: 0, site_icon: 0 } });
  for (const old of branding) {
    const fresh = brandingReview.issues.find((issue) => issue.id === old.id);
    assert(fresh, `${old.id} must remain in the site-level review`);
    assert.notEqual(fresh.evidence, "historical sentinel", `${old.id} must be replaced by fresh deterministic evidence`);
  }

  const configuredEmail = historicalIssue({ id: underwritingId(homeUrl, "configured-email-foreign-domain"), url: homeUrl, status: "needs_you" });
  const emailReview = await reviewHistory([configuredEmail], { supportEmail: "owner@example.org" });
  const freshEmail = emailReview.issues.find((issue) => issue.id === configuredEmail.id);
  assert(freshEmail, "configured-email history must remain in the site-level review");
  assert.notEqual(freshEmail.evidence, "historical sentinel", "configured-email history must be replaced by fresh deterministic evidence");

  const requiredPage = historicalIssue({ id: underwritingId(homeUrl, "required-page-terms"), url: homeUrl });
  const requiredReview = await reviewHistory([requiredPage], {
    pageSlugs: ["home", "about", "contact", "faq", "shipping", "returns", "privacy-policy"],
  });
  const freshRequired = requiredReview.issues.find((issue) => issue.id === requiredPage.id);
  assert(freshRequired, "required-page history must remain in the site-level review");
  assert.notEqual(freshRequired.evidence, "historical sentinel", "required-page history must be replaced by fresh deterministic evidence");
});

test("merged Site-wide underwriting history is re-evaluated instead of being scoped to one page", async () => {
  const oldUrl = `${origin}/product-category/old/`;
  const siteWide = historicalIssue({ id: underwritingId(oldUrl, "footer-legal-name-missing"), url: oldUrl, page: "Site-wide" });

  const review = await reviewHistory([siteWide], { footerWithoutNamePath: "/" });
  const fresh = review.issues.find((issue) => issue.id === underwritingId(homeUrl, "footer-legal-name-missing"));

  assert(fresh, "merged Site-wide history must remain eligible for re-evaluation");
  assert.notEqual(fresh.page, "Site-wide", "a problem now seen on one page keeps its fresh page anchor");
  assert.notEqual(fresh.evidence, "historical sentinel", "fresh merged evidence must replace the historical record");
  assert.equal(review.issues.some((issue) => issue.id === siteWide.id), false, "the removed historical anchor must not survive reanchoring");
});

test("site-level history survives a removed anchor, reanchors when still failing, and becomes fixed when resolved", async () => {
  const oldUrl = `${origin}/product-category/old/`;
  const oldLogo = historicalIssue({ id: issueId("config", oldUrl, "missing-custom-logo"), url: oldUrl });
  const oldIcon = historicalIssue({ id: issueId("config", oldUrl, "missing-site-icon"), url: oldUrl });
  const oldEmail = historicalIssue({ id: underwritingId(oldUrl, "configured-email-foreign-domain"), url: oldUrl, status: "needs_you" });
  const oldRequired = historicalIssue({ id: underwritingId(oldUrl, "required-page-terms"), url: oldUrl });

  const brandingReview = await reviewHistory([oldLogo, oldIcon], { siteOptions: { custom_logo: 0, site_icon: 13 } });
  assert(brandingReview.issues.some((issue) => issue.id === issueId("config", homeUrl, "missing-custom-logo") && issue.url === homeUrl), "unresolved logo history must reanchor to fresh deterministic evidence");
  assert.equal(brandingReview.issues.find((issue) => issue.id === oldIcon.id)?.status, "fixed", "resolved site icon history must remain as fixed even when its old anchor disappeared");
  assert.equal(brandingReview.issues.some((issue) => issue.id === oldLogo.id), false, "reanchored logo history must not keep its obsolete ID");

  const policyReview = await reviewHistory([oldEmail, oldRequired], { supportEmail: "owner@example.org" });
  assert(policyReview.issues.some((issue) => issue.id === underwritingId(homeUrl, "configured-email-foreign-domain") && issue.url === homeUrl), "unresolved configured-email history must reanchor to fresh deterministic evidence");
  assert.equal(policyReview.issues.find((issue) => issue.id === oldRequired.id)?.status, "fixed", "resolved required-page history must remain as fixed even when its old anchor disappeared");
  assert.equal(policyReview.issues.some((issue) => issue.id === oldEmail.id), false, "reanchored configured-email history must not keep its obsolete ID");
});

test("a model issue labelled Site-wide cannot bypass stale-page pruning", async () => {
  const oldUrl = `${origin}/product-category/old/`;
  const fakeSiteWide = historicalIssue({ id: issueId("copy", oldUrl, "model-site-wide"), url: oldUrl, kind: "copy", page: "Site-wide" });

  const review = await reviewHistory([fakeSiteWide]);

  assert.equal(review.issues.some((issue) => issue.id === fakeSiteWide.id), false);
});

test("inspector failure after collection prunes stale pages while preserving deterministic site history and the failure", async () => {
  const oldUrl = `${origin}/product-category/old/`;
  const stale = historicalIssue({ id: issueId("copy", oldUrl, "stale-model-copy"), url: oldUrl, kind: "copy" });
  const oldLogo = historicalIssue({ id: issueId("config", oldUrl, "missing-custom-logo"), url: oldUrl });

  const review = await reviewHistory([stale, oldLogo], { siteOptions: { custom_logo: 0, site_icon: 13 }, inspectError: "inspector boom" });

  assert.equal(review.issues.some((issue) => issue.id === stale.id), false, "the successful crawl is sufficient to prune removed page history");
  assert(review.issues.some((issue) => issue.id === issueId("config", homeUrl, "missing-custom-logo")), "deterministic site-level history must survive with its fresh anchor");
  assert(review.issues.some((issue) => issue.page === "Full-site review" && /inspector boom/.test(issue.evidence)), "the inspector failure must remain explicit");
});
