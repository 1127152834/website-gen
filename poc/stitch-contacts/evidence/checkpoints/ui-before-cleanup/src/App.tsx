import { Plus, Moon, Sun, Users, Star, ShieldCheck, X, ChevronRight } from 'lucide-react';
import { ui } from './data/mockData';
import type { Contact } from './types';
import { useContacts } from './hooks/useContacts';
import { usePresentation } from './hooks/usePresentation';
import { Sidebar } from './components/Sidebar';
import { SearchBar } from './components/SearchBar';
import { Favorites } from './components/Favorites';
import { ContactList } from './components/ContactList';
import { ContactDetail } from './components/ContactDetail';
import { ContactEditor } from './components/ContactEditor';
import { DeleteDialog } from './components/DeleteDialog';
import { DetailDialog } from './components/DetailDialog';

interface AppProps { readonly initialView?: never; }
export function App(_props: AppProps) {
  const book = useContacts();
  const view = usePresentation();
  const title = book.filter==='all' ? ui.allContacts : book.filter==='favorites' ? ui.favorites : book.filter;
  function select(contact: Contact) { book.selectContact(contact.id); if(window.matchMedia('(max-width: 900px)').matches) view.showDetail(); }
  function edit(contact: Contact) { view.closeDetail(); book.openEdit(contact); }
  function requestDelete(contact: Contact) { view.closeDetail(); book.requestDelete(contact); }
  const detailProps = book.selectedContact ? { contact:book.selectedContact,onEdit:edit,onDelete:requestDelete,onToggleFavorite:book.toggleFavorite,onCopy:view.copy } : null;
  return <div className="app-shell"><Sidebar contacts={book.contacts} filter={book.filter} onFilter={book.setFilter} onHome={book.clearFilters}/><div className="workspace"><header className="topbar"><div className="breadcrumb">{ui.appName}<ChevronRight size={14}/><span>{ui.contactsLabel}</span></div><div className="topbar-actions"><span className="local-badge"><ShieldCheck size={15}/>{ui.localOnly}</span><button className="icon-button" onClick={view.toggleTheme} aria-label={ui.themeToggle} aria-pressed={view.dark}>{view.dark?<Sun size={20}/>:<Moon size={20}/>}</button></div></header><div className="workspace-content"><main><div className="page-heading"><div><p className="eyebrow">{ui.eyebrow}</p><h1 className="page-title">{title}<span>{book.contacts.length}</span></h1><p className="page-subtitle">{ui.subtitle}</p></div><button className="button button-primary" onClick={book.openNew}><Plus size={19}/>{ui.newContact}</button></div><SearchBar query={book.query} onQuery={book.setQuery}/>{book.storageError && <p className="storage-error" role="alert">{book.storageError}</p>}{book.filter==='all' && !book.query && <Favorites contacts={book.favorites} onSelect={select} onViewAll={() => book.setFilter('favorites')}/>}<ContactList contacts={book.filteredContacts} selectedId={book.selectedId} onSelect={select} onToggleFavorite={book.toggleFavorite} onClear={book.clearFilters}/><p className="privacy-note"><ShieldCheck size={14}/>{ui.demoNotice}</p></main><aside className="desktop-detail">{detailProps ? <ContactDetail {...detailProps}/> : <div className="empty-state"><Users size={32}/><p>{ui.selectContact}</p></div>}</aside></div></div><nav className="mobile-nav" aria-label={ui.contactsLabel}><button className={`nav-button ${book.filter==='all'?'is-active':''}`} onClick={book.clearFilters}><Users size={20}/>{ui.allContacts}</button><button className={`nav-button ${book.filter==='favorites'?'is-active':''}`} onClick={() => book.setFilter('favorites')}><Star size={20}/>{ui.favorites}</button><button className="nav-button" onClick={book.openNew}><Plus size={20}/>{ui.newContact}</button></nav>{detailProps && <DetailDialog {...detailProps} open={view.detailOpen} onClose={view.closeDetail}/>} {book.editor && <ContactEditor key={book.editor.mode === 'edit' ? book.editor.contact.id : 'new'} contact={book.editor.mode === 'edit' ? book.editor.contact : undefined} onSave={book.saveContact} onClose={book.closeEditor} storageError={book.storageError}/>} {book.deleteTarget && <DeleteDialog contact={book.deleteTarget} onConfirm={book.confirmDelete} onClose={book.cancelDelete} storageError={book.storageError}/>} {(view.clipboardNotice || book.notice) && <div className="toast" role="status"><ShieldCheck size={18}/>{view.clipboardNotice || book.notice}<button className="icon-button" aria-label={ui.dismiss} onClick={book.dismissNotice}><X size={16}/></button></div>}</div>;
}

