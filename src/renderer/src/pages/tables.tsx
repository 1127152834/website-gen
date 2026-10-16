import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, LockKeyhole, Plus, RefreshCw, X } from "lucide-react";
import { call } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Skeleton } from "@/components/page-state";
import { toast } from "@/components/feedback";
import { canEditGristColumn, gristCellDisplay, gristCellInput, gristColumnChoices, gristDocUrl, parseGristCellInput, visibleGristRecords, type GristColumn, type GristDoc, type GristOrg, type GristRecord, type GristSettings, type GristTable, type GristWorkspace } from "./grist-table-helpers.ts";

interface Selection { orgId: string; workspaceId: string; docId: string; tableId: string }
const EMPTY_SELECTION: Selection = { orgId: "", workspaceId: "", docId: "", tableId: "" };
function readSelection(userId: number): Selection {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`grist-selection:${userId}`) ?? "null");
    if (stored && typeof stored === "object") return {
      orgId: "orgId" in stored && typeof stored.orgId === "string" ? stored.orgId : "",
      workspaceId: "workspaceId" in stored && typeof stored.workspaceId === "string" ? stored.workspaceId : "",
      docId: "docId" in stored && typeof stored.docId === "string" ? stored.docId : "",
      tableId: "tableId" in stored && typeof stored.tableId === "string" ? stored.tableId : "",
    };
  } catch { /* 存储被禁用时仍可正常使用表格。 */ }
  return { ...EMPTY_SELECTION };
}

export function TablesPage({ userId, onNavigate }: { userId: number; onNavigate: (path: string) => void }) {
  const [settings, setSettings] = useState<GristSettings | null>(null);
  const [selection, setSelection] = useState<Selection>(() => readSelection(userId));
  const [orgs, setOrgs] = useState<GristOrg[]>([]);
  const [workspaces, setWorkspaces] = useState<GristWorkspace[]>([]);
  const [docs, setDocs] = useState<GristDoc[]>([]);
  const [tables, setTables] = useState<GristTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState({ workspaces: false, docs: false, tables: false });
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => { try { localStorage.setItem(`grist-selection:${userId}`, JSON.stringify(selection)); } catch { /* 仅在当前页面保留选择。 */ } }, [selection, userId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    void (async () => {
      try {
        const next = await call<GristSettings>("grist.settings.get");
        if (cancelled) return;
        setSettings(next);
        if (!next.configured) { setOrgs([]); return; }
        const nextOrgs = await call<GristOrg[]>("grist.listOrgs");
        if (cancelled) return;
        setOrgs(nextOrgs);
        setSelection((current) => nextOrgs.some((org) => String(org.id) === current.orgId) ? current : { ...EMPTY_SELECTION, orgId: nextOrgs[0] ? String(nextOrgs[0].id) : "" });
      } catch (reason) { if (!cancelled) setError((reason as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaces([]); setDocs([]); setTables([]);
    setBusy({ workspaces: false, docs: false, tables: false });
    if (!settings?.configured || !orgs.some((org) => String(org.id) === selection.orgId)) return;
    setBusy((value) => ({ ...value, workspaces: true })); setError(null);
    void call<GristWorkspace[]>("grist.listWorkspaces", { orgId: Number(selection.orgId) }).then((next) => {
      if (cancelled) return;
      setWorkspaces(next);
      setSelection((current) => next.some((workspace) => String(workspace.id) === current.workspaceId) ? current : { ...current, workspaceId: next[0] ? String(next[0].id) : "", docId: "", tableId: "" });
    }, (reason: Error) => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setBusy((value) => ({ ...value, workspaces: false })); });
    return () => { cancelled = true; };
  }, [settings?.configured, selection.orgId, orgs]);

  useEffect(() => {
    let cancelled = false;
    setDocs([]); setTables([]);
    setBusy((value) => ({ ...value, docs: false, tables: false }));
    if (!workspaces.some((workspace) => String(workspace.id) === selection.workspaceId)) return;
    setBusy((value) => ({ ...value, docs: true })); setError(null);
    void call<GristDoc[]>("grist.listDocs", { workspaceId: Number(selection.workspaceId) }).then((next) => {
      if (cancelled) return;
      setDocs(next);
      setSelection((current) => next.some((doc) => doc.id === current.docId) ? current : { ...current, docId: next[0]?.id ?? "", tableId: "" });
    }, (reason: Error) => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setBusy((value) => ({ ...value, docs: false })); });
    return () => { cancelled = true; };
  }, [selection.workspaceId, workspaces]);

  useEffect(() => {
    let cancelled = false;
    setTables([]);
    setBusy((value) => ({ ...value, tables: false }));
    if (!docs.some((doc) => doc.id === selection.docId)) return;
    setBusy((value) => ({ ...value, tables: true })); setError(null);
    void call<{ tables: GristTable[] }>("grist.getTables", { docId: selection.docId }).then((next) => {
      if (cancelled) return;
      setTables(next.tables);
      setSelection((current) => next.tables.some((table) => table.id === current.tableId) ? current : { ...current, tableId: next.tables[0]?.id ?? "" });
    }, (reason: Error) => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setBusy((value) => ({ ...value, tables: false })); });
    return () => { cancelled = true; };
  }, [selection.docId, docs]);

  const org = orgs.find((item) => String(item.id) === selection.orgId);
  const doc = docs.find((item) => item.id === selection.docId);
  const docUrl = settings && org && doc ? gristDocUrl(settings.baseUrl, org.domain, doc) : null;
  const hierarchyBusy = busy.workspaces || busy.docs || busy.tables;
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">表格</h1><p className="mt-1 text-sm text-muted-foreground">浏览 Grist 文档，点击支持编辑的单元格即可修改。公式与复杂类型保持只读。</p></div><Button variant="outline" disabled={loading || hierarchyBusy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden />刷新列表</Button></header>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><span>{error}</span><Button variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>重试</Button></div>}
    {loading ? <Skeleton label="正在读取 Grist 连接" /> : !settings?.configured ? <EmptyState title="还没有连接 Grist" action={<Button onClick={() => onNavigate("/settings")}>前往设置 Grist</Button>}>在设置中保存 Grist 地址和 API Key 后，即可浏览当前用户有权限访问的团队站点、文档和表格。</EmptyState> : <>
      <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <HierarchySelect id="grist-org" label="团队站点" value={selection.orgId} options={orgs.map((item) => ({ id: String(item.id), name: item.name }))} placeholder="暂无团队站点" onChange={(orgId) => setSelection({ ...EMPTY_SELECTION, orgId })} />
        <HierarchySelect id="grist-workspace" label="工作空间" value={selection.workspaceId} options={workspaces.map((item) => ({ id: String(item.id), name: item.name }))} disabled={busy.workspaces} placeholder={busy.workspaces ? "正在读取…" : "暂无工作空间"} onChange={(workspaceId) => setSelection((current) => ({ ...current, workspaceId, docId: "", tableId: "" }))} />
        <div className="space-y-2"><HierarchySelect id="grist-doc" label="文档" value={selection.docId} options={docs} disabled={busy.docs || busy.workspaces} placeholder={busy.docs ? "正在读取…" : "暂无文档"} onChange={(docId) => setSelection((current) => ({ ...current, docId, tableId: "" }))} />{docUrl && <a className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-ring" href={docUrl} target="_blank" rel="noopener noreferrer">在 Grist 中打开<ExternalLink className="size-3" aria-hidden /><span className="sr-only">（新标签页）</span></a>}</div>
      </div>
      {hierarchyBusy ? <Skeleton label="正在读取文档与表格" /> : tables.length > 0 ? <div className="space-y-4"><div role="tablist" aria-label="文档中的表" className="flex gap-1 overflow-x-auto border-b">{tables.map((table) => <button key={table.id} id={`grist-tab-${encodeURIComponent(table.id)}`} role="tab" type="button" aria-selected={selection.tableId === table.id} aria-controls="grist-table-panel" onClick={() => setSelection((current) => ({ ...current, tableId: table.id }))} className={`shrink-0 border-b-2 px-4 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selection.tableId === table.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{table.id}</button>)}</div><section id="grist-table-panel" role="tabpanel" aria-labelledby={`grist-tab-${encodeURIComponent(selection.tableId)}`}>{tables.some((table) => table.id === selection.tableId) && <GristTableData key={`${selection.docId}:${selection.tableId}`} docId={selection.docId} tableId={selection.tableId} />}</section></div> : !error && <EmptyState title={orgs.length === 0 ? "没有可访问的团队站点" : workspaces.length === 0 ? "该团队站点没有工作空间" : docs.length === 0 ? "该工作空间没有文档" : "该文档没有表"}>切换上方选择，或在 Grist 中创建文档与表后刷新列表。</EmptyState>}
    </>}
  </div>;
}

function HierarchySelect({ id, label, value, options, placeholder, disabled, onChange }: { id: string; label: string; value: string; options: { id: string; name: string }[]; placeholder: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Select value={options.some((option) => option.id === value) ? value : undefined} disabled={disabled || options.length === 0} onValueChange={onChange}><SelectTrigger id={id} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent></Select></div>;
}

function GristTableData({ docId, tableId }: { docId: string; tableId: string }) {
  const [columns, setColumns] = useState<GristColumn[]>([]);
  const [records, setRecords] = useState<GristRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const writeLock = useRef(false);
  const recordRead = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    const read = ++recordRead.current;
    setLoading(true); setError(null);
    void Promise.all([call<{ columns: GristColumn[] }>("grist.getTableColumns", { docId, tableId }), call<{ records: GristRecord[] }>("grist.listRecords", { docId, tableId, limit: 1001 })]).then(([nextColumns, nextRecords]) => {
      if (cancelled || read !== recordRead.current) return;
      const visible = visibleGristRecords(nextRecords.records);
      setColumns(nextColumns.columns); setRecords(visible.records); setTruncated(visible.truncated);
    }, (reason: Error) => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId, tableId, refresh]);
  const save = async (recordId: number, column: GristColumn, value: unknown) => {
    await call("grist.updateRecords", { docId, tableId, records: [{ id: recordId, fields: { [column.id]: value } }] });
    if (!alive.current) return;
    // 仅在 PATCH 成功后更新本地值；后台重读同步公式，不卸载其他正在编辑的单元格。
    setRecords((current) => current.map((record) => record.id === recordId ? { ...record, fields: { ...record.fields, [column.id]: value } } : record));
    const read = ++recordRead.current;
    void call<{ records: GristRecord[] }>("grist.listRecords", { docId, tableId, limit: 1001 }).then((next) => {
      if (!alive.current || read !== recordRead.current) return;
      const visible = visibleGristRecords(next.records);
      setRecords(visible.records); setTruncated(visible.truncated);
    }, (reason: Error) => { if (alive.current && read === recordRead.current) setError(`单元格已保存，但重新读取数据失败：${reason.message}`); });
    toast("单元格已保存");
  };
  const add = async () => {
    if (writeLock.current) return;
    writeLock.current = true; setAdding(true); setError(null);
    try {
      await call("grist.addRecords", { docId, tableId, records: [{ fields: {} }] });
      if (!alive.current) return;
      setRefresh((value) => value + 1); toast("已新增一行；超过 1000 行时，请在 Grist 中查看新行");
    } catch (reason) { if (alive.current) setError((reason as Error).message); }
    finally { writeLock.current = false; if (alive.current) setAdding(false); }
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">{truncated ? "仅显示前 1000 行" : `${records.length} 行`}<span className="ml-3 text-xs">日期按 UTC 日历日期显示与保存</span></p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={loading || adding} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden />刷新数据</Button><Button size="sm" disabled={loading || adding} onClick={() => void add()}>{adding ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Plus aria-hidden />}新增一行</Button></div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {loading ? <Skeleton label="正在读取表格数据" /> : columns.length > 0 ? <div className="rounded-lg border bg-card"><Table><caption className="sr-only">{tableId}，最多显示前 1000 行；点击非只读单元格编辑，回车或移开焦点保存，Esc 取消。</caption><TableHeader><TableRow><TableHead scope="col" className="w-16 text-muted-foreground">行 ID</TableHead>{columns.map((column) => <TableHead key={column.id} scope="col"><span className="inline-flex items-center gap-1.5">{column.fields.label || column.id}{!canEditGristColumn(column) && <LockKeyhole className="size-3 text-muted-foreground" aria-label="只读" />}</span><span className="mt-0.5 block text-xs font-normal text-muted-foreground">{column.fields.isFormula ? "公式 · " : ""}{column.fields.type || "Any"}</span></TableHead>)}</TableRow></TableHeader><TableBody>{records.map((record) => <TableRow key={record.id}><TableHead scope="row" className="h-auto font-normal tabular-nums text-muted-foreground">{record.id}</TableHead>{columns.map((column) => <TableCell key={column.id} className="min-w-36 max-w-80 p-1"><GristCell column={column} value={record.fields[column.id]} rowId={record.id} onSave={(value) => save(record.id, column, value)} /></TableCell>)}</TableRow>)}{records.length === 0 && <TableRow><TableCell colSpan={columns.length + 1} className="h-28 text-center text-muted-foreground">这张表还没有数据，点击「新增一行」开始。</TableCell></TableRow>}</TableBody></Table></div> : !error && <EmptyState title="这张表没有可显示的列">请在 Grist 中添加列后刷新。</EmptyState>}
  </div>;
}

function GristCell({ column, value, rowId, onSave }: { column: GristColumn; value: unknown; rowId: number; onSave: (value: unknown) => Promise<void> }) {
  const listId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => gristCellInput(column, value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelBlur = useRef(false);
  const name = `${column.fields.label || column.id}，行 ${rowId}`;
  const choices = gristColumnChoices(column);
  const save = async (input: string | boolean) => {
    if (lock.current) return;
    let next: unknown;
    try { next = parseGristCellInput(column, input); }
    catch (reason) { setError((reason as Error).message); return; }
    if (Object.is(next, value) || (next === null && value == null)) { setEditing(false); setError(null); return; }
    lock.current = true; setSaving(true); setError(null);
    try { await onSave(next); setEditing(false); }
    catch (reason) { setError((reason as Error).message); }
    finally { lock.current = false; setSaving(false); }
  };
  if (!canEditGristColumn(column)) return <span className="block max-w-80 truncate px-2 py-2 text-muted-foreground" title={gristCellDisplay(column, value)}>{gristCellDisplay(column, value) || "—"}</span>;
  if (column.fields.type === "Bool") return <div className="px-2 py-2"><input type="checkbox" className="size-4 accent-primary focus-visible:outline-ring" checked={Boolean(value)} disabled={saving} aria-label={name} onChange={(event) => void save(event.target.checked)} />{saving && <span role="status" className="ml-2 text-xs text-muted-foreground">保存中…</span>}{error && <p role="alert" className="mt-1 whitespace-normal text-xs text-destructive">{error}</p>}</div>;
  if (!editing) return <button type="button" aria-label={`编辑 ${name}`} title="点击编辑；回车或移开焦点保存" className="block min-h-9 w-full max-w-80 truncate rounded px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setDraft(gristCellInput(column, value)); setEditing(true); setError(null); }}>{gristCellDisplay(column, value) || <span className="text-muted-foreground">—</span>}</button>;
  return <form className="min-w-52 p-1" onSubmit={(event) => { event.preventDefault(); void save(inputRef.current?.value ?? draft); }}><div className="flex items-center gap-1"><Input ref={inputRef} autoFocus aria-label={name} aria-invalid={Boolean(error)} aria-describedby={error ? `${listId}-error` : undefined} className="h-8 min-w-28" type={column.fields.type === "Date" ? "date" : column.fields.type === "Numeric" || column.fields.type === "Int" ? "number" : "text"} step={column.fields.type === "Int" ? 1 : "any"} list={choices.length ? listId : undefined} value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => { if (!cancelBlur.current) void save(event.currentTarget.value); cancelBlur.current = false; }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelBlur.current = true; setEditing(false); setError(null); } }} /><Button type="submit" variant="ghost" size="icon-sm" aria-label={`保存 ${name}`} disabled={saving} onMouseDown={(event) => event.preventDefault()}>{saving ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Check aria-hidden />}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={`取消编辑 ${name}`} disabled={saving} onMouseDown={(event) => { event.preventDefault(); cancelBlur.current = true; }} onClick={() => { setEditing(false); setError(null); cancelBlur.current = false; }}><X aria-hidden /></Button></div>{choices.length > 0 && <datalist id={listId}>{choices.map((choice) => <option key={choice} value={choice} />)}</datalist>}{error && <p id={`${listId}-error`} role="alert" className="mt-1 whitespace-normal text-xs text-destructive">{error}</p>}</form>;
}
