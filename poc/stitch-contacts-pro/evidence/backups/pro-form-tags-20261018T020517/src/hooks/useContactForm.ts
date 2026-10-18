import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { copy } from '../data/mockData.ts'
import { validateDraft } from '../lib/book.ts'
import type { ContactDraft, ContactFormErrors } from '../types.ts'

export function useContactForm(initial: ContactDraft, onSave: (draft: ContactDraft) => boolean) {
  const [draft, setDraft] = useState<ContactDraft>(() => structuredClone(initial))
  const [errors, setErrors] = useState<ContactFormErrors>({})
  const initialSignature = JSON.stringify(initial)

  useEffect(() => { setDraft(structuredClone(initial)); setErrors({}) }, [initialSignature])

  const onChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = event.target
    const checked = event.target instanceof HTMLInputElement && event.target.type === 'checkbox' ? event.target.checked : undefined
    setDraft((current) => ({ ...current, [name]: checked ?? value }))
    setErrors((current) => ({ ...current, [name]: undefined, form: undefined }))
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const nextErrors = validateDraft(draft)
    if (Object.keys(nextErrors).length) { setErrors(nextErrors); return false }
    if (!onSave(draft)) { setErrors({ form: copy.formSaveFailed }); return false }
    setErrors({})
    return true
  }

  const toggleStar = () => setDraft((current) => ({ ...current, starred: !current.starred }))
  const setTags = (value: string) => {
    const tags = value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean)
    setDraft((current) => ({ ...current, tags }))
    setErrors((current) => ({ ...current, tags: undefined }))
  }

  return { draft, errors, onChange, onSubmit, toggleStar, setTags }
}
