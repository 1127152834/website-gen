import { CheckSquare2, Grid2X2, List, Search, X } from 'lucide-react';
import type { GroupId, Sort, View } from '../types';
import { groups } from '../data/mockData';
import { copy } from '../data/interfaceCopy';

interface DirectoryToolbarProps {
  readonly query: string; readonly onQuery: (value:string)=>void;
  readonly view: View; readonly onView:(value:View)=>void;
  readonly group: GroupId|'all'; readonly onGroup:(value:GroupId|'all')=>void;
  readonly sort: Sort; readonly onSort:(value:Sort)=>void;
  readonly layout:'grid'|'list'; readonly onLayout:(value:'grid'|'list')=>void;
  readonly counts:{all:number;starred:number;due:number};
  readonly selecting:boolean; readonly onSelecting:()=>void; readonly onCommand:()=>void;
}
export function DirectoryToolbar(props:DirectoryToolbarProps) {
  const tabs=[{id:'all',label:copy.tabAll},{id:'starred',label:copy.tabStars},{id:'due',label:copy.tabDue}] as const;
  return <section className="filter-toolbar" aria-label={copy.filters}>
    <div className="search-field"><Search size={18}/><input className="search-input" aria-label={copy.search} placeholder={copy.searchPlaceholder} value={props.query} onChange={e=>props.onQuery(e.target.value)}/>{props.query?<button className="icon-button" aria-label={copy.clearSearch} onClick={()=>props.onQuery('')}><X size={16}/></button>:<button className="shortcut-key" onClick={props.onCommand} aria-label={copy.commandButton}><kbd>Ctrl K</kbd></button>}</div>
    <div className="filter-row"><div className="view-tabs" aria-label={copy.filters}>{tabs.map(tab=><button key={tab.id} className={`filter-tab ${props.view===tab.id?'is-active':''}`} onClick={()=>props.onView(tab.id)} aria-pressed={props.view===tab.id}>{tab.label}<span className="tab-count">{props.counts[tab.id]}</span></button>)}</div><div className="toolbar-controls"><select className="select-field" aria-label={copy.groups} value={props.group} onChange={e=>props.onGroup(e.target.value as GroupId|'all')}><option value="all">{copy.groupAll}</option>{groups.map(group=><option key={group.id} value={group.id}>{group.label}</option>)}</select><select className="select-field sort-select" aria-label={copy.sort} value={props.sort} onChange={e=>props.onSort(e.target.value as Sort)}><option value="recent">{copy.sortRecent}</option><option value="name">{copy.sortName}</option><option value="followup">{copy.sortFollowUp}</option></select><div className="layout-switch"><button className={`icon-button ${props.layout==='grid'?'is-active':''}`} aria-label={copy.grid} aria-pressed={props.layout==='grid'} onClick={()=>props.onLayout('grid')}><Grid2X2 size={18}/></button><button className={`icon-button ${props.layout==='list'?'is-active':''}`} aria-label={copy.list} aria-pressed={props.layout==='list'} onClick={()=>props.onLayout('list')}><List size={19}/></button></div><button className={`button secondary selection-toggle ${props.selecting?'is-active':''}`} aria-pressed={props.selecting} onClick={props.onSelecting}><CheckSquare2 size={16}/><span>{props.selecting?copy.exitSelection:copy.selectMode}</span></button></div></div>
  </section>;
}
