import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KINDS, formatEvent, idTime, newId, parseFrontmatter, validate } from '../events.mjs'

const base = { id: '2026-10-14T09-12-40Z-laptop-3f9a1c', project: 'acme', kind: 'note', summary: 's', source: 'manual' }

test('newId puts the UTC second first, then machine and hex', () => {
  assert.equal(newId(new Date('2026-10-14T09:12:40.123Z'), 'laptop', '3f9a1c'), '2026-10-14T09-12-40Z-laptop-3f9a1c')
})

test('idTime reads the timestamp back', () => {
  assert.equal(idTime('2026-10-14T09-12-40Z-laptop-3f9a1c'), Date.parse('2026-10-14T09:12:40Z'))
  assert.ok(Number.isNaN(idTime('nonsense')))
})

test('format and parse round-trip, colons and quotes in the summary included', () => {
  const e = { ...base, kind: 'deadline', due: '2026-10-21', summary: 'Spec: "v2" signed off', link: 'https://example.invalid/a?b=c:d' }
  const { fields } = parseFrontmatter(formatEvent(e))
  assert.deepEqual(fields, Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)])))
})

test('a newline in a field is flattened so it cannot break the frontmatter', () => {
  const { fields } = parseFrontmatter(formatEvent({ ...base, summary: 'one\n---\ntwo' }))
  assert.equal(fields.summary, 'one --- two')
  assert.equal(fields.kind, 'note')
})

test('body survives', () => {
  assert.equal(parseFrontmatter(formatEvent({ ...base, body: 'details\nmore' })).body, 'details\nmore')
})

test('parseFrontmatter refuses text without frontmatter', () => {
  assert.throws(() => parseFrontmatter('just text'), /no frontmatter/)
})

test('validate', () => {
  assert.equal(validate(base), null)
  assert.match(validate({ ...base, summary: '' }), /missing summary/)
  assert.match(validate({ ...base, kind: 'todo' }), /unknown kind/)
  assert.match(validate({ ...base, kind: 'deadline' }), /deadline needs due/)
  assert.match(validate({ ...base, kind: 'promise', due: 'Friday' }), /bad due/)
  assert.equal(validate({ ...base, kind: 'promise', due: '2026-10-17T15:00Z' }), null)
  assert.match(validate({ ...base, project: '../beta' }), /bad project/)
  assert.deepEqual(KINDS, ['registered', 'milestone', 'next', 'deadline', 'promise', 'parked', 'done', 'note'])
})

test('validate rejects impossible dates', () => {
  for (const due of ['2026-13-45', '2026-02-30', '2026-00-10', '2026-10-14T25:00Z']) {
    assert.match(validate({ ...base, kind: 'deadline', due }), /bad due/, due)
  }
  assert.equal(validate({ ...base, kind: 'deadline', due: '2028-02-29' }), null)
})
