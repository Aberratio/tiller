import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as nodeFs from 'node:fs'
import { hashBytes, link, planCopy, planLink, readLink, sameTarget, unlink } from '../link.mjs'

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'link.mjs')

function scene() {
  const root = mkdtempSync(join(tmpdir(), 'link-'))
  const source = join(root, 'repo', 'skills', 'alpha')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), '# alpha\n')
  return { root, source, dest: join(root, 'home', '.claude', 'skills', 'alpha') }
}

const plan = (s, entry) => planLink({ dest: s.dest, source: s.source }, readLink(s.dest), entry)

test('an absent destination is created as a symlink, parents included', () => {
  const s = scene()
  assert.equal(plan(s), 'create')
  link(s.dest, s.source)
  assert.equal(readlinkSync(s.dest), s.source)
  assert.equal(plan(s, { source: s.source }), 'ok')
})

test('a symlink already pointing at the source is ok, even with no manifest entry', () => {
  const s = scene()
  link(s.dest, s.source)
  assert.equal(plan(s), 'ok')
})

test('a foreign directory or file is skipped', () => {
  const s = scene()
  mkdirSync(s.dest, { recursive: true })
  assert.equal(plan(s), 'skip-foreign')
  assert.equal(plan(s, { source: s.source }), 'skip-foreign')
})

test('a symlink to somewhere else that tiller did not record is skipped', () => {
  const s = scene()
  mkdirSync(join(s.root, 'home', '.claude', 'skills'), { recursive: true })
  symlinkSync(join(s.root, 'elsewhere'), s.dest)
  assert.equal(plan(s), 'skip-foreign')
  assert.equal(plan(s, { source: join(s.root, 'other') }), 'skip-foreign')
})

test('our dangling link to a source that moved is refreshed', () => {
  const s = scene()
  const old = join(s.root, 'old', 'alpha')
  link(s.dest, old)
  assert.equal(plan(s, { source: old }), 'refresh')
  assert.equal(unlink(s.dest, old), true)
  link(s.dest, s.source)
  assert.equal(readlinkSync(s.dest), s.source)
})

test('unlink removes only a symlink still pointing at the source', () => {
  const s = scene()
  mkdirSync(s.dest, { recursive: true })
  assert.equal(unlink(s.dest, s.source), false)
  assert.ok(lstatSync(s.dest).isDirectory())

  const t = scene()
  link(t.dest, join(t.root, 'elsewhere'))
  assert.equal(unlink(t.dest, t.source), false)
  assert.ok(lstatSync(t.dest).isSymbolicLink())

  const u = scene()
  link(u.dest, u.source)
  assert.equal(unlink(u.dest, u.source), true)
  assert.equal(existsSync(u.dest), false)
  assert.ok(existsSync(join(u.source, 'SKILL.md')))
  assert.equal(unlink(u.dest, u.source), false)
})

test('link refuses to replace an existing path', () => {
  const s = scene()
  mkdirSync(s.dest, { recursive: true })
  assert.throws(() => link(s.dest, s.source), /EEXIST/)
})

// Off Windows, symlinkSync ignores its type argument, so the spy is what proves a junction was asked for.
function spyFs() {
  const calls = []
  return { calls, fs: { ...nodeFs, symlinkSync: (...a) => { calls.push(a); return nodeFs.symlinkSync(...a) } } }
}

test('win32: a skill directory is linked as a junction', () => {
  const s = scene()
  const { calls, fs } = spyFs()
  assert.deepEqual(link(s.dest, s.source, { platform: 'win32', fs }), { mode: 'junction' })
  assert.deepEqual(calls, [[s.source, s.dest, 'junction']])
  assert.equal(readFileSync(join(s.dest, 'SKILL.md'), 'utf8'), '# alpha\n')
  assert.equal(planLink({ source: s.source }, readLink(s.dest), null, 'win32'), 'ok')
})

test('win32: a file source is copied and its hash returned', () => {
  const s = scene()
  const src = join(s.source, 'SKILL.md'), dest = join(s.root, 'home', '.claude', 'agents', 'a.md')
  const { calls, fs } = spyFs()
  const r = link(dest, src, { platform: 'win32', fs })
  assert.deepEqual(r, { mode: 'copy', hash: hashBytes(Buffer.from('# alpha\n')) })
  assert.deepEqual(calls, [])
  assert.equal(lstatSync(dest).isFile(), true)
  assert.equal(readFileSync(dest, 'utf8'), '# alpha\n')
})

test('posix: link reports symlink mode', () => {
  const s = scene()
  assert.deepEqual(link(s.dest, s.source), { mode: 'symlink' })
})

test('sameTarget: win32 ignores the long-path prefixes, trailing separators and case', () => {
  const t = 'C:\\Users\\x\\tiller\\skills\\a'
  for (const other of ['\\\\?\\C:\\Users\\x\\tiller\\skills\\a', '\\??\\C:\\Users\\x\\tiller\\skills\\a\\',
    'c:\\users\\X\\Tiller\\skills\\A', 'C:/Users/x/tiller/skills/a/']) {
    assert.equal(sameTarget(t, other, 'win32'), true, other)
  }
  assert.equal(sameTarget(t, 'C:\\Users\\x\\tiller\\skills\\b', 'win32'), false)
  assert.equal(sameTarget('/a/B', '/a/b', 'darwin'), false)
  assert.equal(sameTarget('/a/b', '/a/b', 'linux'), true)
})

function copyScene() {
  const s = scene()
  const source = join(s.source, 'SKILL.md'), dest = join(s.root, 'home', '.claude', 'agents', 'a.md')
  return { ...s, source, dest }
}

test('planCopy: create, ok, refresh, drift and foreign', () => {
  const s = copyScene()
  assert.equal(planCopy({ source: s.source }, s.dest, null), 'create')
  const { hash } = link(s.dest, s.source, { platform: 'win32' })
  const entry = { mode: 'copy', source: s.source, hash }
  assert.equal(planCopy({ source: s.source }, s.dest, entry), 'ok')
  writeFileSync(s.source, '# alpha v2\n')
  assert.equal(planCopy({ source: s.source }, s.dest, entry), 'refresh')
  writeFileSync(s.dest, '# edited\n')
  assert.equal(planCopy({ source: s.source }, s.dest, entry), 'drift')
  assert.equal(planCopy({ source: s.source }, s.dest, null), 'skip-foreign')
  writeFileSync(s.dest, '# alpha v2\n')
  assert.equal(planCopy({ source: s.source }, s.dest, null), 'ok')
})

test('win32 unlink: removes our junction and an unedited copy, leaves an edited copy and a foreign junction', () => {
  const s = scene()
  link(s.dest, s.source, { platform: 'win32' })
  assert.equal(unlink(s.dest, s.source, { platform: 'win32' }), true)
  assert.equal(existsSync(s.dest), false)
  assert.ok(existsSync(join(s.source, 'SKILL.md')))

  const f = scene()
  mkdirSync(join(f.root, 'elsewhere'))
  link(f.dest, join(f.root, 'elsewhere'), { platform: 'win32' })
  assert.equal(unlink(f.dest, f.source, { platform: 'win32' }), false)
  assert.ok(lstatSync(f.dest).isSymbolicLink())

  const c = copyScene()
  const { hash } = link(c.dest, c.source, { platform: 'win32' })
  const entry = { mode: 'copy', source: c.source, hash }
  writeFileSync(c.dest, '# edited\n')
  assert.equal(unlink(c.dest, c.source, { platform: 'win32', entry }), false)
  assert.equal(readFileSync(c.dest, 'utf8'), '# edited\n')
  writeFileSync(c.dest, '# alpha\n')
  assert.equal(unlink(c.dest, c.source, { platform: 'win32', entry }), true)
  assert.equal(existsSync(c.dest), false)
})

test('CLI: prints linked, ok or skipped and never replaces a foreign path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-cli-'))
  const src = join(dir, 'src'), dest = join(dir, 'out', 'dest'), other = join(dir, 'other')
  mkdirSync(src)
  writeFileSync(other, 'x')
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
  assert.deepEqual([run(src, dest).stdout, run(src, dest).stdout, run(src, other).stdout], ['linked\n', 'ok\n', 'skipped\n'])
  assert.equal(readlinkSync(dest), src)
  assert.equal(readFileSync(other, 'utf8'), 'x')
  const usage = run(src)
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /usage/)
})
