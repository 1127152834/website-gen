import { ArrowUpRight, ChevronRight, Download, Menu, Moon, Plus, ShieldCheck, Sun, X, Check, Undo2 } from 'lucide-react';
import { useWorkspace } from './hooks/useWorkspace';
import { groups } from './data/mockData';
import { copy } from './data/interfaceCopy';
import type { GroupId } from './types';
import { Sidebar } from './components/Sidebar';
import { RelationshipHero } from './components/RelationshipHero';
import { DirectoryToolbar } from './components/DirectoryToolbar';
import { ContactDirectory } from './components/ContactDirectory';
import { BulkToolbar } from './components/BulkToolbar';
import { ContactDrawer } from './components/ContactDrawer';
import { ContactEditor } from './components/ContactEditor';
import { CommandPalette } from './components/CommandPalette';
import { DeleteConfirm } from './components/DeleteConfirm';

interface AppProps { readonly initialView?: never; }
export function App(_props:AppProps) {
  const w=useWorkspace(), b=w.book;
  const groupCounts=Object.fromEntries(groups.map(g=>[g.id,b.contacts.filter(c=>c.groupId===g.id).length])) as Record<GroupId,number>;
  const heading=b.view==='starred'?copy.starred:b.view==='due'?copy.due:copy.title;
  return <div className="app-shell">
    <Sidebar view={b.view} group={b.groupFilter} counts={b.counts} groupCounts={groupCounts} open={w.menuOpen} onView={w.changeView} onGroup={w.chooseGroup} onHome={w.home} onNew={w.openNew} onCommand={w.openCommand} onClose={w.closeMenu}/>
    <div className="app-workspace"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label={copy.menu} aria-expanded={w.menuOpen} onClick={w.toggleMenu}><Menu size={21}/></button><span>{copy.breadcrumb}</span><ChevronRight size={13}/><strong>{copy.breadcrumbCurrent}</strong></div><div className="topbar-right"><span className="local-status"><span/>{copy.localBadge}</span><button className="icon-button" aria-label={copy.theme} aria-pressed={w.dark} onClick={w.toggleTheme}>{w.dark?<Sun size={19}/>:<Moon size={19}/>}</button><span className="profile-label">{copy.profileInitial}</span></div></header>
      <main className="page-content"><div className="page-heading"><div className="heading-copy"><p className="eyebrow">{copy.eyebrow}</p><h1 className="page-title">{heading}<span className="version-pill">{copy.edition}</span></h1><p className="page-subtitle">{copy.subtitle}</p></div><div className="heading-actions"><button className="button secondary" onClick={b.exportContacts}><Download size={17}/>{copy.export}</button><button className="button primary" onClick={w.openNew}><Plus size={18}/>{copy.newContact}</button></div></div>
      {b.storageError&&<div className="storage-error" role="alert">{b.storageError}</div>}
      {b.view==='all'&&!b.query&&b.groupFilter==='all'&&<RelationshipHero contacts={b.contacts} counts={b.counts} onDue={()=>w.changeView('due')} onOpen={b.openContact}/>}
      <DirectoryToolbar query={b.query} onQuery={b.setQuery} view={b.view} onView={w.changeView} group={b.groupFilter} onGroup={w.chooseGroup} sort={b.sort} onSort={b.setSort} layout={b.layout} onLayout={b.setLayout} counts={b.counts} selecting={b.selecting} onSelecting={b.toggleSelecting} onCommand={w.openCommand}/>
      <ContactDirectory contacts={b.filtered} total={b.contacts.length} layout={b.layout} selectedIds={b.selectedIds} selecting={b.selecting} onOpen={b.openContact} onStar={b.toggleStar} onSelect={b.toggleSelection} onTag={b.setQuery} onReset={b.resetFilters}/>
      <footer className="page-footer"><span><ShieldCheck size={14}/>{copy.localFootnote}</span><a href={copy.compareUrl} target="_blank" rel="noreferrer">{copy.compare}<ArrowUpRight size={14}/></a></footer></main>
    </div>
    {b.selecting&&<BulkToolbar count={b.selectedIds.length} onSelectVisible={b.selectVisible} onClear={b.clearSelection} onStar={b.starSelected} onDelete={()=>w.remove(b.selectedIds)} onClose={b.toggleSelecting}/>}
    {b.focused&&<ContactDrawer key={b.focused.id} contact={b.focused} onClose={b.closeDetail} onEdit={w.edit} onStar={b.toggleStar} onDelete={w.remove} onAddNote={b.addNote} onFollowUp={b.setFollowUp} onContacted={b.markContacted} onCopy={w.copyValue} storageError={b.storageError}/>}
    {b.editor&&<ContactEditor key={b.editor.contact?.id??'new'} contact={b.editor.contact} onSave={b.saveContact} onClose={b.closeEditor} storageError={b.storageError}/>}
    {w.commandOpen&&<CommandPalette contacts={b.contacts} onSelect={w.chooseContact} onClose={w.closeCommand} onNew={w.openNew}/>}
    {b.deleteIds&&<DeleteConfirm contacts={b.contacts.filter(c=>b.deleteIds!.includes(c.id))} onClose={b.cancelDelete} onConfirm={b.confirmDelete} storageError={b.storageError}/>}
    {(w.notice||b.canUndo)&&<div className="toast" role="status"><span className="toast-content"><Check size={17}/>{w.notice}</span>{b.canUndo&&<button className="button ghost" onClick={b.undoDelete}><Undo2 size={16}/>{copy.undo}</button>}<button className="icon-button" aria-label={copy.dismiss} onClick={w.dismissNotice}><X size={17}/></button></div>}
  </div>;
}
