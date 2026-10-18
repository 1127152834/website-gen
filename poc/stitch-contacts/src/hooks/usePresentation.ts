import { useEffect, useState } from 'react';
import { ui } from '../data/mockData';

interface Presentation {
  readonly dark: boolean;
  readonly toggleTheme: () => void;
  readonly detailOpen: boolean;
  readonly showDetail: () => void;
  readonly closeDetail: () => void;
  readonly copy: (value: string) => Promise<void>;
  readonly clipboardNotice: string;
  readonly dismissClipboardNotice: () => void;
}

export function usePresentation(): Presentation {
  const [dark, setDark] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState('');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  useEffect(() => {
    if (!clipboardNotice) {
      return;
    }

    const timer = window.setTimeout(() => setClipboardNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setClipboardNotice(ui.copied);
    } catch {
      setClipboardNotice(ui.copyFailed);
    }
  }

  return {
    dark,
    toggleTheme: () => setDark(value => !value),
    detailOpen,
    showDetail: () => setDetailOpen(true),
    closeDetail: () => setDetailOpen(false),
    copy,
    clipboardNotice,
    dismissClipboardNotice: () => setClipboardNotice(''),
  };
}
