import { useEffect, useState } from 'react';
import { ui } from '../data/mockData';

export function usePresentation() {
  const [dark, setDark] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState('');
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  useEffect(() => {
    if (!clipboardNotice) return;
    const timer = window.setTimeout(() => setClipboardNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setClipboardNotice(ui.copied); }
    catch { setClipboardNotice(ui.copyFailed); }
  }
  return { dark, toggleTheme: () => setDark(value => !value), detailOpen,
    showDetail: () => setDetailOpen(true), closeDetail: () => setDetailOpen(false), copy, clipboardNotice };
}
