import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { copy, seedContacts } from '../data/mockData.ts'
import {
  BOOK_STORAGE_KEY, commitBook, createContact, deleteContacts, filterAndSortContacts, getCounts, parseBook, readBook,
  restoreContacts, todayIso, updateContact, upsertContact, validateDraft, type StorageLike,
} from '../lib/book.ts'
import type { Contact, ContactDraft, GroupId, Sort, View } from '../types.ts'

type Editor = { mode: 'new' } | { mode: 'edit'; contact: Contact }
type Layout = 'grid' | 'list'

const newId = () => globalThis.crypto?.randomUUID?.() ?? `contact-${Date.now()}-${Math.random().toString(36).slice(2)}`
const browserStorage = (): StorageLike | null => {
  if (typeof window === 'undefined') return null
  try { return window.localStorage } catch { return null }
}

export function useBook() {
  const initial = useMemo(() => {
    const storage = browserStorage()
    if (!storage) return { contacts: structuredClone(seedContacts), raw: null as string | null, writable: false, error: copy.storageReadError }
    const result = readBook(storage, seedContacts)
    if (!result.ok) return { contacts: structuredClone(seedContacts), raw: result.raw, writable: false, error: result.reason === 'invalid' ? copy.storageInvalid : copy.storageReadError }
    return { contacts: result.contacts, raw: result.raw, writable: true, error: '' }
  }, [])

  const [contacts, setContacts] = useState<Contact[]>(initial.contacts)
  const contactsRef = useRef(contacts)
  const rawRef = useRef<string | null>(initial.raw)
  const writableRef = useRef(initial.writable)
  contactsRef.current = contacts
  const [storageError, setStorageError] = useState(initial.error)
  const [view, setView] = useState<View>('all')
  const [groupFilter, setGroupFilter] = useState<GroupId | 'all'>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [layout, setLayout] = useState<Layout>('grid')
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const undoRef = useRef<Contact[] | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [notice, setNotice] = useState('')

  const errorFor = (reason: 'read' | 'write' | 'conflict') => reason === 'conflict' ? copy.storageConflict : reason === 'read' ? copy.storageReadError : copy.storageWriteError

  const commit = useCallback((next: Contact[], successNotice: string) => {
    const storage = browserStorage()
    if (!storage || !writableRef.current) { setStorageError((value) => value || copy.storageWriteError); return false }
    const result = commitBook(storage, rawRef.current, next)
    if (!result.ok) { setStorageError(errorFor(result.reason)); return false }
    rawRef.current = result.raw
    contactsRef.current = next
    setContacts(next)
    setStorageError('')
    setNotice(successNotice)
    return true
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== BOOK_STORAGE_KEY || event.storageArea !== window.localStorage) return
      if (event.newValue === null) {
        rawRef.current = null
        writableRef.current = true
        contactsRef.current = structuredClone(seedContacts)
        setContacts(contactsRef.current)
        setStorageError('')
        return
      }
      const parsed = parseBook(event.newValue)
      if (!parsed) { writableRef.current = false; setStorageError(copy.storageInvalid); return }
      rawRef.current = event.newValue
      writableRef.current = true
      contactsRef.current = parsed.contacts
      setContacts(parsed.contacts)
      setStorageError('')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const filtered = useMemo(() => filterAndSortContacts(contacts, { view, groupFilter, query, sort }), [contacts, view, groupFilter, query, sort])
  const counts = useMemo(() => getCounts(contacts), [contacts])
  const selectedIds = useMemo(() => selection.filter((id) => contacts.some((contact) => contact.id === id)), [selection, contacts])
  const focused = useMemo(() => contacts.find((contact) => contact.id === focusedId) ?? null, [contacts, focusedId])

  useEffect(() => { if (focusedId && !focused) setFocusedId(null) }, [focused, focusedId])

  const resetFilters = useCallback(() => { setView('all'); setGroupFilter('all'); setQuery('') }, [])
  const toggleSelecting = useCallback(() => setSelecting((value) => { if (value) setSelection([]); return !value }), [])
  const toggleSelection = useCallback((id: string) => {
    if (!contactsRef.current.some((contact) => contact.id === id)) return
    setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }, [])
  const selectVisible = useCallback(() => setSelection(filtered.map((contact) => contact.id)), [filtered])
  const clearSelection = useCallback(() => setSelection([]), [])
  const openContact = useCallback((id: string) => { if (contactsRef.current.some((contact) => contact.id === id)) setFocusedId(id) }, [])
  const closeDetail = useCallback(() => setFocusedId(null), [])
  const openNew = useCallback(() => setEditor({ mode: 'new' }), [])
  const openEdit = useCallback((contact: Contact) => setEditor({ mode: 'edit', contact }), [])
  const closeEditor = useCallback(() => setEditor(null), [])

  const saveContact = useCallback((draft: ContactDraft) => {
    if (Object.keys(validateDraft(draft)).length) return false
    const current = contactsRef.current
    if (editor?.mode === 'edit') {
      const existing = current.find((contact) => contact.id === editor.contact.id)
      if (!existing) return false
      const next = upsertContact(current, { ...existing, ...draft, name: draft.name.trim(), tags: draft.tags.map((tag) => tag.trim()).filter(Boolean) })
      if (!commit(next, copy.updated)) return false
    } else {
      if (!commit(upsertContact(current, createContact(draft, newId())), copy.created)) return false
    }
    setEditor(null)
    resetFilters()
    return true
  }, [commit, editor, resetFilters])

  const toggleStar = useCallback((id: string) => {
    const next = updateContact(contactsRef.current, id, (contact) => ({ ...contact, starred: !contact.starred }))
    return next ? commit(next, copy.saved) : false
  }, [commit])

  const starSelected = useCallback(() => {
    const ids = new Set(selection.filter((id) => contactsRef.current.some((contact) => contact.id === id)))
    if (!ids.size) return false
    return commit(contactsRef.current.map((contact) => ids.has(contact.id) ? { ...contact, starred: true } : contact), copy.saved)
  }, [commit, selection])

  const requestDelete = useCallback((ids: string[]) => {
    const existing = new Set(contactsRef.current.map((contact) => contact.id))
    const real = [...new Set(ids)].filter((id) => existing.has(id))
    if (real.length) setDeleteIds(real)
  }, [])
  const cancelDelete = useCallback(() => setDeleteIds(null), [])
  const confirmDelete = useCallback(() => {
    if (!deleteIds) return false
    const result = deleteContacts(contactsRef.current, deleteIds)
    if (!result.deleted.length) { setDeleteIds(null); return false }
    if (!commit(result.contacts, copy.deleted)) return false
    undoRef.current = result.deleted
    setCanUndo(true)
    const deletedSet = new Set(result.deleted.map((contact) => contact.id))
    setSelection((ids) => ids.filter((id) => !deletedSet.has(id)))
    if (focusedId && deletedSet.has(focusedId)) setFocusedId(null)
    setDeleteIds(null)
    return true
  }, [commit, deleteIds, focusedId])

  const undoDelete = useCallback(() => {
    const deleted = undoRef.current
    if (!deleted?.length) return false
    const missing = deleted.filter((contact) => !contactsRef.current.some((item) => item.id === contact.id))
    if (!missing.length) { undoRef.current = null; setCanUndo(false); return false }
    if (!commit(restoreContacts(contactsRef.current, missing), copy.restored)) return false
    undoRef.current = null
    setCanUndo(false)
    return true
  }, [commit])

  const addNote = useCallback((id: string, text: string) => {
    const clean = text.trim()
    if (!clean || clean.length > 1000) return false
    const next = updateContact(contactsRef.current, id, (contact) => ({
      ...contact, notes: [...contact.notes, { id: newId(), text: clean, createdAt: Date.now() }].slice(-100),
    }))
    return next ? commit(next, copy.noteAdded) : false
  }, [commit])

  const setFollowUp = useCallback((id: string, date: string) => {
    if (date) {
      const parsed = new Date(`${date}T00:00:00Z`)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return false
    }
    const next = updateContact(contactsRef.current, id, (contact) => ({ ...contact, followUp: date }))
    return next ? commit(next, copy.followUpSaved) : false
  }, [commit])

  const markContacted = useCallback((id: string) => {
    const next = updateContact(contactsRef.current, id, (contact) => ({ ...contact, lastContacted: todayIso() }))
    return next ? commit(next, copy.contacted) : false
  }, [commit])

  const exportContacts = useCallback(() => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), contacts: contactsRef.current }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `知交通讯录-${todayIso()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice(copy.exported)
  }, [])

  return {
    contacts, filtered, counts, view, setView, groupFilter, setGroupFilter, query, setQuery, sort, setSort, layout, setLayout,
    selecting, toggleSelecting, selectedIds, toggleSelection, selectVisible, clearSelection, focused, openContact, closeDetail,
    editor, openNew, openEdit, closeEditor, saveContact, toggleStar, starSelected, deleteIds, requestDelete, cancelDelete,
    confirmDelete, undoDelete, canUndo, notice, dismissNotice: () => setNotice(''), storageError, addNote, setFollowUp,
    markContacted, resetFilters, exportContacts,
  }
}
