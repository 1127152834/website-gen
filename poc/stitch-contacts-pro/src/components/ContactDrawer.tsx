import { CalendarCheck, Check, Clipboard, Clock3, Edit3, Mail, MapPin, Phone, Plus, Star, Trash2, X } from 'lucide-react'
import { Avatar } from './Avatar.tsx'
import { copy } from '../data/dialogCopy.ts'
import { useContactDetail, type ContactDetailTab } from '../hooks/useContactDetail.ts'
import { useDialog } from '../hooks/useDialog.ts'
import type { Contact } from '../types.ts'

export interface ContactDrawerProps {
  readonly contact: Contact
  readonly onClose: () => void
  readonly onEdit: (contact: Contact) => void
  readonly onStar: (id: string) => void
  readonly onDelete: (ids: string[]) => void
  readonly onAddNote: (id: string, text: string) => boolean
  readonly onFollowUp: (id: string, date: string) => boolean
  readonly onContacted: (id: string) => boolean
  readonly onCopy: (value: string) => void
  readonly storageError: string
}

const formatDate = (value: string | number, includeTime = false) => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: 'long', day: 'numeric', ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}),
}).format(typeof value === 'number' ? new Date(value) : new Date(`${value}T12:00:00`))

export function ContactDrawer({
  contact, onClose, onEdit, onStar, onDelete, onAddNote, onFollowUp, onContacted, onCopy, storageError,
}: ContactDrawerProps) {
  const dialogRef = useDialog(true)
  const detail = useContactDetail({ contact, onAddNote, onFollowUp, onContacted })
  const tabs: ReadonlyArray<{ id: ContactDetailTab; label: string }> = [
    { id: 'profile', label: copy.tabs.profile }, { id: 'notes', label: copy.tabs.notes }, { id: 'activity', label: copy.tabs.activity },
  ]

  return (
    <dialog ref={dialogRef} className="modal contact-drawer" aria-labelledby="contact-drawer-title"
      onCancel={onClose} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="contact-drawer__panel">
        <header className="contact-drawer__header">
          <span className="eyebrow">{copy.contactDetails}</span>
          <button type="button" className="icon-button" aria-label={copy.close} onClick={onClose}><X aria-hidden="true" /></button>
        </header>

        <section className="contact-hero" aria-labelledby="contact-drawer-title">
          <Avatar contact={contact} size="xl" className="contact-hero__avatar" />
          <div className="contact-hero__identity">
            <div className="contact-hero__name-row">
              <h2 id="contact-drawer-title">{contact.name}</h2>
              {contact.english && <span lang="en">{contact.english}</span>}
            </div>
            <p>{[contact.role, contact.company].filter(Boolean).join(' · ') || copy.emptyValue}</p>
          </div>
          <div className="contact-hero__actions">
            <button type="button" className={`icon-button${contact.starred ? ' is-active' : ''}`}
              aria-label={contact.starred ? copy.unstar : copy.star} aria-pressed={contact.starred} onClick={() => onStar(contact.id)}>
              <Star aria-hidden="true" fill={contact.starred ? 'currentColor' : 'none'} />
            </button>
            <button type="button" className="icon-button" aria-label={copy.edit} onClick={() => onEdit(contact)}><Edit3 aria-hidden="true" /></button>
            <button type="button" className="icon-button danger" aria-label={copy.delete} onClick={() => onDelete([contact.id])}><Trash2 aria-hidden="true" /></button>
          </div>
        </section>

        <nav className="detail-tabs" role="tablist" aria-label={copy.contactDetails}>
          {tabs.map((item) => <button key={item.id} type="button" role="tab" id={`tab-${item.id}`}
            aria-controls={`panel-${item.id}`} aria-selected={detail.tab === item.id}
            className={detail.tab === item.id ? 'is-active' : ''} onClick={() => detail.setTab(item.id)}>{item.label}</button>)}
        </nav>

        <div className="contact-drawer__body">
          {storageError && <p className="inline-alert" role="alert">{storageError}</p>}

          {detail.tab === 'profile' && <section id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" className="detail-panel profile-panel">
            <div className="contact-methods">
              <ContactValue icon={<Phone aria-hidden="true" />} label={copy.phone} value={contact.phone} href={contact.phone ? `tel:${contact.phone}` : undefined} onCopy={onCopy} />
              <ContactValue icon={<Mail aria-hidden="true" />} label={copy.email} value={contact.email} href={contact.email ? `mailto:${contact.email}` : undefined} onCopy={onCopy} />
              <ContactValue icon={<MapPin aria-hidden="true" />} label={copy.location} value={contact.location} />
            </div>
            <section className="detail-section">
              <h3>{copy.tags}</h3>
              {contact.tags.length ? <div className="tag-list">{contact.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div> : <p className="muted">{copy.emptyValue}</p>}
            </section>
            <section className="detail-section follow-up-card">
              <div>
                <h3><CalendarCheck aria-hidden="true" />{copy.followUp}</h3>
                <p>{copy.followUpNotice}</p>
              </div>
              <div className="follow-up-card__controls">
                <label className="sr-only" htmlFor={`follow-up-${contact.id}`}>{copy.followUp}</label>
                <input id={`follow-up-${contact.id}`} type="date" value={detail.followUp} onChange={(event) => detail.setFollowUp(event.target.value)} />
                <button type="button" className="button button--secondary" onClick={detail.saveFollowUp}>{copy.followUpSave}</button>
              </div>
              <div className="follow-up-card__status">
                <Clock3 aria-hidden="true" /><span>{copy.lastContacted}：{contact.lastContacted ? formatDate(contact.lastContacted) : copy.neverContacted}</span>
                <button type="button" className="text-button" onClick={detail.markContacted}><Check aria-hidden="true" />{copy.markContacted}</button>
              </div>
            </section>
          </section>}

          {detail.tab === 'notes' && <section id="panel-notes" role="tabpanel" aria-labelledby="tab-notes" className="detail-panel notes-panel">
            <form className="note-composer" onSubmit={detail.submitNote}>
              <label htmlFor={`note-${contact.id}`}>{copy.notesTitle}</label>
              <textarea id={`note-${contact.id}`} maxLength={1000} value={detail.noteDraft} placeholder={copy.notePlaceholder}
                aria-invalid={Boolean(detail.noteError)} aria-describedby={detail.noteError ? `note-error-${contact.id}` : undefined}
                onChange={(event) => { detail.setNoteDraft(event.target.value); detail.setNoteError('') }} />
              <div className="note-composer__footer">
                <span className={detail.noteError ? 'field-error' : 'character-count'} id={detail.noteError ? `note-error-${contact.id}` : undefined}>
                  {detail.noteError === 'required' ? copy.noteRequired : detail.noteError === 'tooLong' ? copy.noteTooLong : `${detail.noteDraft.length}/1000`}
                </span>
                <button type="submit" className="button button--primary"><Plus aria-hidden="true" />{copy.addNote}</button>
              </div>
            </form>
            <div className="notes-list">
              {contact.notes.length ? [...contact.notes].sort((a, b) => b.createdAt - a.createdAt).map((note) => <article className="note-card" key={note.id}>
                <p>{note.text}</p><time dateTime={new Date(note.createdAt).toISOString()}>{formatDate(note.createdAt, true)}</time>
              </article>) : <p className="empty-state">{copy.noNotes}</p>}
            </div>
          </section>}

          {detail.tab === 'activity' && <section id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" className="detail-panel activity-panel">
            <h3>{copy.activityTitle}</h3>
            <ol className="activity-timeline">
              {detail.activity.map((item) => <li key={item.id} className={`activity-item activity-item--${item.kind}`}>
                <span className="activity-item__marker" aria-hidden="true" />
                <div><strong>{item.kind === 'created' ? copy.createdContact : item.kind === 'contacted' ? copy.contactedOn : copy.addedNote}</strong>
                  {item.text && <p>{item.text}</p>}<time dateTime={new Date(item.timestamp).toISOString()}>{formatDate(item.timestamp, item.kind === 'note')}</time></div>
              </li>)}
            </ol>
          </section>}
        </div>
      </div>
    </dialog>
  )
}

interface ContactValueProps {
  readonly icon: React.ReactNode
  readonly label: string
  readonly value: string
  readonly href?: string
  readonly onCopy?: (value: string) => void
}

function ContactValue({ icon, label, value, href, onCopy }: ContactValueProps) {
  return <div className="contact-value">
    <span className="contact-value__icon">{icon}</span>
    <div><span className="contact-value__label">{label}</span>{href ? <a href={href}>{value}</a> : <span>{value || copy.emptyValue}</span>}</div>
    {value && onCopy && <button type="button" className="icon-button" aria-label={`${copy.copyValue}${label}`} onClick={() => onCopy(value)}><Clipboard aria-hidden="true" /></button>}
  </div>
}
