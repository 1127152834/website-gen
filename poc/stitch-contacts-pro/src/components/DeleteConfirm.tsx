import { AlertTriangle, Trash2 } from 'lucide-react'
import { copy } from '../data/dialogCopy.ts'
import { useDialog } from '../hooks/useDialog.ts'
import type { Contact } from '../types.ts'

export interface DeleteConfirmProps {
  readonly contacts: readonly Contact[]
  readonly onClose: () => void
  readonly onConfirm: () => boolean
  readonly storageError: string
}

export function DeleteConfirm({ contacts, onClose, onConfirm, storageError }: DeleteConfirmProps) {
  const dialogRef = useDialog(true)
  const confirm = () => { if (onConfirm()) onClose() }

  return <dialog ref={dialogRef} className="modal confirm-modal" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={onClose}>
    <div className="confirm-dialog">
      <span className="confirm-dialog__icon"><AlertTriangle aria-hidden="true" /></span>
      <div className="confirm-dialog__content"><h2 id="delete-title">{copy.deleteTitle}</h2>
        <p id="delete-description">{contacts.length === 1 ? copy.deleteSingle : copy.deleteMany(contacts.length)}</p>
        <ul className="confirm-dialog__names">{contacts.slice(0, 4).map((contact) => <li key={contact.id}>{contact.name}</li>)}{contacts.length > 4 && <li>… +{contacts.length - 4}</li>}</ul>
        <p className="confirm-dialog__hint">{copy.deleteUndoHint}</p>{storageError && <p className="inline-alert" role="alert">{storageError}</p>}
      </div>
      <footer className="confirm-dialog__actions"><button autoFocus type="button" className="button button--ghost" onClick={onClose}>{copy.cancel}</button><button type="button" className="button button--danger" onClick={confirm}><Trash2 aria-hidden="true" />{copy.confirmDelete}</button></footer>
    </div>
  </dialog>
}
