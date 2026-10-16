// Adapted from shadcn-admin by Sat Naing (MIT). See renderer/THIRD_PARTY_NOTICES.
import { useMemo, useState, type ReactNode } from 'react';
import { flexRender, getCoreRowModel, getFacetedRowModel, getFacetedUniqueValues, getFilteredRowModel, getPaginationRowModel, getSortedRowModel, useReactTable, type Column, type ColumnDef, type ColumnFiltersState, type SortingState, type VisibilityState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export function DataTableColumnHeader<T, V>({ column, title }: { column: Column<T,V>; title: string }) {
  if (!column.getCanSort()) return <span>{title}</span>;
  const Icon = column.getIsSorted() === 'asc' ? ArrowUp : column.getIsSorted() === 'desc' ? ArrowDown : ArrowUpDown;
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="-ml-2 h-8" aria-label={`${title}排序`}>{title}<Icon className="size-3.5" aria-hidden /></Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => column.toggleSorting(false)}>升序</DropdownMenuItem><DropdownMenuItem onSelect={() => column.toggleSorting(true)}>降序</DropdownMenuItem><DropdownMenuItem onSelect={() => column.clearSorting()}>取消排序</DropdownMenuItem>{column.getCanHide() && <><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => column.toggleVisibility(false)}>隐藏此列</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu>;
}

type Filter = { columnId: string; title: string; options: { label: string; value: string }[] };
export type DataTableProps<T> = {
  data: T[];
  columns: ColumnDef<T, any>[];
  searchPlaceholder?: string;
  searchKey?: string;
  filterKey?: string;
  filterOptions?: { label: string; value: string }[];
  filters?: Filter[];
  rowActions?: (row: T) => ReactNode;
  getRowId?: (row: T) => string;
  emptyMessage?: string;
  toolbar?: ReactNode;
  pageSize?: number;
  className?: string;
};

export function DataTable<T>({ data, columns, searchPlaceholder='搜索…', searchKey, filterKey, filterOptions=[], filters=[], rowActions, getRowId, emptyMessage='没有匹配的记录。请调整筛选条件。', toolbar, pageSize=10, className }: DataTableProps<T>) {
  const [sorting,setSorting]=useState<SortingState>([]);
  const [columnFilters,setColumnFilters]=useState<ColumnFiltersState>([]);
  const [columnVisibility,setColumnVisibility]=useState<VisibilityState>({});
  const [globalFilter,setGlobalFilter]=useState('');
  const actualColumns=useMemo(() => {
    const base=columns.map(column => ({...column, filterFn: column.filterFn ?? ((row: any, id: string, value: unknown) => Array.isArray(value) ? value.includes(String(row.getValue(id))) : String(row.getValue(id) ?? '').toLocaleLowerCase().includes(String(value).toLocaleLowerCase()))}));
    return rowActions ? [...base, {id:'actions',header:'操作',enableSorting:false,enableHiding:false,cell:({row}: any) => rowActions(row.original)}] : base;
  },[columns,rowActions]);
  const table=useReactTable({data,columns:actualColumns,state:{sorting,columnFilters,columnVisibility,globalFilter},onSortingChange:setSorting,onColumnFiltersChange:setColumnFilters,onColumnVisibilityChange:setColumnVisibility,onGlobalFilterChange:setGlobalFilter,getCoreRowModel:getCoreRowModel(),getFilteredRowModel:getFilteredRowModel(),getSortedRowModel:getSortedRowModel(),getPaginationRowModel:getPaginationRowModel(),getFacetedRowModel:getFacetedRowModel(),getFacetedUniqueValues:getFacetedUniqueValues(),getRowId,initialState:{pagination:{pageSize}}});
  const facets=filterKey ? [...filters,{columnId:filterKey,title:'筛选',options:filterOptions}] : filters;
  const filtered=columnFilters.length>0 || globalFilter!=='';
  return <div className={className ?? 'min-w-0 space-y-4'}>
    <div className="flex flex-wrap items-center gap-2"><Input aria-label={searchPlaceholder} placeholder={searchPlaceholder} className="h-8 w-full sm:w-64" value={searchKey ? String(table.getColumn(searchKey)?.getFilterValue() ?? '') : globalFilter} onChange={e => searchKey ? table.getColumn(searchKey)?.setFilterValue(e.target.value) : setGlobalFilter(e.target.value)} />
      {facets.map(filter => {const column=table.getColumn(filter.columnId); if(!column)return null; const selected=(column.getFilterValue() ?? []) as string[]; return <DropdownMenu key={filter.columnId}><DropdownMenuTrigger asChild><Button size="sm" variant="outline" className="border-dashed">{filter.title}{selected.length>0 && <span className="rounded bg-secondary px-1.5 tabular-nums">{selected.length}</span>}</Button></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuLabel>{filter.title}</DropdownMenuLabel>{filter.options.map(option => <DropdownMenuCheckboxItem key={option.value} checked={selected.includes(option.value)} onSelect={e=>e.preventDefault()} onCheckedChange={checked=>{const next=checked?[...selected,option.value]:selected.filter(v=>v!==option.value);column.setFilterValue(next.length?next:undefined);}}>{option.label}<span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">{column.getFacetedUniqueValues().get(option.value) ?? 0}</span></DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu>;})}
      {filtered && <Button variant="ghost" size="sm" onClick={()=>{table.resetColumnFilters();setGlobalFilter('');}}>重置<X aria-hidden /></Button>}{toolbar}
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm" className="ml-auto"><SlidersHorizontal aria-hidden />显示列</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>切换显示列</DropdownMenuLabel><DropdownMenuSeparator />{table.getAllLeafColumns().filter(c=>c.getCanHide()).map(column=><DropdownMenuCheckboxItem key={column.id} checked={column.getIsVisible()} onCheckedChange={value=>column.toggleVisibility(!!value)}>{typeof column.columnDef.header==='string'?column.columnDef.header:column.id}</DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu>
    </div>
    <div className="max-w-full overflow-x-auto rounded-md border"><Table><TableHeader>{table.getHeaderGroups().map(group=><TableRow key={group.id}>{group.headers.map(header=><TableHead key={header.id} aria-sort={header.column.getIsSorted()==='asc'?'ascending':header.column.getIsSorted()==='desc'?'descending':undefined}>{header.isPlaceholder?null:typeof header.column.columnDef.header==='string'?<DataTableColumnHeader column={header.column} title={header.column.columnDef.header}/>:flexRender(header.column.columnDef.header,header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.length ? table.getRowModel().rows.map(row=><TableRow key={row.id}>{row.getVisibleCells().map(cell=><TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell,cell.getContext())}</TableCell>)}</TableRow>):<TableRow><TableCell colSpan={table.getVisibleLeafColumns().length} className="h-28 text-center text-muted-foreground">{emptyMessage}</TableCell></TableRow>}</TableBody></Table></div>
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm"><span className="tabular-nums text-muted-foreground">共 {table.getFilteredRowModel().rows.length} 条记录</span><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2">每页<select aria-label="每页条数" className="h-8 rounded-md border bg-background px-2" value={table.getState().pagination.pageSize} onChange={e=>table.setPageSize(Number(e.target.value))}>{[10,20,30,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><span className="mx-2 tabular-nums">第 {table.getState().pagination.pageIndex+1} / {Math.max(1,table.getPageCount())} 页</span>{[{label:'第一页',icon:ChevronsLeft,disabled:!table.getCanPreviousPage(),action:()=>table.setPageIndex(0)},{label:'上一页',icon:ChevronLeft,disabled:!table.getCanPreviousPage(),action:()=>table.previousPage()},{label:'下一页',icon:ChevronRight,disabled:!table.getCanNextPage(),action:()=>table.nextPage()},{label:'最后一页',icon:ChevronsRight,disabled:!table.getCanNextPage(),action:()=>table.setPageIndex(table.getPageCount()-1)}].map(({label,icon:Icon,disabled,action})=><Button key={label} size="icon-sm" variant="outline" disabled={disabled} aria-label={label} onClick={action}><Icon aria-hidden /></Button>)}</div></div>
  </div>;
}
