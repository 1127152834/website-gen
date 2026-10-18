import assert from 'node:assert/strict'
import test from 'node:test'
import { dateAt, emptyDraft, seedContacts } from '../data/mockData.ts'
import {
  BOOK_STORAGE_KEY, commitBook, createContact, deleteContacts, filterAndSortContacts, getCounts, parseBook, readBook,
  restoreContacts, updateContact, upsertContact, validateDraft, type StorageLike,
} from './book.ts'

class MemoryStorage implements StorageLike {
  value: string | null = null
  failGet = false
  failSet = false
  getItem() { if (this.failGet) throw new Error('get'); return this.value }
  setItem(_key: string, value: string) { if (this.failSet) throw new Error('set'); this.value = value }
}

test('calendar offsets preserve local day and DST boundaries', () => {
  assert.equal(dateAt(0, new Date(2026, 9, 18, 0, 10)), '2026-10-18')
  assert.equal(dateAt(1, new Date(2026, 2, 8, 0, 10)), '2026-03-09')
  assert.equal(dateAt(-1, new Date(2026, 10, 2, 0, 10)), '2026-11-01')
  assert.equal(dateAt(1, new Date(2026, 11, 31, 23, 59)), '2027-01-01')
})

test('seed is isolated demo data with required distribution', () => {
  assert.equal(seedContacts.length, 12)
  assert.equal(seedContacts[0].name, '林沐')
  assert.equal(seedContacts.filter((item) => item.starred).length, 4)
  assert.equal(seedContacts.filter((item) => item.followUp).length, 3)
  assert.equal(getCounts(seedContacts).due, 3)
  assert.ok(seedContacts.every((item) => item.createdAt <= Date.now()))
  assert.ok(seedContacts.every((item) => item.email.endsWith('@example.com') && /^202-555-01\d{2}$/.test(item.phone)))
})

test('filter intersection searches only matching view and group', () => {
  const result = filterAndSortContacts(seedContacts, { view: 'starred', groupFilter: 'partners', query: '产品', sort: 'name' })
  assert.deepEqual(result.map((item) => item.name), ['陈放'])
})

test('due uses today boundary and counts match', () => {
  const contacts = seedContacts.map((item, index) => ({ ...item, followUp: index === 0 ? '2026-10-17' : index === 1 ? '2026-10-18' : index === 2 ? '2026-10-19' : '' }))
  assert.deepEqual(filterAndSortContacts(contacts, { view: 'due', groupFilter: 'all', query: '', sort: 'name', today: '2026-10-18' }).map((item) => item.id), ['demo02', 'demo01'])
  assert.equal(getCounts(contacts, '2026-10-18').due, 2)
})

test('sorting supports recent, name and followup with empty dates last', () => {
  const two = [
    { ...seedContacts[0], id: 'a', name: '周', createdAt: 1, followUp: '' },
    { ...seedContacts[1], id: 'b', name: '安', createdAt: 2, followUp: '2026-10-20' },
  ]
  assert.deepEqual(filterAndSortContacts(two, { view: 'all', groupFilter: 'all', query: '', sort: 'recent' }).map((x) => x.id), ['b', 'a'])
  assert.deepEqual(filterAndSortContacts(two, { view: 'all', groupFilter: 'all', query: '', sort: 'name' }).map((x) => x.id), ['b', 'a'])
  assert.deepEqual(filterAndSortContacts(two, { view: 'all', groupFilter: 'all', query: '', sort: 'followup' }).map((x) => x.id), ['b', 'a'])
})

test('CRUD and bulk helpers preserve immutable records', () => {
  const created = createContact({ ...emptyDraft, name: ' 新联系人 ', tags: [' 新 ', ''] }, 'new', 5)
  let contacts = upsertContact(seedContacts, created)
  assert.equal(contacts[0].name, '新联系人')
  const changed = updateContact(contacts, 'new', (item) => ({ ...item, starred: true }))
  assert.ok(changed?.find((item) => item.id === 'new')?.starred)
  contacts = changed!
  const result = deleteContacts(contacts, ['new', 'missing'])
  assert.deepEqual(result.deleted.map((item) => item.id), ['new'])
  assert.equal(result.contacts.length, seedContacts.length)
})

test('undo restores deleted ids without rolling back later modifications', () => {
  const removed = deleteContacts(seedContacts, ['demo01'])
  const modified = updateContact(removed.contacts, 'demo02', (item) => ({ ...item, company: '并发后的公司' }))!
  const restored = restoreContacts(modified, removed.deleted)
  assert.equal(restored.find((item) => item.id === 'demo02')?.company, '并发后的公司')
  assert.equal(restored.filter((item) => item.id === 'demo01').length, 1)
})

test('bad stored format fails closed and remains untouched', () => {
  const storage = new MemoryStorage()
  storage.value = '{bad json'
  const result = readBook(storage, seedContacts)
  assert.deepEqual(result, { ok: false, raw: '{bad json', reason: 'invalid' })
  assert.equal(storage.value, '{bad json')
  assert.equal(parseBook(JSON.stringify({ version: 1, contacts: [{ id: 'bad' }] })), null)
  const oversizedNotes = { ...seedContacts[0], notes: Array.from({ length: 101 }, (_, index) => ({ id: String(index), text: 'x', createdAt: index })) }
  assert.equal(parseBook(JSON.stringify({ version: 1, contacts: [oversizedNotes] })), null)
})

test('raw compare detects cross-tab conflict before write', () => {
  const storage = new MemoryStorage()
  const first = commitBook(storage, null, seedContacts)
  assert.equal(first.ok, true)
  const external = JSON.stringify({ version: 1, contacts: seedContacts.slice(1) })
  storage.value = external
  assert.deepEqual(commitBook(storage, first.ok ? first.raw : null, []), { ok: false, reason: 'conflict' })
  assert.equal(storage.value, external)
})

test('storage getter and setter exceptions are contained', () => {
  const storage = new MemoryStorage()
  storage.failGet = true
  assert.deepEqual(readBook(storage, seedContacts), { ok: false, raw: null, reason: 'read' })
  storage.failGet = false
  storage.failSet = true
  assert.deepEqual(commitBook(storage, null, seedContacts), { ok: false, reason: 'write' })
})

test('field validation permits empty phone/email and rejects invalid or oversized values', () => {
  assert.deepEqual(validateDraft({ ...emptyDraft, name: '测试' }), {})
  const invalid = validateDraft({ ...emptyDraft, name: '', email: 'bad', phone: 'abc', tags: Array.from({ length: 11 }, () => 'x') })
  assert.equal(invalid.name, '请输入姓名')
  assert.equal(invalid.email, '邮箱格式不正确')
  assert.equal(invalid.phone, '电话号码格式不正确')
  assert.equal(invalid.tags, '标签最多 10 个，每个不超过 32 个字符')
  assert.equal(validateDraft({ ...emptyDraft, name: '测试', followUp: '2026-02-31' }).form, '字段内容过长')
})

test('storage key is isolated from the simple A edition', () => {
  assert.equal(BOOK_STORAGE_KEY, 'stitch-contacts-pro.book.v1')
  assert.doesNotMatch(BOOK_STORAGE_KEY, /^stitch-contacts(?:\.|$)/)
})
