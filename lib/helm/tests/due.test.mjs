import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueMs, report, statusOrder, statusText } from '../due.mjs'

const P = (o = {}) => ({ stage: null, next: null, parked: null, open: [], last: Date.parse('2026-10-14T08:00:00Z'), ...o })
const D = (due, summary = 'x', kind = 'deadline') => ({ id: `id-${summary}`, kind, due, summary, calendared: false })
const opt = { now: new Date('2026-10-14T12:00:00Z'), tz: 'UTC', staleDays: 7, self: 'laptop' }

test('a date-only due is the end of that day in the helm time zone', () => {
  assert.equal(dueMs('2026-10-14', 'Europe/Warsaw'), Date.parse('2026-10-14T21:59:59Z'))
  assert.equal(dueMs('2026-10-14', 'UTC'), Date.parse('2026-10-14T23:59:59Z'))
  assert.equal(dueMs('2026-10-14T15:00Z', 'Europe/Warsaw'), Date.parse('2026-10-14T15:00:00Z'))
})

test('due today in UTC+2 is not overdue at 23:00 local', () => {
  const s = { acme: P({ open: [D('2026-10-14', 'ship')] }) }
  const lines = report(s, [], { ...opt, tz: 'Europe/Warsaw', now: new Date('2026-10-14T21:00:00Z') })
  assert.deepEqual(lines, ['due 2026-10-14: acme - ship'])
})

test('order: overdue, due within 48 h, parked, stale, stranded machines', () => {
  const s = {
    acme: P({ open: [D('2026-10-15', 'soon'), D('2026-10-20', 'later'), D('2026-10-10', 'late')] }),
    beta: P({ parked: { summary: 'waiting on client' } }),
    gamma: P({ last: Date.parse('2026-10-01T00:00:00Z') }),
  }
  const machines = [{ machine: 'desktop', last_seen: '2026-10-02', clones: {} }, { machine: 'laptop', last_seen: '2026-10-01', clones: {} }]
  assert.deepEqual(report(s, machines, opt), [
    'overdue: acme - late (due 2026-10-10)',
    'due 2026-10-15: acme - soon',
    'parked: beta - waiting on client',
    'stale: gamma - no activity for 13 days',
    'machine desktop: last synced 2026-10-02, its events may be missing',
  ])
})

test('a project session sees only its project and no machines', () => {
  const s = { acme: P({ open: [D('2026-10-10', 'a')] }), beta: P({ open: [D('2026-10-10', 'b')] }) }
  const machines = [{ machine: 'desktop', last_seen: '2026-09-01', clones: {} }]
  assert.deepEqual(report(s, machines, { ...opt, project: 'acme' }), ['overdue: acme - a (due 2026-10-10)'])
})

test('own unpushed commits are reported; offline adds a header; limit caps the list', () => {
  const s = { acme: P({ open: ['01', '02', '03', '04', '05', '06'].map(d => D(`2026-10-${d}`, d)) }) }
  const lines = report(s, [], { ...opt, unpushed: 2, offline: true })
  assert.equal(lines[0], 'helm: offline, showing local state')
  assert.equal(lines.length, 6)
  assert.equal(report({}, [], { ...opt, unpushed: 2 })[0], 'this machine: 2 local commit(s) not pushed')
  assert.deepEqual(report({}, [], { ...opt, offline: true }), [])
})

test('status order: earliest due first, then oldest activity, parked last', () => {
  const s = {
    a: P({ open: [D('2026-10-30')] }),
    b: P({ open: [D('2026-10-16')] }),
    c: P({ last: Date.parse('2026-10-13T00:00:00Z') }),
    d: P({ last: Date.parse('2026-10-10T00:00:00Z') }),
    e: P({ parked: { summary: 'x' }, open: [D('2026-10-15')] }),
  }
  assert.deepEqual(statusOrder(s, 'UTC'), ['b', 'a', 'd', 'c', 'e'])
})

test('status text names the machine that holds the clone', () => {
  const s = { acme: P({ next: { summary: 'review PR' } }) }
  const text = statusText(s, [{ machine: 'desktop', clones: { acme: '/src/acme-web' } }], opt)
  assert.match(text, /## acme/)
  assert.match(text, /- next: review PR/)
  assert.match(text, /- clones: desktop: \/src\/acme-web/)
})
