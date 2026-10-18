import type { Contact, ContactDraft, ContactFormErrors, GroupId, Sort, View } from '../types.ts'
import { copy } from '../data/mockData.ts'

export const BOOK_STORAGE_KEY = 'stitch-contacts-pro.book.v1'
export const MAX_NOTES = 100

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface StoredBook { version: 1; contacts: Contact[] }
export type ReadBookResult =
  | { ok: true; raw: string | null; contacts: Contact[] }
  | { ok: false; raw: string | null; reason: 'read' | 'invalid' }

const groupIds: GroupId[] = ['work', 'friends', 'family', 'partners']
const colors: Contact['color'][] = ['sage', 'rose', 'gold', 'blue', 'violet', 'peach']
const isString = (value: unknown): value is string => typeof value === 'string'
const isDate = (value: unknown) => {
  if (value === '') return true
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return isString(item.id) && item.id.length > 0 && isString(item.name) && item.name.length <= 60 &&
    isString(item.english) && item.english.length <= 80 && isString(item.company) && item.company.length <= 100 &&
    isString(item.role) && item.role.length <= 80 && isString(item.email) && item.email.length <= 160 &&
    isString(item.phone) && item.phone.length <= 40 && groupIds.includes(item.groupId as GroupId) &&
    Array.isArray(item.tags) && item.tags.length <= 10 && item.tags.every((tag) => isString(tag) && tag.length <= 32) &&
    typeof item.starred === 'boolean' && colors.includes(item.color as Contact['color']) && isString(item.avatar) && item.avatar.length <= 500 &&
    isString(item.location) && item.location.length <= 100 && Array.isArray(item.notes) && item.notes.length <= MAX_NOTES &&
    item.notes.every((note) => note && typeof note === 'object' && isString((note as Contact['notes'][number]).id) &&
      isString((note as Contact['notes'][number]).text) && (note as Contact['notes'][number]).text.length <= 1000 &&
      Number.isFinite((note as Contact['notes'][number]).createdAt)) && isDate(item.followUp) && isDate(item.lastContacted) &&
    Number.isFinite(item.createdAt) && (item.createdAt as number) >= 0
}

export function parseBook(raw: string): StoredBook | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const book = parsed as Partial<StoredBook>
    if (book.version !== 1 || !Array.isArray(book.contacts) || !book.contacts.every(isContact)) return null
    if (new Set(book.contacts.map((contact) => contact.id)).size !== book.contacts.length) return null
    return { version: 1, contacts: book.contacts }
  } catch {
    return null
  }
}

export function readBook(storage: StorageLike, fallback: Contact[]): ReadBookResult {
  let raw: string | null
  try { raw = storage.getItem(BOOK_STORAGE_KEY) } catch { return { ok: false, raw: null, reason: 'read' } }
  if (raw === null) return { ok: true, raw, contacts: structuredClone(fallback) }
  const book = parseBook(raw)
  return book ? { ok: true, raw, contacts: book.contacts } : { ok: false, raw, reason: 'invalid' }
}

export type CommitResult = { ok: true; raw: string } | { ok: false; reason: 'read' | 'write' | 'conflict' }

export function commitBook(storage: StorageLike, expectedRaw: string | null, contacts: Contact[]): CommitResult {
  let actual: string | null
  try { actual = storage.getItem(BOOK_STORAGE_KEY) } catch { return { ok: false, reason: 'read' } }
  if (actual !== expectedRaw) return { ok: false, reason: 'conflict' }
  const raw = JSON.stringify({ version: 1, contacts } satisfies StoredBook)
  try { storage.setItem(BOOK_STORAGE_KEY, raw) } catch { return { ok: false, reason: 'write' } }
  return { ok: true, raw }
}

export const todayIso = (now = new Date()) => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

export const isDue = (contact: Contact, today = todayIso()) => contact.followUp !== '' && contact.followUp <= today

export function filterAndSortContacts(
  contacts: Contact[], options: { view: View; groupFilter: GroupId | 'all'; query: string; sort: Sort; today?: string },
): Contact[] {
  const needle = options.query.trim().toLocaleLowerCase('zh-CN')
  const result = contacts.filter((contact) => {
    if (options.view === 'starred' && !contact.starred) return false
    if (options.view === 'due' && !isDue(contact, options.today)) return false
    if (options.groupFilter !== 'all' && contact.groupId !== options.groupFilter) return false
    if (!needle) return true
    return [contact.name, contact.english, contact.company, contact.role, contact.email, contact.phone, contact.location, ...contact.tags]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle))
  })
  return result.sort((a, b) => {
    if (options.sort === 'name') return a.name.localeCompare(b.name, 'zh-CN')
    if (options.sort === 'followup') return (a.followUp || '9999-12-31').localeCompare(b.followUp || '9999-12-31') || b.createdAt - a.createdAt
    return b.createdAt - a.createdAt
  })
}

export const getCounts = (contacts: Contact[], today = todayIso()) => ({
  all: contacts.length, starred: contacts.filter((contact) => contact.starred).length, due: contacts.filter((contact) => isDue(contact, today)).length,
})

export function validateDraft(draft: ContactDraft): ContactFormErrors {
  const errors: ContactFormErrors = {}
  const name = draft.name.trim()
  if (!name) errors.name = copy.formNameRequired
  else if (name.length > 60) errors.name = copy.formNameTooLong
  if (draft.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email) || draft.email.length > 160)) errors.email = copy.formEmailInvalid
  if (draft.phone && (!/^[0-9+()\-\s.]{5,40}$/.test(draft.phone))) errors.phone = copy.formPhoneInvalid
  if (draft.english.length > 80 || draft.company.length > 100 || draft.role.length > 80 || draft.location.length > 100 || draft.avatar.length > 500) errors.form = copy.formFieldTooLong
  if (draft.tags.length > 10 || draft.tags.some((tag) => tag.length > 32)) errors.tags = copy.formTagsTooLong
  if (!groupIds.includes(draft.groupId) || !colors.includes(draft.color) || !isDate(draft.followUp)) errors.form = copy.formFieldTooLong
  return errors
}

export function createContact(draft: ContactDraft, id: string, createdAt = Date.now()): Contact {
  return { ...draft, name: draft.name.trim(), id, notes: [], lastContacted: '', createdAt, tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) }
}

export function upsertContact(contacts: Contact[], contact: Contact): Contact[] {
  const index = contacts.findIndex((item) => item.id === contact.id)
  return index < 0 ? [contact, ...contacts] : contacts.map((item) => item.id === contact.id ? contact : item)
}

export function deleteContacts(contacts: Contact[], ids: Iterable<string>) {
  const wanted = new Set(ids)
  const deleted = contacts.filter((contact) => wanted.has(contact.id))
  return { deleted, contacts: contacts.filter((contact) => !wanted.has(contact.id)) }
}

export function restoreContacts(contacts: Contact[], deleted: Contact[]): Contact[] {
  const existing = new Set(contacts.map((contact) => contact.id))
  return [...deleted.filter((contact) => !existing.has(contact.id)), ...contacts]
}

export function updateContact(contacts: Contact[], id: string, update: (contact: Contact) => Contact): Contact[] | null {
  if (!contacts.some((contact) => contact.id === id)) return null
  return contacts.map((contact) => contact.id === id ? update(contact) : contact)
}
