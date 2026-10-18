import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyDraft, seedContacts } from '../data/mockData.ts'
import {
  filterContacts,
  parsePersistedContacts,
  removeContact,
  serializeContacts,
  toggleContactFavorite,
  upsertContact,
  validateContactDraft,
  writePersistedContacts,
} from './contacts.ts'

test('seed data is safe, deterministic demo content', () => {
  assert.equal(seedContacts.length, 9)
  assert.equal(seedContacts[0]?.name, '张伟')
  assert.equal(seedContacts.filter((contact) => contact.favorite).length, 3)
  assert.ok(seedContacts.every((contact) => contact.email.endsWith('@example.com')))
  assert.ok(seedContacts.every((contact) => /^202-555-01\d{2}$/.test(contact.phone)))
})

test('persisted contacts round-trip and corrupted content fails closed', () => {
  const serialized = serializeContacts(seedContacts)
  assert.deepEqual(parsePersistedContacts(serialized), { ok: true, contacts: seedContacts })
  assert.equal(parsePersistedContacts('{broken').ok, false)
  assert.equal(parsePersistedContacts(JSON.stringify([{ id: 'partial' }])).ok, false)
  assert.equal(
    parsePersistedContacts(JSON.stringify([seedContacts[0], seedContacts[0]])).ok,
    false,
  )
})

test('read-only persistence never reads or overwrites unknown content', () => {
  let reads = 0
  let writes = 0
  const storage = {
    getItem() {
      reads += 1
      return 'unknown content'
    },
    setItem() {
      writes += 1
    },
  }
  assert.equal(writePersistedContacts(storage, seedContacts, true, null).ok, false)
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('persistence transaction rejects stale snapshots without writing', () => {
  let writes = 0
  const result = writePersistedContacts({
    getItem() {
      return 'newer content from another tab'
    },
    setItem() {
      writes += 1
    },
  }, seedContacts, false, 'previously observed content')
  assert.equal(result.ok, false)
  assert.equal(result.ok ? '' : result.reason, 'conflict')
  assert.equal(writes, 0)
})

test('persistence transaction catches read and write failures and returns its new snapshot', () => {
  const readFailure = writePersistedContacts({
    getItem() {
      throw new Error('storage disabled')
    },
    setItem() {
      assert.fail('must not write after a failed read')
    },
  }, seedContacts, false, null)
  assert.equal(readFailure.ok, false)
  assert.equal(readFailure.ok ? '' : readFailure.reason, 'unavailable')

  const failure = writePersistedContacts({
    getItem() {
      return null
    },
    setItem() {
      throw new Error('quota exceeded')
    },
  }, seedContacts, false, null)
  assert.equal(failure.ok, false)
  assert.match(failure.ok ? '' : failure.error, /保存失败/)

  let written = ''
  const success = writePersistedContacts({
    getItem() {
      return null
    },
    setItem(_key, value) {
      written = value
    },
  }, seedContacts, false, null)
  assert.equal(success.ok, true)
  assert.equal(success.ok ? success.raw : '', written)
})

test('filterContacts combines query and filter without mutating source', () => {
  const original = structuredClone(seedContacts)
  assert.deepEqual(filterContacts(seedContacts, '远山', 'all').map((item) => item.name), ['张伟'])
  assert.deepEqual(
    filterContacts(seedContacts, 'example.com', 'favorites').map((item) => item.name).sort(),
    seedContacts.filter((item) => item.favorite).map((item) => item.name).sort(),
  )
  assert.ok(filterContacts(seedContacts, '', '朋友').every((item) => item.group === '朋友'))
  assert.deepEqual(seedContacts, original)
})

test('validation requires only a name and allows empty phone and email', () => {
  const missing = validateContactDraft(emptyDraft)
  assert.ok(missing.name)
  assert.equal(missing.phone, undefined)
  assert.equal(missing.email, undefined)

  assert.deepEqual(validateContactDraft({ ...emptyDraft, name: '只有姓名' }), {})
})

test('validation checks optional formats and domain length limits', () => {
  const invalid = validateContactDraft({
    ...emptyDraft,
    name: '测试联系人',
    phone: '123',
    email: 'not-an-email',
  })
  assert.ok(invalid.phone)
  assert.ok(invalid.email)

  assert.deepEqual(validateContactDraft({ ...seedContacts[0]! }), {})

  const tooLong = validateContactDraft({
    ...emptyDraft,
    name: '名'.repeat(101),
    company: '公'.repeat(101),
    role: '职'.repeat(101),
    phone: '1'.repeat(41),
    email: `${'a'.repeat(243)}@example.com`,
    notes: '注'.repeat(501),
  })
  assert.deepEqual(Object.keys(tooLong).sort(), [
    'company',
    'email',
    'name',
    'notes',
    'phone',
    'role',
  ])
})

test('upsert, favorite toggle, and remove return new values', () => {
  const created = upsertContact(seedContacts, {
    ...emptyDraft,
    name: '  测试联系人  ',
    phone: '202-555-0199',
    email: 'tester@example.com',
  }, 'contact-test')
  assert.equal(created.length, seedContacts.length + 1)
  assert.equal(created.at(-1)?.name, '测试联系人')

  const edited = upsertContact(created, { ...created.at(-1)!, role: '编辑后' }, 'contact-test')
  assert.equal(edited.length, created.length)
  assert.equal(edited.find((contact) => contact.id === 'contact-test')?.role, '编辑后')

  const toggled = toggleContactFavorite(edited, 'contact-test')
  assert.equal(toggled.find((contact) => contact.id === 'contact-test')?.favorite, true)
  assert.equal(edited.find((contact) => contact.id === 'contact-test')?.favorite, false)

  const removed = removeContact(toggled, 'contact-test')
  assert.equal(removed.length, seedContacts.length)
  assert.equal(removed.some((contact) => contact.id === 'contact-test'), false)
})
