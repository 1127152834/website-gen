import { ArrowUpRight, BookOpen, Clock3, Command, LockKeyhole, Plus, Search, Star, Users, X } from 'lucide-react';
import type { GroupId, View } from '../types';
import type { RefObject } from 'react';
import { groups } from '../data/mockData';
import { copy } from '../data/interfaceCopy';

interface SidebarProps {
  readonly view: View;
  readonly group: GroupId | 'all';
  readonly counts: { all: number; starred: number; due: number };
  readonly groupCounts: Readonly<Record<GroupId, number>>;
  readonly open: boolean;
  readonly compact: boolean;
  readonly sidebarRef: RefObject<HTMLElement | null>;
  readonly onView: (view: View) => void;
  readonly onGroup: (group: GroupId) => void;
  readonly onHome: () => void;
  readonly onNew: () => void;
  readonly onCommand: () => void;
  readonly onClose: () => void;
}
export function Sidebar({ view, group, counts, groupCounts, open, compact, sidebarRef, onView, onGroup, onHome, onNew, onCommand, onClose }: SidebarProps) {
  const nav = [{ id: 'all', label: copy.all, Icon: Users }, { id: 'starred', label: copy.starred, Icon: Star }, { id: 'due', label: copy.due, Icon: Clock3 }] as const;
  return <>
    {open && <button className="rail-overlay" onClick={onClose} aria-label={copy.closeMenu} tabIndex={-1} aria-hidden="true"/>}
    <aside ref={sidebarRef} className={`side-rail ${open ? 'is-open' : ''}`} inert={compact && !open} role={compact && open ? 'dialog' : undefined} aria-modal={compact && open ? true : undefined} aria-label={copy.space}>
      <button className="rail-brand" onClick={onHome} aria-label={copy.brandLabel}><span className="brand-seal">{copy.brand.slice(0,1)}</span><span><strong className="brand-wordmark">{copy.brand}<em>{copy.edition}</em></strong><span className="brand-subtitle">{copy.localTitle}</span></span></button>
      <button className="button primary rail-create" onClick={onNew}><Plus size={17}/>{copy.newContact}</button>
      <div className="rail-section">{copy.space}</div>
      <nav className="rail-nav" aria-label={copy.space}>
        {nav.map(({id,label,Icon}) => <button className={`nav-item ${view===id ? 'is-active' : ''}`} key={id} aria-pressed={view===id} onClick={()=>onView(id)}><Icon size={18}/><span>{label}</span><span className="nav-count">{counts[id]}</span></button>)}
        <div className="rail-section">{copy.groups}</div>
        {groups.map((item,index)=><button key={item.id} className={`nav-item group-nav ${group===item.id?'is-active':''}`} onClick={()=>onGroup(item.id)} aria-pressed={group===item.id}><span className={`nav-dot color-${['sage','rose','gold','blue'][index]}`}/><span>{item.label}</span><span className="nav-count">{groupCounts[item.id]}</span></button>)}
      </nav>
      <div className="rail-bottom"><button className="rail-shortcut" onClick={onCommand}><span className="shortcut-icon"><Command size={18}/></span><strong>{copy.keyboardTitle}</strong><span>{copy.keyboardHint}</span><kbd>Ctrl K</kbd></button><a className="compare-link" href={copy.compareUrl} target="_blank" rel="noreferrer"><BookOpen size={17}/>{copy.compare}<ArrowUpRight size={15}/></a><div className="rail-profile"><span className="profile-label">{copy.profileInitial}</span><div><strong><LockKeyhole size={12}/>{copy.localTitle}</strong><small>{copy.localSubtitle}</small></div></div></div>
      {open && <button className="icon-button mobile-rail-close" aria-label={copy.closeMenu} onClick={onClose}><X size={20}/></button>}
    </aside>
  </>;
}
