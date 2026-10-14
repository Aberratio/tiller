import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { link, planLink, readLink, unlink } from '../link.mjs'

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

test('Windows linking is not built yet', () => {
  const s = scene()
  assert.throws(() => link(s.dest, s.source, { platform: 'win32' }), /step 5/)
  assert.equal(existsSync(s.dest), false)
})
