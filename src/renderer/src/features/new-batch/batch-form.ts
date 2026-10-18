import { z } from "zod";
import { validateBatch, type BatchForm } from "../../../../shared/forms.ts";
import type { DomainMailboxes } from "../../../../shared/protocol.ts";

export const siteDraftSchema = z.object({
  domain: z.string(),
  supportEmail: z.string(),
  categories: z.string(),
  count: z.string(),
  priceMin: z.string(),
  priceMax: z.string(),
  brand: z.string(),
});

export const batchDraftSchema = z.object({
  entity: z.object({
    kind: z.enum(["company", "individual"]),
    name: z.string(),
    address: z.string(),
    phone: z.string(),
    processingMin: z.string(),
    processingMax: z.string(),
    transitMin: z.string(),
    transitMax: z.string(),
  }),
  sites: z.array(siteDraftSchema),
}).superRefine((draft, context) => {
  const errors = validateBatch(toBatchForm(draft));
  for (const [path, message] of Object.entries(errors)) {
    context.addIssue({ code: "custom", path: validationPath(path), message });
  }
  draft.sites.forEach((site, index) => {
    if (site.domain.trim() && !site.supportEmail.trim()) {
      context.addIssue({ code: "custom", path: ["sites", index, "supportEmail"], message: "请先为该站点申请邮箱，并在申请后重试" });
    }
  });
});

export type BatchDraft = z.input<typeof batchDraftSchema>;
export type SiteDraft = z.input<typeof siteDraftSchema>;

export const emptySiteDraft = (): SiteDraft => ({
  domain: "",
  supportEmail: "",
  categories: "",
  count: "20",
  priceMin: "",
  priceMax: "",
  brand: "",
});

export const emptyBatchDraft = (): BatchDraft => ({
  entity: {
    kind: "company",
    name: "",
    address: "",
    phone: "",
    processingMin: "",
    processingMax: "",
    transitMin: "",
    transitMax: "",
  },
  sites: [emptySiteDraft()],
});

const optionalNumber = (value: string) => value.trim() === "" ? null : Number(value);
const integer = (value: string) => value.trim() === "" ? Number.NaN : Number(value);

export const mailboxDomainKey = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, "");

/** null 表示响应不属于当前域名，调用方不得让过期请求覆盖当前行。 */
export function resolveSiteMailboxEmail(domain: string, result: DomainMailboxes | undefined, current: string): string | null {
  if (!domain || !result || mailboxDomainKey(result.domain) !== mailboxDomainKey(domain)) return null;
  if (result.defaultEmail) return result.defaultEmail;
  const available = result.mailboxes.map((mailbox) => mailbox.address);
  return available.includes(current) ? current : "";
}

export function toBatchForm(draft: BatchDraft): BatchForm {
  return {
    entity: {
      kind: draft.entity.kind,
      name: draft.entity.name,
      address: draft.entity.address,
      supportEmail: "auto",
      phone: draft.entity.phone,
      processingDays: [integer(draft.entity.processingMin), integer(draft.entity.processingMax)],
      transitDays: [integer(draft.entity.transitMin), integer(draft.entity.transitMax)],
    },
    sites: draft.sites.map((site) => ({
      domain: site.domain,
      supportEmail: site.supportEmail,
      categories: site.categories,
      count: Number(site.count),
      priceMin: optionalNumber(site.priceMin),
      priceMax: optionalNumber(site.priceMax),
      brand: site.brand.trim(),
    })),
  };
}

function validationPath(path: string): (string | number)[] {
  if (path === "entity.shipping") return ["entity", "processingMin"];
  if (path === "sites") return ["sites"];
  const price = /^sites\.(\d+)\.price$/.exec(path);
  if (price) return ["sites", Number(price[1]), "priceMin"];
  return path.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
}
