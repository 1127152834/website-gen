import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useFieldArray, useForm, type FieldPath } from "react-hook-form";
import { FileSpreadsheet, Plus, Save, Trash2, Upload } from "lucide-react";
import type { FreeDomain } from "../../../../shared/protocol.ts";
import { brandFromDomain, validateBatch, type BatchForm, type EntityForm } from "../../../../shared/forms.ts";
import { promises } from "../../../../shared/rules.ts";
import { call, useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { parseSiteCsv } from "@/lib/site-csv.ts";
import { batchDraftSchema, emptyBatchDraft, emptySiteDraft, entityToDraft, toBatchForm, type BatchDraft } from "./batch-form.ts";

type Template = { id: number; name: string; entity: EntityForm };
const STEPS = ["经营主体", "站点", "确认"] as const;

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="text-xs text-destructive">{message}</p> : null;
}

export function NewBatchPage({ onCreated }: { onCreated: (batchId: number) => void; userId?: number }) {
  const confirm = useConfirm();
  const csvInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: free = null, error: freeError } = useRpcData<FreeDomain[]>("domains.free", undefined, { topics: ["accounts", "batches"] });
  const { data: savedTemplates, error: templatesError, refresh: refreshTemplates, invalidate: invalidateTemplates } = useRpcData<Template[]>("templates.list");
  const form = useForm<BatchDraft>({ resolver: zodResolver(batchDraftSchema), defaultValues: emptyBatchDraft(), mode: "onTouched" });
  const { fields, append, remove, replace } = useFieldArray({ control: form.control, name: "sites" });
  const draft = form.watch();
  const sites = draft.sites;
  const entity = draft.entity;
  const used = new Set(sites.map((site) => site.domain).filter(Boolean));
  const autoEmail = entity.supportEmail === "auto";

  useLayoutEffect(() => { if (savedTemplates) setTemplates(savedTemplates); }, [savedTemplates]);
  useEffect(() => { const reason = freeError ?? templatesError; if (reason) setError(reason.message); }, [freeError, templatesError]);

  const fieldError = (path: FieldPath<BatchDraft>) => form.getFieldState(path, form.formState).error?.message;
  const aria = (path: FieldPath<BatchDraft>) => fieldError(path) ? { "aria-invalid": true as const, "aria-describedby": `${path}-error` } : {};
  const applyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === Number(templateId));
    if (!template) return;
    form.setValue("entity", entityToDraft(template.entity), { shouldDirty: true });
    form.clearErrors("entity");
  };
  const refreshTemplateList = () => {
    invalidateTemplates();
    void refreshTemplates().catch((reason: Error) => setError(reason.message));
  };

  const saveEntity = async () => {
    if (!await form.trigger("entity", { shouldFocus: true })) return;
    const value = toBatchForm(form.getValues()).entity;
    const found = Object.fromEntries(Object.entries(validateBatch({ entity: value, sites: [] })).filter(([key]) => key.startsWith("entity.")));
    if (Object.keys(found).length) return;
    setTemplateBusy(true);
    try {
      setTemplates(await call<Template[]>("templates.save", { name: templateName || value.name, entity: value }));
      refreshTemplateList();
      setTemplateName("");
      toast("经营主体已保存为模板");
    } catch (reason) { toast((reason as Error).message, "error"); }
    finally { setTemplateBusy(false); }
  };

  const removeTemplate = async (template: Template) => {
    if (!await confirm({ title: `删除模板「${template.name}」？`, description: "只删除模板，不影响已有站点和批次。", destructive: true })) return;
    try {
      setTemplates(await call<Template[]>("templates.remove", { id: template.id }));
      refreshTemplateList();
      toast("模板已删除");
    } catch (reason) { toast((reason as Error).message, "error"); }
  };

  const importCsv = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("CSV 不能超过 1 MB");
      const imported = parseSiteCsv(await file.text());
      const unavailable = imported.filter((site) => !free?.some((domain) => domain.domain === site.domain));
      if (unavailable.length) throw new Error(`以下域名未同步或已占用：${unavailable.map((site) => site.domain).join("、")}`);
      if (sites.some((site) => site.domain || site.categories) && !await confirm({ title: "替换当前站点行？", description: "CSV 将替换尚未提交的站点行；经营主体不会改变。", confirmText: "替换站点行" })) return;
      replace(imported.map((site) => ({ domain: site.domain, categories: site.categories, brand: site.brand, count: String(site.count), priceMin: site.priceMin == null ? "" : String(site.priceMin), priceMax: site.priceMax == null ? "" : String(site.priceMax) })));
      form.clearErrors("sites");
      toast(`已导入 ${imported.length} 个站点`);
    } catch (reason) { toast((reason as Error).message, "error"); }
  };

  const create = async (payload: BatchForm) => {
    if (!await confirm({ title: `为 ${payload.sites.length} 个域名建站？`, description: "将调用 Hostinger 创建网站、读取 CJ 商品并调用模型生成内容，可能产生模型费用。全程保持维护模式，验收后由你上线。", confirmText: "开始建站" })) return;
    setBusy(true);
    setError(null);
    try {
      const { batchId } = await call<{ batchId: number }>("batches.create", payload);
      form.reset(emptyBatchDraft());
      toast("建站批次已创建");
      onCreated(batchId);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step < 2) {
      const valid = await form.trigger(step === 0 ? "entity" : "sites", { shouldFocus: true });
      if (!valid) { toast("请先修正标记的字段", "error"); return; }
      setStep((current) => current + 1);
      return;
    }
    await form.handleSubmit((value) => create(toBatchForm(value)), () => toast("请先修正标记的字段", "error"))(event);
  };

  const setSiteValue = <K extends keyof BatchDraft["sites"][number]>(index: number, key: K, value: BatchDraft["sites"][number][K]) => {
    form.setValue(`sites.${index}.${key}` as FieldPath<BatchDraft>, value, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  };

  return (
    <form onSubmit={submit} noValidate className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header><h1 className="text-2xl font-bold tracking-tight">建站</h1><p className="mt-1 max-w-3xl text-sm text-muted-foreground">填写真实经营资料和每个站的商品方向。系统会在 Hostinger 自动建站，并保持维护模式直到你验收上线。</p></header>
      <ol aria-label="建站步骤" className="grid grid-cols-3 overflow-hidden rounded-lg border bg-card text-sm">{STEPS.map((label, index) => <li key={label} className="border-r last:border-r-0"><button type="button" className={`flex w-full items-center gap-2 px-3 py-3 text-left ${step === index ? "bg-primary/5 font-semibold text-primary" : "text-muted-foreground"}`} aria-current={step === index ? "step" : undefined} disabled={index > step || busy} onClick={() => setStep(index)}><span className={`grid size-6 place-items-center rounded-full border text-xs ${step === index ? "border-primary bg-primary text-primary-foreground" : "bg-background"}`}>{index + 1}</span><span>{label}</span></button></li>)}</ol>
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}
      {free === null && !error && <Skeleton label="正在读取可用域名" />}

      {step === 0 && <div className="space-y-6">
        <Card><CardHeader><CardTitle className="text-base">主体模板</CardTitle><CardDescription>复用常用经营主体，避免在不同批次重复录入。</CardDescription></CardHeader><CardContent className="flex flex-wrap items-end gap-3"><div className="min-w-52 flex-1"><Label htmlFor="entity-template">复用经营主体模板</Label><select id="entity-template" className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm" defaultValue="" onChange={(event) => applyTemplate(event.target.value)}><option value="">选择模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></div><div className="min-w-52 flex-1"><Label htmlFor="template-name">模板名称</Label><Input id="template-name" className="mt-2" value={templateName} maxLength={100} onChange={(event) => setTemplateName(event.target.value)} placeholder="默认使用主体名称" /></div><Button type="button" variant="outline" disabled={templateBusy} onClick={() => void saveEntity()}><Save aria-hidden />保存为模板</Button>{templates.length > 0 && <details className="basis-full text-sm"><summary className="cursor-pointer text-muted-foreground">管理已保存的模板</summary><ul className="mt-2 divide-y">{templates.map((template) => <li key={template.id} className="flex items-center justify-between py-2"><span>{template.name}</span><Button type="button" variant="ghost" size="sm" onClick={() => void removeTemplate(template)}>删除</Button></li>)}</ul></details>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">经营主体</CardTitle><CardDescription>这些信息会出现在页脚、联系页和政策页；系统不会编造资质或地址。</CardDescription></CardHeader><CardContent className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="entity-kind">主体类型</Label><Controller control={form.control} name="entity.kind" render={({ field }) => <Select value={field.value} onValueChange={field.onChange}><SelectTrigger id="entity-kind" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="company">公司</SelectItem><SelectItem value="individual">个人经营者</SelectItem></SelectContent></Select>} /></div>
          <div className="space-y-2"><Label htmlFor="entity.name">{entity.kind === "company" ? "公司法定名称" : "经营者姓名"}</Label><Input id="entity.name" placeholder={entity.kind === "company" ? "例如：Nordic Paws LLC" : "例如：Jane Doe"} {...form.register("entity.name")} {...aria("entity.name")} /><FieldError id="entity.name-error" message={fieldError("entity.name")} /></div>
          <div className="space-y-2 sm:col-span-2"><Label htmlFor="entity.address">地址</Label><Input id="entity.address" placeholder="例如：1 Main St, Austin, TX 78701, United States" {...form.register("entity.address")} {...aria("entity.address")} /><FieldError id="entity.address-error" message={fieldError("entity.address")} /></div>
          <div className="space-y-2"><Label htmlFor="entity.phone">客服电话</Label><Input id="entity.phone" type="tel" placeholder="例如：+1 512 555 0100" {...form.register("entity.phone")} {...aria("entity.phone")} /><FieldError id="entity.phone-error" message={fieldError("entity.phone")} /></div>
          <div className="space-y-2"><Label htmlFor="entity.supportEmail">客服邮箱</Label><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={autoEmail} onChange={(event) => form.setValue("entity.supportEmail", event.target.checked ? "auto" : "", { shouldDirty: true })} />使用各站自己的 support@域名</label>{!autoEmail && <Input id="entity.supportEmail" type="email" placeholder="例如：help@nordicpaws.com" {...form.register("entity.supportEmail")} {...aria("entity.supportEmail")} />}<FieldError id="entity.supportEmail-error" message={fieldError("entity.supportEmail")} /></div>
          <fieldset className="space-y-2 sm:col-span-2" aria-invalid={Boolean(fieldError("entity.processingMin"))}><legend className="mb-2 text-sm font-medium">发货时效（工作日）</legend><div className="flex flex-wrap items-center gap-2 text-sm">处理<Input aria-label="处理时效最少天数" type="number" min={0} max={60} className="w-20" placeholder="1" {...form.register("entity.processingMin")} />至<Input aria-label="处理时效最多天数" type="number" min={0} max={60} className="w-20" placeholder="3" {...form.register("entity.processingMax")} />天，运输<Input aria-label="运输时效最少天数" type="number" min={1} max={60} className="w-20" placeholder="5" {...form.register("entity.transitMin")} />至<Input aria-label="运输时效最多天数" type="number" min={1} max={60} className="w-20" placeholder="10" {...form.register("entity.transitMax")} />天</div><p className="text-xs text-muted-foreground">会原样写进运输政策和 FAQ，请填写实际能够做到的时效。</p><FieldError id="entity.shipping-error" message={fieldError("entity.processingMin")} /></fieldset>
        </CardContent></Card>
      </div>}

      {step === 1 && <Card><CardHeader className="flex-row flex-wrap items-end justify-between gap-3"><div><CardTitle className="text-base">站点</CardTitle><CardDescription className="mt-1">每行一个站，只列出已同步且尚未建站的域名。</CardDescription></div><div className="flex flex-wrap gap-2"><input ref={csvInput} className="hidden" type="file" accept=".csv,text/csv" aria-label="导入站点 CSV" onChange={(event) => { void importCsv(event.target.files?.[0]); event.target.value = ""; }} /><Button type="button" variant="outline" size="sm" onClick={() => csvInput.current?.click()}><Upload aria-hidden />导入 CSV</Button><Button type="button" variant="outline" size="sm" onClick={() => append(emptySiteDraft())} disabled={!free || fields.length >= free.length}><Plus aria-hidden />添加一个站</Button></div></CardHeader><CardContent>
        <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground"><FileSpreadsheet className="size-4" aria-hidden />CSV 表头：domain,brand,niche,count,price_min,price_max；支持引号内逗号。</p>
        {free?.length === 0 ? <div className="rounded-lg border border-dashed p-8 text-sm"><p className="font-medium">没有可用的域名</p><p className="mt-1 text-muted-foreground">先在「账号」页接入 Hostinger 账号并完成同步。</p></div> : <div className="overflow-x-auto rounded-lg border"><Table><TableHeader><TableRow><TableHead className="min-w-56">域名</TableHead><TableHead className="min-w-56">商品类目</TableHead><TableHead className="min-w-28">商品数量</TableHead><TableHead className="min-w-52">售价区间（美元）</TableHead><TableHead className="min-w-44">品牌名</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader><TableBody>{fields.map((row, index) => {
          const site = sites[index] ?? emptySiteDraft();
          const domainPath = `sites.${index}.domain` as FieldPath<BatchDraft>;
          const categoryPath = `sites.${index}.categories` as FieldPath<BatchDraft>;
          const countPath = `sites.${index}.count` as FieldPath<BatchDraft>;
          const pricePath = `sites.${index}.priceMin` as FieldPath<BatchDraft>;
          return <TableRow key={row.id} className="align-top"><TableCell className="whitespace-normal"><Select value={site.domain} onValueChange={(value) => setSiteValue(index, "domain", value)}><SelectTrigger className="w-full" aria-label={`第 ${index + 1} 个站的域名`} {...aria(domainPath)}><SelectValue placeholder="选择域名" /></SelectTrigger><SelectContent>{free?.filter((domain) => domain.domain === site.domain || !used.has(domain.domain)).map((domain) => <SelectItem key={domain.domain} value={domain.domain}>{domain.domain}<span className="ml-2 text-muted-foreground">{domain.accountLabel}</span></SelectItem>)}</SelectContent></Select><FieldError id={`${domainPath}-error`} message={fieldError(domainPath)} /></TableCell>
            <TableCell className="whitespace-normal"><Input aria-label={`第 ${index + 1} 个站的商品类目`} placeholder="例如：dog beds, pet blankets" {...form.register(categoryPath)} {...aria(categoryPath)} /><FieldError id={`${categoryPath}-error`} message={fieldError(categoryPath)} /></TableCell>
            <TableCell className="whitespace-normal"><Input aria-label={`第 ${index + 1} 个站的商品数量`} type="number" min={1} max={200} {...form.register(countPath)} {...aria(countPath)} /><FieldError id={`${countPath}-error`} message={fieldError(countPath)} /></TableCell>
            <TableCell className="whitespace-normal"><div className="flex items-center gap-1.5"><Input aria-label={`第 ${index + 1} 个站的最低售价`} type="number" min={0} step="0.01" {...form.register(pricePath)} {...aria(pricePath)} /><span className="text-muted-foreground" aria-hidden>至</span><Input aria-label={`第 ${index + 1} 个站的最高售价`} type="number" min={0} step="0.01" {...form.register(`sites.${index}.priceMax` as FieldPath<BatchDraft>)} /></div><FieldError id={`${pricePath}-error`} message={fieldError(pricePath)} /></TableCell>
            <TableCell className="whitespace-normal"><Input aria-label={`第 ${index + 1} 个站的品牌名`} placeholder={site.domain ? brandFromDomain(site.domain) : "默认取自域名"} {...form.register(`sites.${index}.brand` as FieldPath<BatchDraft>)} /></TableCell>
            <TableCell><Button type="button" variant="ghost" size="icon" aria-label={`移除第 ${index + 1} 个站`} disabled={fields.length === 1} onClick={() => remove(index)}><Trash2 aria-hidden /></Button></TableCell></TableRow>;
        })}</TableBody></Table></div>}
      </CardContent></Card>}

      {step === 2 && <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader><CardTitle className="text-base">核对经营主体</CardTitle></CardHeader><CardContent><p className="font-medium">{entity.name}</p><p className="mt-1 text-sm text-muted-foreground">{entity.address} · {entity.phone}</p><div className="mt-5 rounded-lg bg-muted/50 p-4 text-sm"><h2 className="font-medium">对买家的真实承诺</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{promises(toBatchForm(draft).entity).map((text) => <li key={text}>{text}</li>)}</ul></div></CardContent></Card><Card><CardHeader><CardTitle className="text-base">本批次的站点</CardTitle><CardDescription>{sites.length} 个域名将进入建站队列。</CardDescription></CardHeader><CardContent><ul className="divide-y">{toBatchForm(draft).sites.map((site) => <li key={site.domain} className="py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{site.domain}</span><span className="text-muted-foreground">{site.count} 件商品</span></div><p className="mt-1 text-muted-foreground">{site.categories}{site.priceMin != null ? ` · $${site.priceMin}–$${site.priceMax ?? "不限"}` : ""}</p></li>)}</ul></CardContent></Card></div>}

      <footer className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">{step > 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => setStep((current) => current - 1)}>上一步</Button>}<Button type="submit" disabled={busy || !free || free.length === 0}>{busy ? "正在创建…" : step === 2 ? "开始建站" : "下一步"}</Button></footer>
    </form>
  );
}
