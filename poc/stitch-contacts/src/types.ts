export type ContactGroup = '工作' | '朋友' | '家人' | '其他'

export type ContactTone = 'blue' | 'teal' | 'violet' | 'amber'

export interface Contact {
  id: string
  name: string
  company: string
  role: string
  phone: string
  email: string
  group: ContactGroup
  notes: string
  favorite: boolean
  tone: ContactTone
}

export type ContactDraft = Omit<Contact, 'id'>

export type ContactFilter = 'all' | 'favorites' | ContactGroup

export type ContactFormErrors = Partial<Record<keyof ContactDraft, string>>
