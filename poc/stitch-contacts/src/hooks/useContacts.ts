import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { seedContacts, ui } from '../data/mockData'
import {
  CONTACTS_STORAGE_KEY,
  createContactId,
  filterContacts,
  parsePersistedContacts,
  removeContact,
  toggleContactFavorite,
  upsertContact,
  validateContactDraft,
  writePersistedContacts,
} from '../lib/contacts'
import type { Contact, ContactDraft, ContactFilter } from '../types'

export type ContactEditor =
  | { mode: 'new' }
  | { mode: 'edit'; contact: Contact }

type InitialContactsState = {
  contacts: Contact[]
  storageError: string
  storageLocked: boolean
  observedRaw: string | null
}

function readInitialContacts(): InitialContactsState {
  if (typeof window === 'undefined') {
    return { contacts: seedContacts, storageError: '', storageLocked: false, observedRaw: null }
  }
  try {
    const raw = window.localStorage.getItem(CONTACTS_STORAGE_KEY)
    if (raw === null) {
      return { contacts: seedContacts, storageError: '', storageLocked: false, observedRaw: null }
    }
    const parsed = parsePersistedContacts(raw)
    if (!parsed.ok) {
      return { contacts: seedContacts, storageError: parsed.error, storageLocked: true, observedRaw: raw }
    }
    return { contacts: parsed.contacts, storageError: '', storageLocked: false, observedRaw: raw }
  } catch {
    return {
      contacts: seedContacts,
      storageError: ui.storageReadFailed,
      storageLocked: true,
      observedRaw: null,
    }
  }
}

export function useContacts() {
  const initialRef = useRef<InitialContactsState | null>(null)
  if (!initialRef.current) initialRef.current = readInitialContacts()
  const initial = initialRef.current

  const [contacts, setContacts] = useState<Contact[]>(initial.contacts)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ContactFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(initial.contacts[0]?.id ?? null)
  const [editor, setEditor] = useState<ContactEditor | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null)
  const [notice, setNotice] = useState('')
  const [storageError, setStorageError] = useState(initial.storageError)
  const storageLockedRef = useRef(initial.storageLocked)
  const observedRawRef = useRef<string | null>(initial.observedRaw)
  const editorRef = useRef<ContactEditor | null>(null)

  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  useEffect(() => {
    if (selectedId && contacts.some((contact) => contact.id === selectedId)) return
    setSelectedId(contacts[0]?.id ?? null)
  }, [contacts, selectedId])

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== CONTACTS_STORAGE_KEY) return
      if (editorRef.current) {
        setNotice(ui.externalChangeDeferred)
        return
      }
      observedRawRef.current = event.newValue
      if (event.newValue === null) {
        storageLockedRef.current = false
        setStorageError('')
        setContacts(seedContacts)
        return
      }
      const parsed = parsePersistedContacts(event.newValue)
      if (!parsed.ok) {
        storageLockedRef.current = true
        setStorageError(parsed.error)
        return
      }
      storageLockedRef.current = false
      setStorageError('')
      setContacts(parsed.contacts)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const persist = useCallback((nextContacts: Contact[]): boolean => {
    try {
      const result = writePersistedContacts(
        window.localStorage,
        nextContacts,
        storageLockedRef.current,
        observedRawRef.current,
      )
      if (result.ok) {
        observedRawRef.current = result.raw
        setStorageError('')
        return true
      }
      if (result.reason === 'conflict') setNotice(result.error)
      else if (!storageLockedRef.current) setStorageError(result.error)
      return false
    } catch {
      setStorageError(ui.storageWriteFailed)
      return false
    }
  }, [])

  const filteredContacts = useMemo(
    () => filterContacts(contacts, query, filter),
    [contacts, filter, query],
  )
  const favorites = useMemo(() => contacts.filter((contact) => contact.favorite), [contacts])
  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedId) ?? null,
    [contacts, selectedId],
  )

  function selectContact(contactOrId: Contact | string) {
    setSelectedId(typeof contactOrId === 'string' ? contactOrId : contactOrId.id)
  }

  function openNew() {
    setEditor({ mode: 'new' })
  }

  function openEdit(contact: Contact) {
    setEditor({ mode: 'edit', contact })
  }

  function closeEditor() {
    setEditor(null)
  }

  function saveContact(draft: ContactDraft): boolean {
    if (Object.keys(validateContactDraft(draft)).length > 0) return false
    const id = editor?.mode === 'edit' ? editor.contact.id : createContactId()
    const nextContacts = upsertContact(contacts, draft, id)
    if (!persist(nextContacts)) return false
    setContacts(nextContacts)
    setSelectedId(id)
    setQuery('')
    setFilter('all')
    setEditor(null)
    setNotice(editor?.mode === 'edit' ? ui.updated : ui.saved)
    return true
  }

  function toggleFavorite(id: string) {
    if (!contacts.some((contact) => contact.id === id)) return
    const nextContacts = toggleContactFavorite(contacts, id)
    if (!persist(nextContacts)) return
    setContacts(nextContacts)
    setNotice(ui.favoriteUpdated)
  }

  function requestDelete(contact: Contact) {
    setDeleteTarget(contact)
  }

  function cancelDelete() {
    setDeleteTarget(null)
  }

  function confirmDelete(): boolean {
    if (!deleteTarget) return false
    const nextContacts = removeContact(contacts, deleteTarget.id)
    if (!persist(nextContacts)) return false
    if (selectedId === deleteTarget.id) setSelectedId(nextContacts[0]?.id ?? null)
    setContacts(nextContacts)
    setDeleteTarget(null)
    setNotice(ui.deleted)
    return true
  }

  function dismissNotice() {
    setNotice('')
  }

  function clearFilters() {
    setQuery('')
    setFilter('all')
  }

  return {
    contacts,
    filteredContacts,
    favorites,
    query,
    setQuery,
    filter,
    setFilter,
    selectedContact,
    selectedId,
    selectContact,
    editor,
    openNew,
    openEdit,
    closeEditor,
    saveContact,
    toggleFavorite,
    deleteTarget,
    requestDelete,
    cancelDelete,
    confirmDelete,
    notice,
    storageError,
    dismissNotice,
    clearFilters,
  }
}
