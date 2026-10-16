import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Plus, Trash2, Upload, Save } from "lucide-react";
import type { FreeDomain } from "../../../shared/protocol.ts";
import { brandFromDomain, validateBatch, type BatchForm, type EntityForm } from "../../../shared/forms.ts";
import { promises } from "../../../shared/rules.ts";
import { call, useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useConfirm, toast } from "@/components/feedback";
import { Skeleton } from "@/components/page-state";
import { parseSiteCsv } from "@/lib/site-csv.ts";

// 输入框里的数字先按字符串存，提交时再转换，避免输入到一半就被改写
interface SiteDraft { rowId: string; domain: string; categories: string; count: string; priceMin: string; priceMax: string; brand: string }
let nextRow = 0;
const rowId = () => String(++nextRow);
const emptySite = (): SiteDraft => ({ rowId: rowId(), domain: "", categories: "", count: "20", priceMin: "", priceMax: "", brand: "" });
type EntityDraft = Omit<EntityForm, "processingDays" | "transitDays">;
const emptyEntity = (): EntityDraft => ({ kind: "company", name: "", address: "", supportEmail: "auto", phone: "" });
// 发货时效：处理最少/最多、运输最少/最多（工作日）。不预填：必须是你们真实的发货能力
const emptyDays = () => ({ p0: "", p1: "", t0: "", t1: "" });
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const int = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="text-xs text-destructive">{message}</p> : null;
}

export function NewBatchPage({ onCreated }: { onCreated: (batchId: number) => void; userId?: number }) {
  const [entity, setEntity] = useState<EntityDraft>(emptyEntity);
  const [days, setDays] = useState(emptyDays);
  const [sites, setSites] = useState<SiteDraft[]>([emptySite()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<{ id: number; name: string; entity: EntityForm }[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const csvInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: free = null, error: freeError } = useRpcData<FreeDomain[]>("domains.free", undefined, { topics: ["accounts", "batches"] });
  const { data: savedTemplates, error: templatesError, refresh: refreshTemplates, invalidate: invalidateTemplates } = useRpcData<typeof templates>("templates.list");
  useLayoutEffect(() => { if (savedTemplates) setTemplates(savedTemplates); }, [savedTemplates]);
  useEffect(() => { const reason = freeError ?? templatesError; if (reason) setError(reason.message); }, [freeError, templatesError]);

  const setE = (patch: Partial<EntityDraft>) => setEntity((e) => ({ ...e, ...patch }));
  const setS = (i: number, patch: Partial<SiteDraft>) => setSites((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const used = new Set(sites.map((s) => s.domain).filter(Boolean));
  const autoEmail = entity.supportEmail === "auto";

  const toForm = (): BatchForm => ({
    entity: { ...entity, processingDays: [int(days.p0), int(days.p1)], transitDays: [int(days.t0), int(days.t1)] },
    sites: sites.map((s) => ({
      domain: s.domain, categories: s.categories, count: Number(s.count), priceMin: num(s.priceMin), priceMax: num(s.priceMax), brand: s.brand.trim(),
    })),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const form = toForm();
    const found = validateBatch(form);
    const relevant = step === 0 ? Object.fromEntries(Object.entries(found).filter(([key]) => key.startsWith("entity."))) : found;
    setErrors(relevant);
    if (Object.keys(relevant).length) { toast("请先修正标记的字段", "error"); return; }
    if (step < 2) { setStep(step + 1); return; }
    if (await confirm({ title: `为 ${form.sites.length} 个域名建站？`, description: "将调用 Hostinger 创建网站、读取 CJ 商品并调用模型生成内容，可能产生模型费用。全程保持维护模式，验收后由你上线。", confirmText: "开始建站" })) await create(form);
  };
  const saveEntity = async () => {
    const value = toForm().entity;
    const found = Object.fromEntries(Object.entries(validateBatch({ entity: value, sites: [] })).filter(([key]) => key.startsWith("entity.")));
    setErrors(found);
    if (Object.keys(found).length) return;
    setTemplateBusy(true);
    try { setTemplates(await call<typeof templates>("templates.save", { name: templateName || value.name, entity: value })); invalidateTemplates(); void refreshTemplates().catch((reason: Error) => setError(reason.message)); setTemplateName(""); toast("经营主体已保存为模板"); }
    catch (reason) { toast((reason as Error).message, "error"); } finally { setTemplateBusy(false); }
  };
  const importCsv = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("CSV 不能超过 1 MB");
      const imported = parseSiteCsv(await file.text());
      const unavailable = imported.filter((site) => !free?.some((domain) => domain.domain === site.domain));
      if (unavailable.length) throw new Error(`以下域名未同步或已占用：${unavailable.map((site) => site.domain).join("、")}`);
      if (sites.some((site) => site.domain || site.categories) && !await confirm({ title: "替换当前站点行？", description: "CSV 将替换尚未提交的站点行；经营主体不会改变。", confirmText: "替换站点行" })) return;
      setSites(imported.map((site) => ({ rowId: rowId(), domain: site.domain, categories: site.categories, brand: site.brand, count: String(site.count), priceMin: site.priceMin == null ? "" : String(site.priceMin), priceMax: site.priceMax == null ? "" : String(site.priceMax) })));
      setErrors({}); toast(`已导入 ${imported.length} 个站点`);
    } catch (reason) { toast((reason as Error).message, "error"); }
  };
  const create = async (form: BatchForm) => {
    setBusy(true);
    setError(null);
    try {
      const { batchId } = await call<{ batchId: number }>("batches.create", form);
      setSites([emptySite()]);
      setErrors({});
      toast("建站批次已创建");
      onCreated(batchId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);

    }
  };

  const err = (k: string) => errors[k];
  const aria = (k: string) => (errors[k] ? { "aria-invalid": true, "aria-describedby": `${k}-error` } : {});

  return (
    <form onSubmit={submit} noValidate className="flex max-w-5xl flex-col gap-8">
      <div>
        <h1 className="text-lg font-semibold">建站</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          填写经营主体和每个站的商品方向，提交后系统在 Hostinger 上自动建站。退换货、隐私、关于我们等页面由 AI 按这里的真实信息撰写，不会编造资质或地址。
        </p>
      </div>

      <ol aria-label="建站步骤" className="flex gap-1 border-b text-sm">{["经营主体", "站点", "确认"].map((label, index) => <li key={label} className="flex-1"><button type="button" className={`w-full border-b-2 px-3 py-3 text-left ${step === index ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground"}`} aria-current={step === index ? "step" : undefined} disabled={index > step || busy} onClick={() => setStep(index)}>{label}</button></li>)}</ol>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {free === null && !error && <Skeleton label="正在读取可用域名" />}
      {free?.length === 0 && <div className="rounded-lg border border-dashed p-6 text-sm"><p className="font-medium">没有可用的域名</p><p className="mt-1 text-muted-foreground">先在「账号」页接入 Hostinger 账号并完成同步；已建站或在其他批次里的域名不会列出。</p></div>}
      {step === 0 && <>
      <section aria-label="主体模板" className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
        <div className="min-w-40 flex-1"><Label htmlFor="entity-template">复用经营主体模板</Label><select id="entity-template" className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm" defaultValue="" onChange={(event) => { const template = templates.find((item) => item.id === Number(event.target.value)); if (template) { const value = template.entity; setEntity(value); setDays({ p0: String(value.processingDays[0]), p1: String(value.processingDays[1]), t0: String(value.transitDays[0]), t1: String(value.transitDays[1]) }); setErrors({}); } }}><option value="">选择模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></div>
        <div className="min-w-40 flex-1"><Label htmlFor="template-name">模板名称</Label><Input id="template-name" className="mt-2" value={templateName} maxLength={100} onChange={(event) => setTemplateName(event.target.value)} placeholder="默认使用主体名称" /></div>
        <Button type="button" variant="outline" disabled={templateBusy} onClick={() => void saveEntity()}><Save aria-hidden />保存为模板</Button>
        {templates.length > 0 && <details className="basis-full text-sm"><summary className="cursor-pointer text-muted-foreground">管理已保存的模板</summary><ul className="mt-2 divide-y">{templates.map((template) => <li key={template.id} className="flex items-center justify-between py-2"><span>{template.name}</span><Button type="button" variant="ghost" size="sm" onClick={async () => { if (!await confirm({ title: `删除模板「${template.name}」？`, description: "只删除模板，不影响已有站点和批次。", destructive: true })) return; try { setTemplates(await call<typeof templates>("templates.remove", { id: template.id })); invalidateTemplates(); void refreshTemplates().catch((reason: Error) => setError(reason.message)); toast("模板已删除"); } catch (reason) { toast((reason as Error).message, "error"); } }}>删除</Button></li>)}</ul></details>}
      </section>

      <section aria-labelledby="entity-title" className="flex flex-col gap-4">
        <div>
          <h2 id="entity-title" className="text-sm font-medium">经营主体</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">本批次的所有站共用，会出现在页脚、联系页和各项政策里。</p>
        </div>
        <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="entity-kind">主体类型</Label>
            <Select value={entity.kind} onValueChange={(v) => setE({ kind: v as EntityForm["kind"] })}>
              <SelectTrigger id="entity-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="company">公司</SelectItem>
                <SelectItem value="individual">个人经营者</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entity.name">{entity.kind === "company" ? "公司法定名称" : "经营者姓名"}</Label>
            <Input id="entity.name" value={entity.name} onChange={(e) => setE({ name: e.target.value })} placeholder={entity.kind === "company" ? "例如：Nordic Paws LLC" : "例如：Jane Doe"} {...aria("entity.name")} />
            <FieldError id="entity.name-error" message={err("entity.name")} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="entity.address">地址</Label>
            <Input id="entity.address" value={entity.address} onChange={(e) => setE({ address: e.target.value })} placeholder="例如：1 Main St, Austin, TX 78701, United States" {...aria("entity.address")} />
            <FieldError id="entity.address-error" message={err("entity.address")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entity.phone">客服电话</Label>
            <Input id="entity.phone" type="tel" value={entity.phone} onChange={(e) => setE({ phone: e.target.value })} placeholder="例如：+1 512 555 0100" {...aria("entity.phone")} />
            <FieldError id="entity.phone-error" message={err("entity.phone")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entity.supportEmail">客服邮箱</Label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={autoEmail} onChange={(e) => setE({ supportEmail: e.target.checked ? "auto" : "" })} />
              使用各站自己的 support@域名
            </label>
            {!autoEmail && (
              <Input id="entity.supportEmail" type="email" value={entity.supportEmail} onChange={(e) => setE({ supportEmail: e.target.value })} placeholder="例如：help@nordicpaws.com" {...aria("entity.supportEmail")} />
            )}
            <FieldError id="entity.supportEmail-error" message={err("entity.supportEmail")} />
          </div>
          <fieldset className="flex flex-col gap-2 sm:col-span-2" {...aria("entity.shipping")}>
            <legend className="mb-2 text-sm font-medium">发货时效（工作日）</legend>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              处理
              <Input aria-label="处理时效最少天数" type="number" min={0} max={60} className="w-20" value={days.p0} onChange={(e) => setDays((d) => ({ ...d, p0: e.target.value }))} placeholder="1" />
              至
              <Input aria-label="处理时效最多天数" type="number" min={0} max={60} className="w-20" value={days.p1} onChange={(e) => setDays((d) => ({ ...d, p1: e.target.value }))} placeholder="3" />
              天，运输
              <Input aria-label="运输时效最少天数" type="number" min={1} max={60} className="w-20" value={days.t0} onChange={(e) => setDays((d) => ({ ...d, t0: e.target.value }))} placeholder="5" />
              至
              <Input aria-label="运输时效最多天数" type="number" min={1} max={60} className="w-20" value={days.t1} onChange={(e) => setDays((d) => ({ ...d, t1: e.target.value }))} placeholder="10" />
              天
            </div>
            <p className="text-xs text-muted-foreground">会原样写进运输政策和 FAQ（FTC 邮购规则要求有依据），请填你们实际能做到的。</p>
            <FieldError id="entity.shipping-error" message={err("entity.shipping")} />
          </fieldset>
        </div>
      </section>

      </>}
      {step === 1 && <section aria-labelledby="sites-title" className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="sites-title" className="text-sm font-medium">站点</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">每行一个站。只列出已同步、还没有网站的域名。</p>
          </div>
          <div className="flex flex-wrap gap-2"><input ref={csvInput} className="hidden" type="file" accept=".csv,text/csv" aria-label="导入站点 CSV" onChange={(event) => { void importCsv(event.target.files?.[0]); event.target.value = ""; }} /><Button type="button" variant="outline" size="sm" onClick={() => csvInput.current?.click()}><Upload aria-hidden />导入 CSV</Button><Button type="button" variant="outline" size="sm" onClick={() => setSites((l) => [...l, emptySite()])} disabled={!free || sites.length >= free.length}>
            <Plus aria-hidden />
            添加一个站
          </Button></div>
        </div>

        <p className="text-xs text-muted-foreground">CSV 表头：domain,brand,niche,count,price_min,price_max；支持引号内逗号。导入时校验域名、数量与售价。</p>
        {free && free.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-sm">
            <p className="font-medium">没有可用的域名</p>
            <p className="mt-1 text-muted-foreground">先在「账号」页接入 Hostinger 账号并完成同步；已经有网站或已在其他批次里的域名不会出现在这里。</p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">域名</TableHead>
                  <TableHead>商品类目</TableHead>
                  <TableHead className="w-24">商品数量</TableHead>
                  <TableHead className="w-48">售价区间（美元，可不填）</TableHead>
                  <TableHead className="w-44">品牌名</TableHead>
                  <TableHead className="w-0"><span className="sr-only">操作</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((s, i) => (
                  <TableRow key={s.rowId} className="align-top">
                    <TableCell className="whitespace-normal">
                      <Select value={s.domain} onValueChange={(v) => setS(i, { domain: v })}>
                        <SelectTrigger className="w-full" aria-label={`第 ${i + 1} 个站的域名`} {...aria(`sites.${i}.domain`)}><SelectValue placeholder="选择域名" /></SelectTrigger>
                        <SelectContent>
                          {free?.filter((d) => d.domain === s.domain || !used.has(d.domain)).map((d) => (
                            <SelectItem key={d.domain} value={d.domain}>{d.domain}<span className="text-muted-foreground">{d.accountLabel}</span></SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError id={`sites.${i}.domain-error`} message={err(`sites.${i}.domain`)} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Input aria-label={`第 ${i + 1} 个站的商品类目`} value={s.categories} onChange={(e) => setS(i, { categories: e.target.value })} placeholder="例如：dog beds, pet blankets" {...aria(`sites.${i}.categories`)} />
                      <FieldError id={`sites.${i}.categories-error`} message={err(`sites.${i}.categories`)} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Input aria-label={`第 ${i + 1} 个站的商品数量`} type="number" min={1} max={200} value={s.count} onChange={(e) => setS(i, { count: e.target.value })} {...aria(`sites.${i}.count`)} />
                      <FieldError id={`sites.${i}.count-error`} message={err(`sites.${i}.count`)} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex items-center gap-1.5">
                        <Input aria-label={`第 ${i + 1} 个站的最低售价`} type="number" min={0} step="0.01" value={s.priceMin} onChange={(e) => setS(i, { priceMin: e.target.value })} {...aria(`sites.${i}.price`)} />
                        <span className="text-muted-foreground" aria-hidden>至</span>
                        <Input aria-label={`第 ${i + 1} 个站的最高售价`} type="number" min={0} step="0.01" value={s.priceMax} onChange={(e) => setS(i, { priceMax: e.target.value })} {...aria(`sites.${i}.price`)} />
                      </div>
                      <FieldError id={`sites.${i}.price-error`} message={err(`sites.${i}.price`)} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Input aria-label={`第 ${i + 1} 个站的品牌名`} value={s.brand} onChange={(e) => setS(i, { brand: e.target.value })} placeholder={s.domain ? brandFromDomain(s.domain) : "默认取自域名"} />
                    </TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon" aria-label={`移除第 ${i + 1} 个站`} disabled={sites.length === 1} onClick={() => setSites((l) => l.filter((_, j) => j !== i))}>
                        <Trash2 aria-hidden />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <FieldError id="sites-error" message={err("sites")} />
      </section>

      }
      {step === 2 && <section aria-label="确认建站" className="space-y-5"><div><h2 className="section-title">核对经营主体</h2><p className="font-medium">{entity.name}</p><p className="text-sm text-muted-foreground">{entity.address} · {entity.phone}</p></div><div><h2 className="section-title">本批次的站点</h2><ul className="divide-y">{toForm().sites.map((site) => <li key={site.domain} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span className="font-medium">{site.domain}</span><span>{site.categories} · {site.count} 件商品{site.priceMin != null ? ` · $${site.priceMin}–$${site.priceMax ?? "不限"}` : ""}</span></li>)}</ul></div><div className="rounded-lg bg-muted/50 p-4 text-sm"><h2 className="font-medium">对买家的真实承诺</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{promises(toForm().entity).map((text) => <li key={text}>{text}</li>)}</ul></div></section>}
      <div className="flex flex-wrap items-center justify-end gap-4 border-t pt-4">
        {step > 0 && <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(step - 1)}>上一步</Button>}
        {Object.keys(errors).length > 0 && <p className="text-sm text-destructive">有 {Object.keys(errors).length} 处需要修改</p>}
        <Button type="submit" disabled={busy || !free || free.length === 0}>{busy ? "正在创建…" : step === 2 ? "开始建站" : "下一步"}</Button>
      </div>


    </form>
  );
}
