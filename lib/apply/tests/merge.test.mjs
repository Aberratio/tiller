import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InvalidNativeFile, plan, resolveDrift, writeAtomic } from '../merge.mjs'
import { hashValue } from '../manifest.mjs'

const { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } = fs

const PATH = '/h/.claude/settings.json'
const HOOK = {
  id: 'hook:PreToolUse:private-access',
  value: { matcher: 'Read|Bash', hooks: [{ type: 'command', command: "TILLER_HOOK=private-access '/t/hook.sh'" }] },
}
const target = (items = [{ id: '/env/TILLER_HOME', value: '/t' }, HOOK]) => ({ path: PATH, kind: 'json', items })

// Plan, then build the manifest entry the way apply does.
function step(t, current, entry, released) {
  const p = plan(t, current, entry, released)
  return { p, text: p.next.text, entry: { kind: 'json', items: p.next.items }, released: p.next.released }
}

const USER = {
  env: { MINE: 'keep' },
  model: 'x',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook' }] }] },
}

test('first apply sets the items and leaves user keys and user hooks as they were', () => {
  const { p, text } = step(target(), JSON.stringify(USER, null, 2) + '\n', null, [])
  assert.deepEqual(p.changes.map(c => [c.id, c.op]), [['/env/TILLER_HOME', 'set'], [HOOK.id, 'set']])
  assert.equal(p.write, true)
  const out = JSON.parse(text)
  assert.equal(out.env.TILLER_HOME, '/t')
  assert.equal(out.env.MINE, 'keep')
  assert.equal(out.model, 'x')
  assert.deepEqual(out.hooks.PreToolUse[0], USER.hooks.PreToolUse[0])
  assert.deepEqual(out.hooks.PreToolUse[1], HOOK.value)
})

test('a missing file is created with the items', () => {
  const { p, text } = step(target(), null, null, [])
  assert.equal(p.write, true)
  assert.deepEqual(JSON.parse(text), { env: { TILLER_HOME: '/t' }, hooks: { PreToolUse: [HOOK.value] } })
  assert.ok(text.endsWith('\n'))
})

test('a second plan on the written file changes nothing', () => {
  const first = step(target(), JSON.stringify(USER), null, [])
  const second = step(target(), first.text, first.entry, first.released)
  assert.deepEqual(second.p.changes, [])
  assert.deepEqual(second.p.drift, [])
  assert.equal(second.p.write, false)
  assert.deepEqual(second.entry.items, first.entry.items)
})

test('an owned item no longer desired is removed when unedited; the user hook stays', () => {
  const first = step(target(), JSON.stringify(USER), null, [])
  const { p, text } = step(target([{ id: '/env/TILLER_HOME', value: '/t' }]), first.text, first.entry, [])
  assert.deepEqual(p.changes.map(c => [c.id, c.op]), [[HOOK.id, 'remove']])
  assert.deepEqual(JSON.parse(text).hooks.PreToolUse, USER.hooks.PreToolUse)
  assert.equal(p.next.items[HOOK.id], undefined)
})

function edited() {
  const first = step(target(), null, null, [])
  const doc = JSON.parse(first.text)
  doc.env.TILLER_HOME = '/hand'
  return { text: JSON.stringify(doc, null, 2) + '\n', entry: first.entry }
}

test('an edited owned item is drift, not a write', () => {
  const e = edited()
  const { p } = step(target(), e.text, e.entry, [])
  assert.deepEqual(p.drift, [{ id: '/env/TILLER_HOME', reason: 'edited', current: '/hand', desired: '/t' }])
  assert.deepEqual(p.changes, [])
  assert.equal(JSON.parse(p.next.text).env.TILLER_HOME, '/hand')
})

test('drift resolved by overwrite sets the desired value', () => {
  const e = edited()
  const r = resolveDrift(plan(target(), e.text, e.entry, []), { '/env/TILLER_HOME': 'overwrite' })
  assert.deepEqual(r.drift, [])
  assert.deepEqual(r.changes.map(c => [c.id, c.op]), [['/env/TILLER_HOME', 'set']])
  assert.equal(JSON.parse(r.next.text).env.TILLER_HOME, '/t')
  assert.equal(r.next.items['/env/TILLER_HOME'], hashValue('/t'))
})

test('drift resolved by release drops ownership and the next plan ignores the item', () => {
  const e = edited()
  const r = resolveDrift(plan(target(), e.text, e.entry, []), { '/env/TILLER_HOME': 'release' })
  assert.equal(r.write, false)
  assert.equal(r.next.items['/env/TILLER_HOME'], undefined)
  assert.deepEqual(r.next.released, ['/env/TILLER_HOME'])
  const again = plan(target(), e.text, { kind: 'json', items: r.next.items }, r.next.released)
  assert.deepEqual([again.changes, again.drift], [[], []])
})

test('drift resolved by adopt returns the current value and re-owns it at that hash', () => {
  const e = edited()
  const r = resolveDrift(plan(target(), e.text, e.entry, []), { '/env/TILLER_HOME': 'adopt' })
  assert.deepEqual(r.adopted, [{ id: '/env/TILLER_HOME', value: '/hand' }])
  assert.equal(r.write, false)
  assert.equal(r.next.items['/env/TILLER_HOME'], hashValue('/hand'))
  const again = plan(target([{ id: '/env/TILLER_HOME', value: '/hand' }, HOOK]), e.text, { kind: 'json', items: r.next.items }, r.next.released)
  assert.deepEqual([again.changes, again.drift], [[], []])
})

test('an unowned value that differs is drift, never a silent set', () => {
  const { p } = step(target(), JSON.stringify({ env: { TILLER_HOME: '/mine' } }), null, [])
  assert.deepEqual(p.drift.map(d => [d.id, d.reason]), [['/env/TILLER_HOME', 'unowned-differs']])
  assert.equal(JSON.parse(p.next.text).env.TILLER_HOME, '/mine')
})

test('an unowned equal value is taken over without a write', () => {
  const current = JSON.stringify({ env: { TILLER_HOME: '/t' }, hooks: { PreToolUse: [HOOK.value] } })
  const { p } = step(target(), current, null, [])
  assert.deepEqual(p.changes.map(c => c.op), ['own', 'own'])
  assert.equal(p.write, false)
  assert.equal(p.next.items['/env/TILLER_HOME'], hashValue('/t'))
})

test('invalid JSON throws InvalidNativeFile naming the path', () => {
  assert.throws(() => plan(target(), '{"env":', null, []), e => e instanceof InvalidNativeFile && e.message.includes(PATH))
  assert.throws(() => plan(target(), '[1]', null, []), InvalidNativeFile)
})

test('the original indent and missing trailing newline are kept', () => {
  const four = JSON.stringify({ model: 'x' }, null, 4)
  const { text } = step(target([{ id: '/env/A', value: '1' }]), four, null, [])
  assert.equal(text, JSON.stringify({ model: 'x', env: { A: '1' } }, null, 4))
})

test('pointer segments are unescaped', () => {
  const { text } = step(target([{ id: '/permissions/a~1b~0c', value: 1 }]), '{}', null, [])
  assert.deepEqual(JSON.parse(text), { permissions: { 'a/b~c': 1 } })
})

const dir = () => mkdtempSync(join(tmpdir(), 'merge-'))

test('writeAtomic backs up the original, then replaces it', () => {
  const d = dir(), file = join(d, 'settings.json'), backups = join(d, 'backups')
  writeFileSync(file, 'old')
  const backup = writeAtomic(file, 'new', { backupDir: backups })
  assert.equal(readFileSync(file, 'utf8'), 'new')
  assert.equal(readFileSync(backup, 'utf8'), 'old')
  assert.deepEqual(readdirSync(d).sort(), ['backups', 'settings.json'])
})

test('writeAtomic creates a missing file and makes no backup', () => {
  const d = dir(), file = join(d, 'sub', 'CLAUDE.md'), backups = join(d, 'backups')
  assert.equal(writeAtomic(file, 'x', { backupDir: backups }), null)
  assert.equal(readFileSync(file, 'utf8'), 'x')
  assert.equal(fs.existsSync(backups), false)
})

test('writeAtomic whose rename fails leaves the original and no temporary file', () => {
  const d = dir(), file = join(d, 'settings.json')
  writeFileSync(file, 'old')
  const failing = { ...fs, renameSync: () => { throw new Error('disk full') } }
  assert.throws(() => writeAtomic(file, 'new', { backupDir: join(d, 'backups'), fs: failing }), /disk full/)
  assert.equal(readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(readdirSync(d).filter(f => f !== 'backups'), ['settings.json'])
})

test('writeAtomic through a symlink updates the target and keeps the link', { skip: process.platform === 'win32' && 'a file symlink needs privileges on Windows' }, () => {
  const d = dir(), real = join(d, 'dotfiles', 'settings.json'), link = join(d, 'settings.json')
  mkdirSync(join(d, 'dotfiles'))
  writeFileSync(real, 'old')
  symlinkSync(real, link)
  writeAtomic(link, 'new', { backupDir: join(d, 'backups') })
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), real)
  assert.equal(readFileSync(real, 'utf8'), 'new')
})
