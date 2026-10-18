import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { Contact } from '../types.ts'

interface UseCommandPaletteOptions {
  readonly contacts: readonly Contact[]
  readonly onSelect: (contact: Contact) => void
}

export function useCommandPalette({ contacts, onSelect }: UseCommandPaletteOptions) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    if (!needle) return contacts.slice(0, 7)
    return contacts.filter((contact) => [contact.name, contact.company, contact.email]
      .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle))).slice(0, 7)
  }, [contacts, query])

  useEffect(() => { setActiveIndex(0) }, [query])
  useEffect(() => {
    setActiveIndex((current) => results.length ? Math.min(current, results.length - 1) : 0)
  }, [results.length])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => results.length ? (current + 1) % results.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => results.length ? (current - 1 + results.length) % results.length : 0)
    } else if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault()
      onSelect(results[activeIndex])
    }
  }

  return { query, setQuery, activeIndex, setActiveIndex, results, onKeyDown }
}
