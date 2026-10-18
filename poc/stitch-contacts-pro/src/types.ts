export type GroupId = 'work' | 'friends' | 'family' | 'partners'
export type View = 'all' | 'starred' | 'due'
export type Sort = 'recent' | 'name' | 'followup'
export type ContactColor = 'sage' | 'rose' | 'gold' | 'blue' | 'violet' | 'peach'

export interface Note {
  id: string
  text: string
  createdAt: number
}

export interface Contact {
  id: string
  name: string
  english: string
  company: string
  role: string
  email: string
  phone: string
  groupId: GroupId
  tags: string[]
  starred: boolean
  color: ContactColor
  avatar: string
  location: string
  notes: Note[]
  followUp: string
  lastContacted: string
  createdAt: number
}

export type ContactDraft = Omit<Contact, 'id' | 'notes' | 'createdAt' | 'lastContacted'>

export type ContactFormErrors = Partial<Record<keyof ContactDraft | 'form', string>>
