import { z } from "zod";
import { validateBatch, type BatchForm, type EntityForm } from "../../../../shared/forms.ts";

export const siteDraftSchema = z.object({
  domain: z.string(),
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
    supportEmail: z.string(),
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
});

export type BatchDraft = z.input<typeof batchDraftSchema>;
export type SiteDraft = z.input<typeof siteDraftSchema>;

export const emptySiteDraft = (): SiteDraft => ({
  domain: "",
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
    supportEmail: "auto",
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

export function toBatchForm(draft: BatchDraft): BatchForm {
  return {
    entity: {
      kind: draft.entity.kind,
      name: draft.entity.name,
      address: draft.entity.address,
      supportEmail: draft.entity.supportEmail,
      phone: draft.entity.phone,
      processingDays: [integer(draft.entity.processingMin), integer(draft.entity.processingMax)],
      transitDays: [integer(draft.entity.transitMin), integer(draft.entity.transitMax)],
    },
    sites: draft.sites.map((site) => ({
      domain: site.domain,
      categories: site.categories,
      count: Number(site.count),
      priceMin: optionalNumber(site.priceMin),
      priceMax: optionalNumber(site.priceMax),
      brand: site.brand.trim(),
    })),
  };
}

export function entityToDraft(entity: EntityForm): BatchDraft["entity"] {
  return {
    kind: entity.kind,
    name: entity.name,
    address: entity.address,
    supportEmail: entity.supportEmail,
    phone: entity.phone,
    processingMin: String(entity.processingDays[0]),
    processingMax: String(entity.processingDays[1]),
    transitMin: String(entity.transitDays[0]),
    transitMax: String(entity.transitDays[1]),
  };
}

function validationPath(path: string): (string | number)[] {
  if (path === "entity.shipping") return ["entity", "processingMin"];
  if (path === "sites") return ["sites"];
  const price = /^sites\.(\d+)\.price$/.exec(path);
  if (price) return ["sites", Number(price[1]), "priceMin"];
  return path.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
}
