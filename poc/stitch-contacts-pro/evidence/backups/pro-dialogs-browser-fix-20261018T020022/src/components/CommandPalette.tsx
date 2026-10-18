import { Building2, CornerDownLeft, Mail, Plus, Search, X } from 'lucide-react'
import { useId } from 'react'
import { Avatar } from './Avatar.tsx'
import { copy } from '../data/dialogCopy.ts'
import { useCommandPalette } from '../hooks/useCommandPalette.ts'
import { useDialog } from '../hooks/useDialog.ts'
import type { Contact } from '../types.ts'

export interface CommandPaletteProps {
  readonly contacts: readonly Contact[]
  readonly onSelect: (id: string) => void
  readonly onClose: () => void
  readonly onNew: () => void
}

export function CommandPalette({ contacts, onSelect, onClose, onNew }: CommandPaletteProps) {
  const dialogRef = useDialog(true)
  const listId = useId()
  const choose = (contact: Contact) => { onClose(); onSelect(contact.id) }
  const palette = useCommandPalette({ contacts, onSelect: choose })
  const create = () => { onClose(); onNew() }

  return <dialog ref={dialogRef} className="modal command-modal" aria-labelledby="command-title" onCancel={onClose}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="command-palette">
      <header className="command-palette__header"><div><span className="eyebrow">{copy.commandEyebrow}</span><h2 id="command-title">{copy.commandTitle}</h2></div><button type="button" className="icon-button" aria-label={copy.close} onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="command-search"><Search aria-hidden="true" /><input autoFocus role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
        aria-activedescendant={palette.results[palette.activeIndex] ? `${listId}-${palette.results[palette.activeIndex].id}` : undefined}
        value={palette.query} placeholder={copy.commandPlaceholder} onChange={(event) => palette.setQuery(event.target.value)} onKeyDown={palette.onKeyDown} /></div>
      <div className="command-results" id={listId} role="listbox" aria-label={copy.commandTitle}>
        {palette.results.map((contact, index) => <button type="button" role="option" aria-selected={index === palette.activeIndex}
          id={`${listId}-${contact.id}`} key={contact.id} className={`command-result${index === palette.activeIndex ? ' is-active' : ''}`}
          onMouseEnter={() => palette.setActiveIndex(index)} onClick={() => choose(contact)}>
          <Avatar contact={contact} size="sm" /><span className="command-result__identity"><strong>{contact.name}</strong><small>{contact.role || contact.email || copy.emptyValue}</small></span>
          <span className="command-result__meta">{contact.company && <span><Building2 aria-hidden="true" />{contact.company}</span>}{contact.email && <span><Mail aria-hidden="true" />{contact.email}</span>}</span>
          {index === palette.activeIndex && <CornerDownLeft className="command-result__enter" aria-hidden="true" />}
        </button>)}
        {!palette.results.length && <p className="command-empty">{copy.commandNoResults}</p>}
      </div>
      <footer className="command-palette__footer"><button type="button" className="command-new" accessKey="n" onClick={create}><Plus aria-hidden="true" /><span>{copy.commandNew}</span><kbd>{copy.commandNewHint}</kbd></button><span>{copy.commandHint}</span></footer>
    </div>
  </dialog>
}
