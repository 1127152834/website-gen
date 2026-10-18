import { Save, Star, X } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Avatar } from './Avatar.tsx'
import { copy, type FormErrorKey } from '../data/dialogCopy.ts'
import { groups } from '../data/mockData.ts'
import { useContactForm } from '../hooks/useContactForm.ts'
import { useDialog } from '../hooks/useDialog.ts'
import type { Contact, ContactColor, ContactDraft } from '../types.ts'

export interface ContactEditorProps {
  readonly contact?: Contact
  readonly onSave: (draft: ContactDraft) => boolean
  readonly onClose: () => void
  readonly storageError: string
}

const colors: readonly ContactColor[] = ['sage', 'rose', 'gold', 'blue', 'violet', 'peach']
const toDraft = (contact?: Contact): ContactDraft => contact ? {
  name: contact.name, english: contact.english, company: contact.company, role: contact.role, email: contact.email,
  phone: contact.phone, groupId: contact.groupId, tags: [...contact.tags], starred: contact.starred, color: contact.color,
  avatar: contact.avatar, location: contact.location, followUp: contact.followUp,
} : { name: '', english: '', company: '', role: '', email: '', phone: '', groupId: 'work', tags: [], starred: false, color: 'sage', avatar: '', location: '', followUp: '' }

const errorMessage = (value?: string) => value ? copy.formErrors[value as FormErrorKey] ?? value : ''

export function ContactEditor({ contact, onSave, onClose, storageError }: ContactEditorProps) {
  const dialogRef = useDialog(true)
  const formRef = useRef<HTMLFormElement>(null)
  const initial = useMemo(() => toDraft(contact), [contact])
  const form = useContactForm(initial, onSave)
  const title = contact ? copy.editContact : copy.newContact

  const submit = (event: React.FormEvent) => {
    const saved = form.onSubmit(event)
    if (saved) { onClose(); return }
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  }

  return <dialog ref={dialogRef} className="modal editor-modal" aria-labelledby="editor-title" onCancel={onClose}>
    <form ref={formRef} className="editor-form" onSubmit={submit} noValidate>
      <header className="editor-modal__header">
        <div><span className="eyebrow">{contact ? copy.edit : copy.newContact}</span><h2 id="editor-title">{title}</h2><p>{copy.editorSubtitle}</p></div>
        <button type="button" className="icon-button" aria-label={copy.close} onClick={onClose}><X aria-hidden="true" /></button>
      </header>

      <div className="editor-modal__body">
        {(storageError || form.errors.form) && <p className="inline-alert" role="alert">{storageError || errorMessage(form.errors.form)}</p>}
        <div className="editor-profile-preview"><Avatar contact={form.draft} size="lg" /><div><strong>{form.draft.name || copy.newContact}</strong><span>{[form.draft.role, form.draft.company].filter(Boolean).join(' · ') || copy.editorSubtitle}</span></div></div>

        <fieldset className="editor-section"><legend>{copy.basicInfo}</legend>
          <div className="form-grid">
            <Field label={copy.name} name="name" required maxLength={60} value={form.draft.name} placeholder={copy.namePlaceholder} error={errorMessage(form.errors.name)} onChange={form.onChange} />
            <Field label={copy.english} name="english" maxLength={80} value={form.draft.english} placeholder={copy.englishPlaceholder} error={errorMessage(form.errors.english)} onChange={form.onChange} />
            <Field label={copy.company} name="company" maxLength={100} value={form.draft.company} placeholder={copy.companyPlaceholder} error={errorMessage(form.errors.company)} onChange={form.onChange} />
            <Field label={copy.role} name="role" maxLength={80} value={form.draft.role} placeholder={copy.rolePlaceholder} error={errorMessage(form.errors.role)} onChange={form.onChange} />
            <Field label={copy.phone} name="phone" type="tel" maxLength={40} value={form.draft.phone} placeholder={copy.phonePlaceholder} error={errorMessage(form.errors.phone)} onChange={form.onChange} />
            <Field label={copy.email} name="email" type="email" maxLength={160} value={form.draft.email} placeholder={copy.emailPlaceholder} error={errorMessage(form.errors.email)} onChange={form.onChange} />
            <Field label={copy.location} name="location" maxLength={100} value={form.draft.location} placeholder={copy.locationPlaceholder} error={errorMessage(form.errors.location)} onChange={form.onChange} />
          </div>
        </fieldset>

        <fieldset className="editor-section"><legend>{copy.relationshipInfo}</legend>
          <div className="form-grid">
            <label className="field"><span>{copy.group}</span><select name="groupId" value={form.draft.groupId} onChange={form.onChange}>{groups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label>
            <label className="field"><span>{copy.followUp}</span><input name="followUp" type="date" value={form.draft.followUp} onChange={form.onChange} /></label>
            <label className="field field--wide"><span>{copy.tagInput}</span><input name="tags" value={form.tagsInput} aria-invalid={Boolean(form.errors.tags)} aria-describedby={form.errors.tags ? 'editor-tags-error' : 'editor-tags-hint'} onChange={(event) => form.setTagsInput(event.target.value)} />
              <small id={form.errors.tags ? 'editor-tags-error' : 'editor-tags-hint'} className={form.errors.tags ? 'field-error' : ''}>{errorMessage(form.errors.tags) || copy.tagHint}</small></label>
          </div>
          <div className="color-picker" role="radiogroup" aria-label={copy.color}>{colors.map((color) => <label key={color} className={`color-choice color-choice--${color}`}><input type="radio" name="color" value={color} checked={form.draft.color === color} onChange={form.onChange} /><span aria-hidden="true" /><span className="sr-only">{copy.colors[color]}</span></label>)}</div>
          <button type="button" className={`star-toggle${form.draft.starred ? ' is-active' : ''}`} aria-pressed={form.draft.starred} onClick={form.toggleStar}>
            <Star aria-hidden="true" fill={form.draft.starred ? 'currentColor' : 'none'} /><span><strong>{copy.starred}</strong><small>{copy.starredHint}</small></span>
          </button>
        </fieldset>
      </div>

      <footer className="editor-modal__footer"><span>{copy.savingHint}</span><div><button type="button" className="button button--ghost" onClick={onClose}>{copy.cancel}</button><button type="submit" className="button button--primary"><Save aria-hidden="true" />{copy.save}</button></div></footer>
    </form>
  </dialog>
}

interface FieldProps {
  readonly label: string
  readonly name: string
  readonly value: string
  readonly type?: string
  readonly placeholder?: string
  readonly required?: boolean
  readonly maxLength?: number
  readonly error?: string
  readonly onChange: React.ChangeEventHandler<HTMLInputElement>
}

function Field({ label, name, value, type = 'text', placeholder, required, maxLength, error, onChange }: FieldProps) {
  const errorId = `editor-${name}-error`
  return <label className="field"><span>{label}{required && <b aria-hidden="true"> *</b>}</span><input name={name} type={type} value={value} placeholder={placeholder} required={required} maxLength={maxLength}
    aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} onChange={onChange} />{error && <small id={errorId} className="field-error">{error}</small>}</label>
}
