// Every lane in config/routing.json must be dispatched somewhere; a lane nobody calls is dead config
// that launch validation would still have to keep eligible.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const ROOTS = ['lib/driver', 'lib/escalation', 'skills']

function sources(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) { if (e !== 'tests' && e !== 'node_modules') sources(p, out) }
    else if (p.endsWith('.mjs')) out.push(p)
  }
  return out
}
const FILES = ROOTS.flatMap(r => sources(join(CORE, r))).map(p => ({ path: relative(CORE, p), text: readFileSync(p, 'utf8') }))

// The escalation chain names its roles as data and the driver dispatches them with c.lane(role, ...).
const ROLE_DISPATCH = { list: 'lib/escalation/route.mjs', via: 'c.lane(role' }

function callersOf(lane, files = FILES) {
  const esc = lane.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const direct = new RegExp(`\\blane\\(\\s*['"\`]${esc}['"\`]`)
  const hits = files.filter(f => direct.test(f.text)).map(f => f.path)
  const list = files.find(f => f.path === ROLE_DISPATCH.list)
  const viaRole = files.some(f => f.text.includes(ROLE_DISPATCH.via))
  if (list && viaRole && new RegExp(`\\[[^\\]]*'${esc}'[^\\]]*\\]`).test(list.text)) hits.push(`${ROLE_DISPATCH.list} (role)`)
  return hits
}

test('every lane in config/routing.json has a caller in lib/driver, lib/escalation or skills', () => {
  const routing = JSON.parse(readFileSync(join(CORE, 'config', 'routing.json'), 'utf8'))
  const orphans = Object.keys(routing.lanes).filter(l => callersOf(l).length === 0)
  assert.deepEqual(orphans, [])
})

test('the check is not vacuous: a lane nobody dispatches has no caller, a dispatched one does', () => {
  assert.deepEqual(callersOf('no-such-lane'), [])
  assert.ok(callersOf('plan').length > 0)
  assert.ok(callersOf('resolver').some(c => c.endsWith('(role)')))
  assert.deepEqual(callersOf('x', [{ path: 'a.mjs', text: "c.lane('x', p)" }]), ['a.mjs'])
  assert.deepEqual(callersOf('x', [{ path: 'a.mjs', text: "// lane x is gone\nconst y = 'x'" }]), [])
})
