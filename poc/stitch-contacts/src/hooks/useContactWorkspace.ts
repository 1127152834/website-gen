import type { Contact } from '../types';
import { useContacts } from './useContacts';
import { usePresentation } from './usePresentation';

type ContactBook = ReturnType<typeof useContacts>;
type Presentation = ReturnType<typeof usePresentation>;

interface ContactWorkspace {
  readonly book: ContactBook;
  readonly view: Presentation;
  readonly select: (contact: Contact) => void;
  readonly edit: (contact: Contact) => void;
  readonly requestDelete: (contact: Contact) => void;
  readonly dismissNotice: () => void;
}

export function useContactWorkspace(): ContactWorkspace {
  const book = useContacts();
  const view = usePresentation();

  function select(contact: Contact): void {
    book.selectContact(contact.id);
    if (window.matchMedia('(max-width: 900px)').matches) {
      view.showDetail();
    }
  }

  function edit(contact: Contact): void {
    view.closeDetail();
    book.openEdit(contact);
  }

  function requestDelete(contact: Contact): void {
    view.closeDetail();
    book.requestDelete(contact);
  }

  function dismissNotice(): void {
    view.dismissClipboardNotice();
    book.dismissNotice();
  }

  return { book, view, select, edit, requestDelete, dismissNotice };
}
