import { useCallback, useEffect, useRef, useState } from 'react';
import { useBook } from './useBook';
import { copy } from '../data/interfaceCopy';
import type { Contact } from '../types';

export function useWorkspace() {
  const book = useBook();
  const [dark, setDark] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1100px)').matches);
  const sidebarRef = useRef<HTMLElement>(null);
  const [clipboardNotice, setClipboardNotice] = useState('');

  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => { setCompact(media.matches); if (!media.matches) setMenuOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!menuOpen || !compact) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('button, a[href], input, select, [tabindex="0"]') ?? []).filter(el => el.offsetParent !== null);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('dialog[open]') && previous?.isConnected) previous.focus();
    };
  }, [menuOpen, compact]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!document.querySelector('dialog[open]')) { setMenuOpen(false); setCommandOpen(true); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!clipboardNotice) return;
    const timer = window.setTimeout(() => setClipboardNotice(''), 3500);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  const copyValue = useCallback(async (value: string) => {
    try { await navigator.clipboard.writeText(value); setClipboardNotice(copy.copied); }
    catch { setClipboardNotice(copy.copyError); }
  }, []);

  function edit(contact: Contact) { book.closeDetail(); book.openEdit(contact); }
  function remove(ids: string[]) { book.closeDetail(); book.requestDelete(ids); }
  function dismissNotice() { setClipboardNotice(''); book.dismissNotice(); }
  function openNew() { setMenuOpen(false); setCommandOpen(false); book.openNew(); }
  function chooseContact(id: string) { setCommandOpen(false); book.openContact(id); }
  function changeView(view: 'all'|'starred'|'due') { book.setView(view); setMenuOpen(false); }
  function chooseGroup(id: 'all'|'work'|'friends'|'family'|'partners') { book.setGroupFilter(id); setMenuOpen(false); }
  function home() { book.resetFilters(); setMenuOpen(false); }

  return {
    book, dark, toggleTheme: () => setDark(value => !value), commandOpen,
    openCommand: () => { setMenuOpen(false); setCommandOpen(true); }, closeCommand: () => setCommandOpen(false),
    compact, sidebarRef,
    menuOpen, toggleMenu: () => setMenuOpen(value => !value), closeMenu: () => setMenuOpen(false),
    copyValue, notice: clipboardNotice || book.notice, dismissNotice,
    edit, remove, openNew, chooseContact, changeView, chooseGroup, home,
  };
}
