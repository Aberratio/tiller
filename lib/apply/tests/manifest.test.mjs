import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashValue, loadManifest, saveManifest } from '../manifest.mjs'

const stateHome = () => join(mkdtempSync(join(tmpdir(), 'manifest-')), 'state')

test('a missing manifest loads empty', () => {
  assert.deepEqual(loadManifest(stateHome()), { version: 1, files: {}, released: {}, links: {} })
})

test('the manifest round-trips, released included, with no temporary file left', () => {
  const s = stateHome()
  const m = {
    version: 1,
    files: { '/h/.claude/settings.json': { agent: 'claude', kind: 'json', items: { '/env/X': hashValue('1') }, writtenHash: 'abc', backup: null } },
    released: { '/h/.claude/settings.json': ['/env/Y'] },
    links: { '/h/.claude/skills/a': { agent: 'claude', kind: 'skill', mode: 'symlink', source: '/t/skills/a' } },
  }
  saveManifest(s, m)
  assert.deepEqual(loadManifest(s), m)
  assert.deepEqual(readdirSync(s), ['owned.json'])
  assert.ok(readFileSync(join(s, 'owned.json'), 'utf8').endsWith('\n'))
})

test('an invalid manifest throws naming the file', () => {
  const s = stateHome()
  saveManifest(s, { version: 1, files: {}, released: {} })
  writeFileSync(join(s, 'owned.json'), '{')
  assert.throws(() => loadManifest(s), /owned\.json/)
})

test('hashValue is independent of key order', () => {
  assert.equal(hashValue({ a: 1, b: { c: [1, 2], d: 'x' } }), hashValue({ b: { d: 'x', c: [1, 2] }, a: 1 }))
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }))
  assert.match(hashValue('x'), /^[0-9a-f]{64}$/)
})

