import { useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { emptyDraft } from '../data/mockData'
import { validateContactDraft } from '../lib/contacts'
import type { Contact, ContactDraft, ContactFormErrors } from '../types'

type ContactFormElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

export function useContactForm(
  initial: ContactDraft | Contact | undefined,
  onSave: (draft: ContactDraft) => boolean | void,
) {
  const [draft, setDraft] = useState<ContactDraft>(() => toDraft(initial))
  const [errors, setErrors] = useState<ContactFormErrors>({})

  useEffect(() => {
    setDraft(toDraft(initial))
    setErrors({})
  }, [initial])

  function onChange(event: ChangeEvent<ContactFormElement>) {
    const field = event.target.name as keyof ContactDraft
    if (!field) return
    const value = event.target instanceof HTMLInputElement && event.target.type === 'checkbox'
      ? event.target.checked
      : event.target.value
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors((current) => {
      if (!(field in current)) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validateContactDraft(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSave(draft)
  }

  function toggleFavorite() {
    setDraft((current) => ({ ...current, favorite: !current.favorite }))
  }

  return { draft, errors, onChange, onSubmit, toggleFavorite }
}

function toDraft(initial: ContactDraft | Contact | undefined): ContactDraft {
  if (!initial) return { ...emptyDraft }
  const { name, company, role, phone, email, group, notes, favorite, tone } = initial
  return { name, company, role, phone, email, group, notes, favorite, tone }
}
