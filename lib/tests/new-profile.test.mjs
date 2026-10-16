// new-profile.sh seeds the leak guard with the profile's name, except the harness's own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = join(ROOT, 'lib', 'new-profile.sh')
const self = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

function create(name) {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/tmp', 'new-profile-'))
  const r = spawnSync('bash', [SCRIPT, name], { env: { ...process.env, TILLER_PROFILES_DIR: dir }, encoding: 'utf8' })
  return { r, dir, terms: existsSync(join(dir, name, 'leak-terms.txt')) ? readFileSync(join(dir, name, 'leak-terms.txt'), 'utf8') : null }
}

test('a project profile is seeded with its own name as a leak term', () => {
  const { r, terms } = create('acme')
  assert.equal(r.status, 0, r.stderr)
  assert.match(terms, /^\\bacme\\b$/m)
})

test('a profile named after the harness itself is not seeded: the name is in every tracked file', () => {
  const { r, terms } = create(self)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!terms.includes(`\\b${self}\\b`), 'the template seed stays, the name does not')
  assert.match(r.stderr, /not seeded/)
})
