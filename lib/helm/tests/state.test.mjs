import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveState } from '../state.mjs'

let n = 0
const ev = (min, kind, extra = {}) => ({
  id: `2026-10-14T09-${String(min).padStart(2, '0')}-00Z-m-${String(n++).padStart(6, '0')}`,
  project: 'acme', kind, summary: `${kind} ${min}`, source: 'manual', ...extra,
})

test('stage is the newest milestone, next the newest next step', () => {
  const s = deriveState([ev(1, 'milestone'), ev(3, 'milestone'), ev(2, 'next')]).acme
  assert.equal(s.stage.summary, 'milestone 3')
  assert.equal(s.next.summary, 'next 2')
  assert.equal(s.last, Date.parse('2026-10-14T09:03:00Z'))
})

test('a deadline moved by supersedes keeps only the new one open', () => {
  const a = ev(1, 'deadline', { due: '2026-10-20' })
  const b = ev(2, 'deadline', { due: '2026-10-24', supersedes: a.id })
  assert.deepEqual(deriveState([b, a]).acme.open.map(o => o.due), ['2026-10-24'])
})

test('a done that supersedes closes a promise and clears a parked', () => {
  const p = ev(1, 'promise', { due: '2026-10-17' })
  const k = ev(2, 'parked')
  const s = deriveState([p, k, ev(3, 'done', { supersedes: p.id }), ev(4, 'done', { supersedes: k.id })]).acme
  assert.deepEqual(s.open, [])
  assert.equal(s.parked, null)
})

test('a superseded latest next does not resurrect an older one', () => {
  const old = ev(1, 'next'); const latest = ev(2, 'next')
  assert.equal(deriveState([old, latest, ev(3, 'done', { supersedes: latest.id })]).acme.next, null)
})

test('equal timestamps order by the whole id', () => {
  const a = { ...ev(5, 'milestone'), id: '2026-10-14T09-05-00Z-a-000000' }
  const b = { ...ev(5, 'milestone'), id: '2026-10-14T09-05-00Z-b-000000', summary: 'from b' }
  assert.equal(deriveState([b, a]).acme.stage.summary, 'from b')
})

test('calendar_for marks a deadline as calendared', () => {
  const d = ev(1, 'deadline', { due: '2026-10-20' })
  assert.equal(deriveState([d, ev(2, 'note', { calendar_for: d.id })]).acme.open[0].calendared, true)
})

test('registered alone creates an empty project', () => {
  assert.deepEqual(deriveState([ev(1, 'registered')]).acme.open, [])
})
