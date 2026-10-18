import type { JSX } from 'react';
import { ui } from '../data/mockData';
import { useDialog } from '../hooks/useDialog';
import type { Contact } from '../types';

interface DeleteDialogProps {
  readonly contact: Contact;
  readonly onConfirm: () => boolean;
  readonly onClose: () => void;
  readonly storageError: string;
}

export function DeleteDialog({
  contact,
  onConfirm,
  onClose,
  storageError,
}: DeleteDialogProps): JSX.Element {
  const dialogRef = useDialog(true);

  return (
    <dialog
      ref={dialogRef}
      className="dialog delete-dialog"
      aria-labelledby="delete-title"
      aria-describedby="delete-description"
      onCancel={onClose}
    >
      <header className="dialog-heading">
        <h2 id="delete-title">{ui.deleteTitle}</h2>
      </header>
      <div className="dialog-body">
        <strong>{contact.name}</strong>
        <p id="delete-description">{ui.deleteDescription}</p>
        {storageError && (
          <p className="storage-error" role="alert">
            {storageError}
          </p>
        )}
      </div>
      <footer className="dialog-footer">
        <button autoFocus className="button button-secondary" onClick={onClose}>
          {ui.cancel}
        </button>
        <button className="button button-danger" onClick={onConfirm}>
          {ui.confirmDelete}
        </button>
      </footer>
    </dialog>
  );
}
