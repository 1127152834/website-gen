import { useCallback, useEffect, useState } from 'react';
import { useBook } from './useBook';
import { copy } from '../data/interfaceCopy';
import type { Contact } from '../types';

export function useWorkspace() {
  const book = useBook();
  const [dark, setDark] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState('');

  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!document.querySelector('dialog[open]')) setCommandOpen(true);
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
    openCommand: () => setCommandOpen(true), closeCommand: () => setCommandOpen(false),
    menuOpen, toggleMenu: () => setMenuOpen(value => !value), closeMenu: () => setMenuOpen(false),
    copyValue, notice: clipboardNotice || book.notice, dismissNotice,
    edit, remove, openNew, chooseContact, changeView, chooseGroup, home,
  };
}
