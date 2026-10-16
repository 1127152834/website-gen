import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, LockKeyhole, Plus, RefreshCw, X } from "lucide-react";
import { call, invalidateRpcData, useRpcData } from "@/lib/backend.ts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Skeleton } from "@/components/page-state";
import { toast } from "@/components/feedback";
import { AttachmentChips, AttachmentGrid } from "./grist-attachments.tsx";
import {
  canEditGristColumn, gristCellDisplay, gristCellInput, gristColumnChoices, gristDocUrl,
  parseGristCellInput, rowDetailColumns, sectionColumnToGristColumn, type GristAttachment, type GristColumn,
  type GristDoc, type GristDocStructure, type GristOrg, type GristRecord, type GristSettings,
  type GristStructurePage, type GristStructureSection, type GristWorkspace,
} from "./grist-table-helpers.ts";

interface Selection { orgId: string; workspaceId: string; docId: string; itemKey: string }
interface PageRecordsResponse {
  tables: Record<string, { records: GristRecord[]; truncated: boolean }>;
  attachments: GristAttachment[];
}

const EMPTY_SELECTION: Selection = { orgId: "", workspaceId: "", docId: "", itemKey: "" };
const GRIST_TOPICS = ["grist"] as const;

function readSelection(userId: number): Selection {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`grist-selection:${userId}`) ?? "null");
    if (stored && typeof stored === "object") {
      const value = stored as Record<string, unknown>;
      return {
        orgId: typeof value.orgId === "string" ? value.orgId : "",
        workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : "",
        docId: typeof value.docId === "string" ? value.docId : "",
        itemKey: typeof value.itemKey === "string" ? value.itemKey : typeof value.tableId === "string" && value.tableId ? `raw:${value.tableId}` : "",
      };
    }
  } catch { /* 存储被禁用时仍可正常使用表格。 */ }
  return { ...EMPTY_SELECTION };
}

export function TablesPage({ userId, onNavigate }: { userId: number; onNavigate: (path: string) => void }) {
  const [selection, setSelection] = useState<Selection>(() => readSelection(userId));
  const settingsState = useRpcData<GristSettings>("grist.settings.get", undefined, { topics: GRIST_TOPICS });
  const settings = settingsState.data;
  const orgsState = useRpcData<GristOrg[]>("grist.listOrgs", settings?.configured ? undefined : null, { topics: GRIST_TOPICS });
  const orgs = orgsState.data ?? [];
  const orgValid = orgs.some((org) => String(org.id) === selection.orgId);
  const workspacesState = useRpcData<GristWorkspace[]>("grist.listWorkspaces", orgValid ? { orgId: Number(selection.orgId) } : null, { topics: GRIST_TOPICS });
  const workspaces = workspacesState.data ?? [];
  const workspaceValid = workspaces.some((workspace) => String(workspace.id) === selection.workspaceId);
  const docsState = useRpcData<GristDoc[]>("grist.listDocs", workspaceValid ? { workspaceId: Number(selection.workspaceId) } : null, { topics: GRIST_TOPICS });
  const docs = docsState.data ?? [];
  const docValid = docs.some((doc) => doc.id === selection.docId);
  const structureState = useRpcData<GristDocStructure>("grist.getDocStructure", docValid ? { docId: selection.docId } : null, { topics: GRIST_TOPICS });
  const structure = structureState.data;

  useEffect(() => { try { localStorage.setItem(`grist-selection:${userId}`, JSON.stringify(selection)); } catch { /* 仅在当前页面保留选择。 */ } }, [selection, userId]);
  useEffect(() => {
    if (!orgsState.data) return;
    setSelection((current) => orgs.some((org) => String(org.id) === current.orgId) ? current : { ...EMPTY_SELECTION, orgId: orgs[0] ? String(orgs[0].id) : "" });
  }, [orgs, orgsState.data]);
  useEffect(() => {
    if (!workspacesState.data) return;
    setSelection((current) => workspaces.some((workspace) => String(workspace.id) === current.workspaceId) ? current : { ...current, workspaceId: workspaces[0] ? String(workspaces[0].id) : "", docId: "", itemKey: "" });
  }, [workspaces, workspacesState.data]);
  useEffect(() => {
    if (!docsState.data) return;
    setSelection((current) => docs.some((doc) => doc.id === current.docId) ? current : { ...current, docId: docs[0]?.id ?? "", itemKey: "" });
  }, [docs, docsState.data]);

  const itemKeys = useMemo(() => structure ? [
    ...structure.pages.map((page) => `page:${page.id}`),
    ...structure.rawTables.map((table) => `raw:${table.tableId}`),
  ] : [], [structure]);
  useEffect(() => {
    if (!structure) return;
    setSelection((current) => itemKeys.includes(current.itemKey) ? current : { ...current, itemKey: itemKeys[0] ?? "" });
  }, [itemKeys, structure]);

  const selectedPage = selection.itemKey.startsWith("page:") ? structure?.pages.find((page) => `page:${page.id}` === selection.itemKey) : undefined;
  const selectedRawTable = selection.itemKey.startsWith("raw:") ? structure?.rawTables.find((table) => `raw:${table.tableId}` === selection.itemKey) : undefined;
  const selectedSections: GristStructureSection[] = selectedPage
    ? selectedPage.sections.filter((section) => section.parentKey === "record")
    : selectedRawTable ? [{ id: selectedRawTable.rawViewSectionRef, parentKey: "record", title: "", tableRef: selectedRawTable.tableRef, tableId: selectedRawTable.tableId, columns: selectedRawTable.columns }] : [];
  const tableIds = [...new Set(selectedSections.map((section) => section.tableId))];
  // Include hidden attachment fields for the whole-row drawer in the same metadata batch.
  const attachmentColumns = Object.fromEntries(tableIds.map((tableId) => [tableId, [...new Set((structure?.tables.find((table) => table.tableId === tableId)?.columns ?? []).filter((column) => column.type === "Attachments").map((column) => column.colId))]]));
  // Wait for structure before asking for records. This keeps opening a document to
  // exactly one structure RPC plus one page-data RPC, even with a persisted tab.
  const recordsParams = selection.docId && selection.itemKey && selectedSections.length > 0 ? { docId: selection.docId, tableIds, attachmentColumns, limit: 1000 } : null;
  const pageDataState = useRpcData<PageRecordsResponse>("grist.getPageRecords", recordsParams, { topics: GRIST_TOPICS });

  const org = orgs.find((item) => String(item.id) === selection.orgId);
  const doc = docs.find((item) => item.id === selection.docId);
  const docUrl = settings && org && doc ? gristDocUrl(settings.baseUrl, org.domain, doc) : null;
  const hierarchyRefreshing = settingsState.refreshing || orgsState.refreshing || workspacesState.refreshing || docsState.refreshing || structureState.refreshing;
  const error = settingsState.error ?? orgsState.error ?? workspacesState.error ?? docsState.error ?? structureState.error;
  const refreshHierarchy = async () => {
    await settingsState.refresh();
    if (settings?.configured) await orgsState.refresh();
    if (orgValid) await workspacesState.refresh();
    if (workspaceValid) await docsState.refresh();
    if (docValid) await structureState.refresh();
  };

  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold tracking-tight">表格</h1><p className="mt-1 text-sm text-muted-foreground">按 Grist 页面浏览文档；点击行号查看整行，点击支持编辑的单元格即可修改。</p></div><div className="flex items-center gap-2">{hierarchyRefreshing && settings && <span role="status" className="text-xs text-muted-foreground">刷新中</span>}<Button variant="outline" disabled={settingsState.loading || hierarchyRefreshing} onClick={() => void refreshHierarchy()}><RefreshCw className={hierarchyRefreshing ? "motion-safe:animate-spin" : ""} aria-hidden />刷新列表</Button></div></header>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"><span>{error.message}</span><Button variant="outline" size="sm" onClick={() => void refreshHierarchy()}>重试</Button></div>}
    {settingsState.loading ? <Skeleton label="正在读取 Grist 连接" /> : !settings?.configured ? <EmptyState title="还没有连接 Grist" action={<Button onClick={() => onNavigate("/settings")}>前往设置 Grist</Button>}>在设置中保存 Grist 地址和 API Key 后，即可浏览当前用户有权访问的团队站点、文档和页面。</EmptyState> : <>
      <div className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-3">
        <HierarchySelect id="grist-org" label="团队站点" value={selection.orgId} options={orgs.map((item) => ({ id: String(item.id), name: item.name }))} placeholder={orgsState.loading ? "正在读取…" : "暂无团队站点"} onChange={(orgId) => setSelection({ ...EMPTY_SELECTION, orgId })} />
        <HierarchySelect id="grist-workspace" label="工作空间" value={selection.workspaceId} options={workspaces.map((item) => ({ id: String(item.id), name: item.name }))} disabled={workspacesState.loading} placeholder={workspacesState.loading ? "正在读取…" : "暂无工作空间"} onChange={(workspaceId) => setSelection((current) => ({ ...current, workspaceId, docId: "", itemKey: "" }))} />
        <div className="space-y-2"><HierarchySelect id="grist-doc" label="文档" value={selection.docId} options={docs} disabled={docsState.loading || workspacesState.loading} placeholder={docsState.loading ? "正在读取…" : "暂无文档"} onChange={(docId) => setSelection((current) => ({ ...current, docId, itemKey: "" }))} />{docUrl && <a className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-ring" href={docUrl} target="_blank" rel="noopener noreferrer">在 Grist 中打开<ExternalLink className="size-3" aria-hidden /><span className="sr-only">（新标签页）</span></a>}</div>
      </div>
      {structureState.loading ? <Skeleton label="正在读取文档页面" /> : structure && itemKeys.length > 0 ? <div className="space-y-4">
        <DocumentTabs structure={structure} value={selection.itemKey} onChange={(itemKey) => setSelection((current) => ({ ...current, itemKey }))} />
        <section id="grist-table-panel" role="tabpanel">
          {selectedSections.length > 0 ? <PageTables key={`${selection.docId}:${selection.itemKey}`} docId={selection.docId} sections={selectedSections} tables={structure.tables} state={pageDataState} /> : <EmptyState title="这个页面没有表格组件">卡片、自定义组件等非表格组件本期不在这里显示。</EmptyState>}
        </section>
      </div> : docValid && !error ? <EmptyState title="该文档没有页面或原始数据表">请在 Grist 中创建页面和表后刷新列表。</EmptyState> : !error && <EmptyState title={orgs.length === 0 ? "没有可访问的团队站点" : workspaces.length === 0 ? "该团队站点没有工作空间" : "该工作空间没有文档"}>切换上方选择，或在 Grist 中创建内容后刷新列表。</EmptyState>}
    </>}
  </div>;
}

function HierarchySelect({ id, label, value, options, placeholder, disabled, onChange }: { id: string; label: string; value: string; options: { id: string; name: string }[]; placeholder: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Select value={options.some((option) => option.id === value) ? value : undefined} disabled={disabled || options.length === 0} onValueChange={onChange}><SelectTrigger id={id} className="w-full"><SelectValue placeholder={placeholder} /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent></Select></div>;
}

function DocumentTabs({ structure, value, onChange }: { structure: GristDocStructure; value: string; onChange: (key: string) => void }) {
  return <div role="tablist" aria-label="文档中的页面" className="flex items-end gap-1 overflow-x-auto border-b">
    {structure.pages.map((page) => <PageTab key={page.id} page={page} selected={value === `page:${page.id}`} onClick={() => onChange(`page:${page.id}`)} />)}
    {structure.rawTables.length > 0 && <><span aria-hidden className="mx-2 h-6 border-l" /><span className="shrink-0 px-2 py-3 text-xs font-medium text-muted-foreground">原始数据</span>{structure.rawTables.map((table) => <button key={table.tableId} role="tab" type="button" aria-selected={value === `raw:${table.tableId}`} onClick={() => onChange(`raw:${table.tableId}`)} className={`shrink-0 border-b-2 px-3 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${value === `raw:${table.tableId}` ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{table.tableId}</button>)}</>}
  </div>;
}

function PageTab({ page, selected, onClick }: { page: GristStructurePage; selected: boolean; onClick: () => void }) {
  return <button role="tab" type="button" aria-selected={selected} onClick={onClick} style={{ paddingLeft: `${1 + Math.max(0, page.indentation) * 0.75}rem` }} className={`shrink-0 border-b-2 py-3 pr-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{page.indentation > 0 && <span aria-hidden className="mr-1 text-muted-foreground">↳</span>}{page.name}</button>;
}

function PageTables({ docId, sections, tables, state }: { docId: string; sections: GristStructureSection[]; tables: GristDocStructure["tables"]; state: ReturnType<typeof useRpcData<PageRecordsResponse>> }) {
  const [openRow, setOpenRow] = useState<{ sectionId: number; recordId: number } | null>(null);
  const attachments = useMemo(() => new Map((state.data?.attachments ?? []).map((attachment) => [attachment.id, attachment])), [state.data?.attachments]);
  const save = async (tableId: string, recordId: number, column: GristColumn, value: unknown) => {
    await call("grist.updateRecords", { docId, tableId, records: [{ id: recordId, fields: { [column.id]: value } }] });
    invalidateRpcData("grist.getPageRecords");
    await state.refresh();
    toast("单元格已保存");
  };
  const add = async (tableId: string) => {
    await call("grist.addRecords", { docId, tableId, records: [{ fields: {} }] });
    invalidateRpcData("grist.getPageRecords");
    await state.refresh();
    toast("已新增一行；超过 1000 行时，请在 Grist 中查看新行");
  };
  if (state.loading) return <Skeleton label="正在读取页面数据" />;
  const openSection = openRow ? sections.find((section) => section.id === openRow.sectionId) : undefined;
  const detailSection = openSection ? { ...openSection, columns: rowDetailColumns(openSection.columns, tables.find((table) => table.tableId === openSection.tableId)?.columns) } : undefined;
  const openRecord = openSection && openRow ? state.data?.tables[openSection.tableId]?.records.find((record) => record.id === openRow.recordId) : undefined;
  return <div className="space-y-6">
    {state.refreshing && <div role="status" className="flex justify-end text-xs text-muted-foreground"><LoaderCircle className="mr-1 size-3.5 motion-safe:animate-spin" aria-hidden />刷新中</div>}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error.message}</p>}
    {sections.map((section, index) => <GristSectionTable key={section.id || `${section.tableId}:${index}`} docId={docId} section={section} data={state.data?.tables[section.tableId]} attachments={attachments} showTitle={sections.length > 1 || Boolean(section.title.trim())} onRefresh={() => void state.refresh()} onAdd={() => add(section.tableId)} onSave={(recordId, column, value) => save(section.tableId, recordId, column, value)} onOpenRow={(recordId) => setOpenRow({ sectionId: section.id, recordId })} />)}
    <RowDrawer docId={docId} section={detailSection} record={openRecord} attachments={attachments} open={Boolean(openSection && openRecord)} onOpenChange={(open) => { if (!open) setOpenRow(null); }} onSave={(recordId, column, value) => openSection ? save(openSection.tableId, recordId, column, value) : Promise.resolve()} />
  </div>;
}

function GristSectionTable({ docId, section, data, attachments, showTitle, onRefresh, onAdd, onSave, onOpenRow }: {
  docId: string; section: GristStructureSection; data?: { records: GristRecord[]; truncated: boolean }; attachments: ReadonlyMap<number, GristAttachment>; showTitle: boolean;
  onRefresh: () => void; onAdd: () => Promise<void>; onSave: (recordId: number, column: GristColumn, value: unknown) => Promise<void>; onOpenRow: (recordId: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const columns = section.columns.map(sectionColumnToGristColumn);
  const records = data?.records ?? [];
  const add = async () => { if (adding) return; setAdding(true); try { await onAdd(); } catch (reason) { toast((reason as Error).message); } finally { setAdding(false); } };
  return <section className="space-y-3">
    {showTitle && <h2 className="text-sm font-semibold">{section.title.trim() || section.tableId}</h2>}
    <div className="flex flex-wrap items-center justify-between gap-3"><p role="status" className="text-sm text-muted-foreground">{data?.truncated ? "仅显示前 1000 行" : `${records.length} 行`}<span className="ml-3 text-xs">日期按 UTC 日历日显示与保存</span></p><div className="flex gap-2"><Button variant="outline" size="sm" disabled={adding} onClick={onRefresh}><RefreshCw aria-hidden />刷新数据</Button><Button size="sm" disabled={adding} onClick={() => void add()}>{adding ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Plus aria-hidden />}新增一行</Button></div></div>
    {columns.length > 0 ? <div className="overflow-x-auto rounded-lg border bg-card"><Table><caption className="sr-only">{section.title || section.tableId}，最多显示前 1000 行；点击行号查看详情，点击非只读单元格编辑。</caption><TableHeader><TableRow><TableHead scope="col" className="w-16 text-muted-foreground">行 ID</TableHead>{columns.map((column) => <TableHead key={column.id} scope="col"><span className="inline-flex items-center gap-1.5">{column.fields.label || column.id}{!canEditGristColumn(column) && column.fields.type !== "Attachments" && <LockKeyhole className="size-3 text-muted-foreground" aria-label="只读" />}</span><span className="mt-0.5 block text-xs font-normal text-muted-foreground">{column.fields.isFormula ? "公式 · " : ""}{column.fields.type || "Any"}</span></TableHead>)}</TableRow></TableHeader><TableBody>{records.map((record) => <TableRow key={record.id}><TableHead scope="row" className="h-auto font-normal tabular-nums text-muted-foreground"><button type="button" className="rounded px-2 py-1 underline-offset-4 hover:underline focus-visible:outline-ring" aria-label={`查看第 ${record.id} 行详情`} onClick={() => onOpenRow(record.id)}>{record.id}</button></TableHead>{columns.map((column) => <TableCell key={column.id} className="min-w-36 max-w-80 p-1">{column.fields.type === "Attachments" ? <AttachmentChips docId={docId} value={record.fields[column.id]} attachments={attachments} /> : <GristCell column={column} value={record.fields[column.id]} rowId={record.id} onSave={(value) => onSave(record.id, column, value)} />}</TableCell>)}</TableRow>)}{records.length === 0 && <TableRow><TableCell colSpan={columns.length + 1} className="h-28 text-center text-muted-foreground">这张表还没有数据，点击“新增一行”开始。</TableCell></TableRow>}</TableBody></Table></div> : <EmptyState title="这个表格组件没有可见列">请在 Grist 页面中显示列后刷新。</EmptyState>}
  </section>;
}

function RowDrawer({ docId, section, record, attachments, open, onOpenChange, onSave }: { docId: string; section?: GristStructureSection; record?: GristRecord; attachments: ReadonlyMap<number, GristAttachment>; open: boolean; onOpenChange: (open: boolean) => void; onSave: (recordId: number, column: GristColumn, value: unknown) => Promise<void> }) {
  if (!section || !record) return null;
  const columns = section.columns.map(sectionColumnToGristColumn);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="!top-0 !right-0 !bottom-0 !left-auto h-dvh !max-w-xl !translate-x-0 !translate-y-0 content-start overflow-y-auto rounded-none p-6 sm:w-[min(42rem,calc(100vw-2rem))]" aria-describedby="grist-row-description"><DialogHeader><DialogTitle>{section.title.trim() || section.tableId} · 第 {record.id} 行</DialogTitle><DialogDescription id="grist-row-description">按页面组件中的列顺序显示；附件只读，本期不支持上传或删除。</DialogDescription></DialogHeader><div className="space-y-5">{columns.map((column) => <div key={column.id} className="grid gap-2 border-b pb-4 sm:grid-cols-[10rem_minmax(0,1fr)]"><div><Label>{column.fields.label || column.id}</Label><p className="mt-1 text-xs text-muted-foreground">{column.fields.isFormula ? "公式 · " : ""}{column.fields.type || "Any"}</p></div><div className="min-w-0">{column.fields.type === "Attachments" ? <AttachmentGrid docId={docId} value={record.fields[column.id]} attachments={attachments} /> : <GristCell column={column} value={record.fields[column.id]} rowId={record.id} onSave={(value) => onSave(record.id, column, value)} />}</div></div>)}</div></DialogContent></Dialog>;
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
    try { next = parseGristCellInput(column, input); } catch (reason) { setError((reason as Error).message); return; }
    if (Object.is(next, value) || (next === null && value == null)) { setEditing(false); setError(null); return; }
    lock.current = true; setSaving(true); setError(null);
    try { await onSave(next); setEditing(false); } catch (reason) { setError((reason as Error).message); } finally { lock.current = false; setSaving(false); }
  };
  if (!canEditGristColumn(column)) return <span className="block max-w-80 truncate px-2 py-2 text-muted-foreground" title={gristCellDisplay(column, value)}>{gristCellDisplay(column, value) || "—"}</span>;
  if (column.fields.type === "Bool") return <div className="px-2 py-2"><input type="checkbox" className="size-4 accent-primary focus-visible:outline-ring" checked={Boolean(value)} disabled={saving} aria-label={name} onChange={(event) => void save(event.target.checked)} />{saving && <span role="status" className="ml-2 text-xs text-muted-foreground">保存中…</span>}{error && <p role="alert" className="mt-1 whitespace-normal text-xs text-destructive">{error}</p>}</div>;
  if (!editing) return <button type="button" aria-label={`编辑 ${name}`} title="点击编辑；回车或移开焦点保存" className="block min-h-9 w-full max-w-80 truncate rounded px-2 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { setDraft(gristCellInput(column, value)); setEditing(true); setError(null); }}>{gristCellDisplay(column, value) || <span className="text-muted-foreground">—</span>}</button>;
  return <form className="min-w-52 p-1" onSubmit={(event) => { event.preventDefault(); void save(inputRef.current?.value ?? draft); }}><div className="flex items-center gap-1"><Input ref={inputRef} autoFocus aria-label={name} aria-invalid={Boolean(error)} aria-describedby={error ? `${listId}-error` : undefined} className="h-8 min-w-28" type={column.fields.type === "Date" ? "date" : column.fields.type === "Numeric" || column.fields.type === "Int" ? "number" : "text"} step={column.fields.type === "Int" ? 1 : "any"} list={choices.length ? listId : undefined} value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => { if (!cancelBlur.current) void save(event.currentTarget.value); cancelBlur.current = false; }} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelBlur.current = true; setEditing(false); setError(null); } }} /><Button type="submit" variant="ghost" size="icon-sm" aria-label={`保存 ${name}`} disabled={saving} onMouseDown={(event) => event.preventDefault()}>{saving ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Check aria-hidden />}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={`取消编辑 ${name}`} disabled={saving} onMouseDown={(event) => { event.preventDefault(); cancelBlur.current = true; }} onClick={() => { setEditing(false); setError(null); cancelBlur.current = false; }}><X aria-hidden /></Button></div>{choices.length > 0 && <datalist id={listId}>{choices.map((choice) => <option key={choice} value={choice} />)}</datalist>}{error && <p id={`${listId}-error`} role="alert" className="mt-1 whitespace-normal text-xs text-destructive">{error}</p>}</form>;
}
