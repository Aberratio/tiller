import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const SCRIPT = fileURLToPath(new URL('../resolve-brains.sh', import.meta.url))
const run = (home, args, extra = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: cleanEnv({ TILLER_HOME: home, ...extra }) })
const lines = r => r.stdout.split('\n').filter(Boolean).sort()

test('a profile row prints its read and write grants with absolute paths', () => {
  const { home, cwd } = makeHome()
  const r = run(home, [cwd.acme])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(lines(r), [`acme-notes\twrite\t${home}/brains/acme-notes`, `main\tread\t${home}/brains/main`])
})

test('a missing row is none: nothing printed, exit 0', () => {
  const { home, cwd } = makeHome()
  const r = run(home, [cwd.beta])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('no profile resolves: the _none row decides', () => {
  const { home, cwd } = makeHome()
  assert.deepEqual(lines(run(home, [cwd.none])), [`main\twrite\t${home}/brains/main`])
})

test('a missing cell is none: a new brain is closed until granted', () => {
  const { home, cwd } = makeHome()
  mkdirSync(join(home, 'brains', 'fresh'))
  const r = run(home, [cwd.acme])
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.includes('fresh'))
})

test('--row selects a row without a cwd', () => {
  const { home } = makeHome()
  assert.deepEqual(lines(run(home, ['--row', '_none'])), [`main\twrite\t${home}/brains/main`])
})

test('no matrix: everything is none', () => {
  const { home, cwd } = makeHome({ matrix: null })
  const r = run(home, [cwd.none])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('an unknown value, brain or profile, or broken JSON, is exit 2 naming the problem', () => {
  const cases = [
    [{ acme: { main: 'admin' } }, /unknown level "admin"/],
    [{ acme: { ghost: 'read' } }, /no such brain "ghost"/],
    [{ ghost: { main: 'read' } }, /row "ghost": no such profile/],
    ['{ not json', /not valid JSON/],
  ]
  for (const [matrix, msg] of cases) {
    const { home, cwd } = makeHome({ matrix })
    const r = run(home, [cwd.acme])
    assert.equal(r.status, 2, JSON.stringify(matrix))
    assert.match(r.stderr, msg)
    assert.equal(r.stdout, '')
  }
})

test('TILLER_HOME unset is exit 3; a named profile that does not exist is exit 4', () => {
  const { home, cwd } = makeHome()
  assert.equal(run(home, [cwd.acme], { TILLER_HOME: undefined }).status, 3)
  const ghost = spawnSync('bash', [SCRIPT, cwd.acme], { encoding: 'utf8', env: { ...cleanEnv({ TILLER_HOME: home }), TILLER_PROFILE: 'ghost' } })
  assert.equal(ghost.status, 4)
})
