import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatMachine, machineName, parseMachine, refreshMachine } from '../machine.mjs'

test('machineName: TILLER_MACHINE wins, else the short hostname, sanitised', () => {
  assert.equal(machineName({ TILLER_MACHINE: 'Work Mac' }, 'x.local'), 'work-mac')
  assert.equal(machineName({}, 'MacBook-Pro.local'), 'macbook-pro')
})

test('format and parse round-trip', () => {
  const m = { machine: 'laptop', last_seen: '2026-10-14', profiles: ['acme', 'beta'], capabilities: ['calendar', 'gh'], clones: { acme: '/Users/x/Other Repos/acme-web' } }
  assert.deepEqual(parseMachine(formatMachine(m)), m)
})

test('refresh learns the clone of the session project and drops clones that vanished', () => {
  const prev = { machine: 'laptop', last_seen: '2026-10-01', profiles: [], capabilities: [], clones: { beta: '/gone', gamma: '/kept' } }
  const m = refreshMachine(prev, { name: 'laptop', today: '2026-10-14', profiles: ['beta', 'acme'], caps: ['gh', 'gh'], row: 'acme', clone: '/src/acme' }, p => p !== '/gone')
  assert.deepEqual(m, { machine: 'laptop', last_seen: '2026-10-14', profiles: ['acme', 'beta'], capabilities: ['gh'], clones: { gamma: '/kept', acme: '/src/acme' } })
})
