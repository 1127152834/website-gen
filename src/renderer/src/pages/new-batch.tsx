import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { FreeDomain } from "../../../shared/protocol.ts";
import { brandFromDomain, validateBatch, type BatchForm, type EntityForm } from "../../../shared/forms.ts";
import { call, onChanged, onConnect } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// 输入框里的数字先按字符串存，提交时再转换，避免输入到一半就被改写
interface SiteDraft { domain: string; categories: string; count: string; priceMin: string; priceMax: string; brand: string }
const emptySite = (): SiteDraft => ({ domain: "", categories: "", count: "20", priceMin: "", priceMax: "", brand: "" });
const emptyEntity = (): EntityForm => ({ kind: "company", name: "", address: "", supportEmail: "auto", phone: "", shipping: "" });
const num = (s: string) => (s.trim() === "" ? null : Number(s));

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p id={id} className="text-xs text-destructive">{message}</p> : null;
}

export function NewBatchPage({ onCreated }: { onCreated: (batchId: number) => void }) {
  const [free, setFree] = useState<FreeDomain[] | null>(null);
  const [entity, setEntity] = useState<EntityForm>(emptyEntity);
  const [sites, setSites] = useState<SiteDraft[]>([emptySite()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<BatchForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    call<FreeDomain[]>("domains.free").then(setFree, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const offs = [onConnect(load), onChanged("accounts", load), onChanged("batches", load)];
    return () => offs.forEach((off) => off());
  }, [load]);

  const setE = (patch: Partial<EntityForm>) => setEntity((e) => ({ ...e, ...patch }));
  const setS = (i: number, patch: Partial<SiteDraft>) => setSites((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const used = new Set(sites.map((s) => s.domain).filter(Boolean));
  const autoEmail = entity.supportEmail === "auto";

  const toForm = (): BatchForm => ({
    entity,
    sites: sites.map((s) => ({
      domain: s.domain, categories: s.categories, count: Number(s.count), priceMin: num(s.priceMin), priceMax: num(s.priceMax), brand: s.brand.trim(),
    })),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const form = toForm();
    const found = validateBatch(form);
    setErrors(found);
    if (Object.keys(found).length === 0) setConfirming(form);
  };

  const create = async (form: BatchForm) => {
    setBusy(true);
    setError(null);
    try {
      const { batchId } = await call<{ batchId: number }>("batches.create", form);
      setSites([emptySite()]);
      setErrors({});
      onCreated(batchId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirming(null);
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

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

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
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="entity.shipping">处理与运输时效</Label>
            <Input id="entity.shipping" value={entity.shipping} onChange={(e) => setE({ shipping: e.target.value })} placeholder="例如：1–3 个工作日处理，5–10 个工作日送达美国" {...aria("entity.shipping")} />
            <FieldError id="entity.shipping-error" message={err("entity.shipping")} />
          </div>
        </div>
      </section>

      <section aria-labelledby="sites-title" className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 id="sites-title" className="text-sm font-medium">站点</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">每行一个站。只列出已同步、还没有网站的域名。</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setSites((l) => [...l, emptySite()])} disabled={!free || sites.length >= free.length}>
            <Plus aria-hidden />
            添加一个站
          </Button>
        </div>

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
                  <TableRow key={i} className="align-top">
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

      <div className="flex items-center justify-end gap-4 border-t pt-4">
        {Object.keys(errors).length > 0 && <p className="text-sm text-destructive">有 {Object.keys(errors).length} 处需要修改</p>}
        <Button type="submit" disabled={busy || !free || free.length === 0}>开始建站</Button>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>为 {confirming?.sites.length} 个域名建站？</AlertDialogTitle>
            <AlertDialogDescription>
              系统会在 Hostinger 上为下面的域名创建网站，安装 WordPress、WooCommerce 和 Obel 主题，并部署伴侣插件。新站默认开启维护模式，访客暂时看不到。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 overflow-auto rounded-md border px-3 py-2 text-sm">
            {confirming?.sites.map((s) => <li key={s.domain} className="py-0.5">{s.domain}</li>)}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); if (confirming) void create(confirming); }}>开始建站</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
