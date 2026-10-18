import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Contact } from '../types.ts'

export type ContactDetailTab = 'profile' | 'notes' | 'activity'

export interface ContactActivity {
  readonly id: string
  readonly kind: 'created' | 'contacted' | 'note'
  readonly timestamp: number
  readonly text?: string
}

interface UseContactDetailOptions {
  readonly contact: Contact
  readonly onAddNote: (id: string, text: string) => boolean
  readonly onFollowUp: (id: string, date: string) => boolean
  readonly onContacted: (id: string) => boolean
}

const dateToTimestamp = (date: string) => date ? new Date(`${date}T12:00:00`).getTime() : 0

export function useContactDetail({ contact, onAddNote, onFollowUp, onContacted }: UseContactDetailOptions) {
  const [tab, setTab] = useState<ContactDetailTab>('profile')
  const [noteDraft, setNoteDraft] = useState('')
  const [noteError, setNoteError] = useState<'required' | 'tooLong' | ''>('')
  const [followUp, setFollowUp] = useState(contact.followUp)

  useEffect(() => {
    setTab('profile')
    setNoteDraft('')
    setNoteError('')
  }, [contact.id])

  useEffect(() => { setFollowUp(contact.followUp) }, [contact.id, contact.followUp])

  const activity = useMemo<ContactActivity[]>(() => {
    const items: ContactActivity[] = [
      { id: `created-${contact.id}`, kind: 'created', timestamp: contact.createdAt },
      ...(contact.lastContacted ? [{ id: `contacted-${contact.id}-${contact.lastContacted}`, kind: 'contacted' as const, timestamp: dateToTimestamp(contact.lastContacted) }] : []),
      ...contact.notes.map((note) => ({ id: `note-${note.id}`, kind: 'note' as const, timestamp: note.createdAt, text: note.text })),
    ]
    return items.sort((a, b) => b.timestamp - a.timestamp)
  }, [contact])

  const submitNote = (event: FormEvent) => {
    event.preventDefault()
    const text = noteDraft.trim()
    if (!text) { setNoteError('required'); return false }
    if (text.length > 1000) { setNoteError('tooLong'); return false }
    if (!onAddNote(contact.id, text)) return false
    setNoteDraft('')
    setNoteError('')
    return true
  }

  const saveFollowUp = () => onFollowUp(contact.id, followUp)
  const markContacted = () => onContacted(contact.id)

  return {
    tab, setTab, noteDraft, setNoteDraft, noteError, setNoteError, followUp, setFollowUp,
    activity, submitNote, saveFollowUp, markContacted,
  }
}
