import { groups, ui } from '../data/mockData.ts'
import type {
  Contact,
  ContactDraft,
  ContactFilter,
  ContactFormErrors,
  ContactTone,
} from '../types.ts'

export const CONTACTS_STORAGE_KEY = 'zhijiao.contacts.v1'

const tones: readonly ContactTone[] = ['blue', 'teal', 'violet', 'amber']

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.name === 'string' &&
    typeof candidate.company === 'string' &&
    typeof candidate.role === 'string' &&
    typeof candidate.phone === 'string' &&
    typeof candidate.email === 'string' &&
    typeof candidate.notes === 'string' &&
    typeof candidate.favorite === 'boolean' &&
    groups.includes(candidate.group as Contact['group']) &&
    tones.includes(candidate.tone as ContactTone)
  )
}

export type PersistedContactsResult =
  | { ok: true; contacts: Contact[] }
  | { ok: false; error: string }

export function parsePersistedContacts(raw: string): PersistedContactsResult {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every(isContact)) {
      return { ok: false, error: ui.storageCorrupt }
    }
    const ids = new Set(parsed.map((contact) => contact.id))
    if (ids.size !== parsed.length) {
      return { ok: false, error: ui.storageCorrupt }
    }
    return { ok: true, contacts: parsed }
  } catch {
    return { ok: false, error: ui.storageCorrupt }
  }
}

export function serializeContacts(contacts: readonly Contact[]): string {
  return JSON.stringify(contacts)
}

type ContactsStorage = Pick<Storage, 'getItem' | 'setItem'>

export type PersistContactsResult =
  | { ok: true; raw: string }
  | { ok: false; error: string; reason: 'readonly' | 'conflict' | 'unavailable' }

export function writePersistedContacts(
  storage: ContactsStorage,
  contacts: readonly Contact[],
  readOnly: boolean,
  observedRaw: string | null,
): PersistContactsResult {
  if (readOnly) return { ok: false, error: ui.storageCorrupt, reason: 'readonly' }
  try {
    if (storage.getItem(CONTACTS_STORAGE_KEY) !== observedRaw) {
      return { ok: false, error: ui.externalChangeDeferred, reason: 'conflict' }
    }
    const raw = serializeContacts(contacts)
    storage.setItem(CONTACTS_STORAGE_KEY, raw)
    return { ok: true, raw }
  } catch {
    return { ok: false, error: ui.storageWriteFailed, reason: 'unavailable' }
  }
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN')
}

export function filterContacts(
  contacts: readonly Contact[],
  query: string,
  filter: ContactFilter,
): Contact[] {
  const needle = normalizeSearchValue(query)
  return contacts
    .filter((contact) => {
      if (filter === 'favorites' && !contact.favorite) return false
      if (filter !== 'all' && filter !== 'favorites' && contact.group !== filter) return false
      if (!needle) return true
      return [contact.name, contact.company, contact.role, contact.phone, contact.email, contact.notes]
        .some((value) => normalizeSearchValue(value).includes(needle))
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function validateContactDraft(draft: ContactDraft): ContactFormErrors {
  const errors: ContactFormErrors = {}
  const name = draft.name.trim()
  const company = draft.company.trim()
  const role = draft.role.trim()
  const phone = draft.phone.trim()
  const email = draft.email.trim()
  const notes = draft.notes.trim()

  if (!name) errors.name = ui.nameRequiredError
  else if (name.length > 100) errors.name = ui.nameTooLongError
  if (company.length > 100) errors.company = ui.companyTooLongError
  if (role.length > 100) errors.role = ui.roleTooLongError
  if (phone.length > 40) {
    errors.phone = ui.phoneTooLongError
  } else if (phone && !/^[+\d][\d\s().-]{6,}$/.test(phone)) {
    errors.phone = ui.phoneInvalidError
  }
  if (email.length > 254) {
    errors.email = ui.emailTooLongError
  } else if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = ui.emailInvalidError
  }
  if (notes.length > 500) errors.notes = ui.notesTooLongError
  if (!groups.includes(draft.group)) errors.group = ui.groupInvalidError
  if (!tones.includes(draft.tone)) errors.tone = ui.toneInvalidError
  return errors
}

export function createContactId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `contact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function upsertContact(
  contacts: readonly Contact[],
  draft: ContactDraft,
  id = createContactId(),
): Contact[] {
  const contact: Contact = {
    ...draft,
    id,
    name: draft.name.trim(),
    company: draft.company.trim(),
    role: draft.role.trim(),
    phone: draft.phone.trim(),
    email: draft.email.trim(),
    notes: draft.notes.trim(),
  }
  const existingIndex = contacts.findIndex((item) => item.id === id)
  if (existingIndex === -1) return [...contacts, contact]
  return contacts.map((item, index) => (index === existingIndex ? contact : item))
}

export function removeContact(contacts: readonly Contact[], id: string): Contact[] {
  return contacts.filter((contact) => contact.id !== id)
}

export function toggleContactFavorite(contacts: readonly Contact[], id: string): Contact[] {
  return contacts.map((contact) =>
    contact.id === id ? { ...contact, favorite: !contact.favorite } : contact,
  )
}
