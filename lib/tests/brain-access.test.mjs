import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const PICKER = fileURLToPath(new URL('../brain-access.sh', import.meta.url))
const RESOLVER = fileURLToPath(new URL('../resolve-brains.sh', import.meta.url))
const pick = (home, args, input = '') =>
  spawnSync('bash', [PICKER, ...args], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home }) })
const grants = (home, row) =>
  spawnSync('bash', [RESOLVER, '--row', row], { encoding: 'utf8', env: cleanEnv({ TILLER_HOME: home }) }).stdout.split('\n').filter(Boolean).map(l => l.split('\t').slice(0, 2).join(' ')).sort()
const matrix = home => JSON.parse(readFileSync(join(home, 'brains', 'access.json'), 'utf8'))

test('no argument prints profiles x brains with _none last', () => {
  const { home } = makeHome()
  const r = pick(home, [])
  assert.equal(r.status, 0, r.stderr)
  const rows = r.stdout.trim().split('\n')
  assert.match(rows[0], /acme-notes\s+main/)
  assert.match(rows.find(l => l.startsWith('acme ')), /write\s+read/)
  assert.match(rows.find(l => l.startsWith('beta ')), /none\s+none/)
  assert.match(rows.at(-1), /^_none\s+none\s+write/)
})

test('no matrix: the picker creates an empty one', () => {
  const { home } = makeHome({ matrix: null })
  assert.equal(pick(home, []).status, 0)
  assert.deepEqual(matrix(home), {})
})

test('--set round-trips through the resolver; none removes the cell and an empty row', () => {
  const { home } = makeHome()
  const r = pick(home, ['--set', 'beta', 'main', 'write'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /main\twrite/)
  assert.deepEqual(grants(home, 'beta'), ['main write'])
  pick(home, ['--set', 'beta', 'main', 'none'])
  assert.deepEqual(grants(home, 'beta'), [])
  assert.equal(matrix(home).beta, undefined)
  assert.deepEqual(readdirSync(join(home, 'brains')).filter(f => f.startsWith('.access')), [])
})

test('an unknown profile, brain or level is refused and the matrix is unchanged', () => {
  const { home } = makeHome()
  const before = readFileSync(join(home, 'brains', 'access.json'), 'utf8')
  for (const args of [['ghost', 'main', 'read'], ['acme', 'ghost', 'read'], ['acme', 'main', 'admin'], ['_template', 'main', 'read']])
    assert.equal(pick(home, ['--set', ...args]).status, 2, args.join(' '))
  assert.equal(pick(home, ['ghost']).status, 2)
  assert.equal(readFileSync(join(home, 'brains', 'access.json'), 'utf8'), before)
})

test('interactive: arrows move, space cycles, enter saves; q leaves the matrix alone', () => {
  const { home } = makeHome()
  // brains sorted: acme-notes, main. Down to main, space twice: none -> read -> write.
  const r = pick(home, ['beta'], '\x1b[B  \n')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(grants(home, 'beta'), ['main write'])
  pick(home, ['beta'], ' q')
  assert.deepEqual(grants(home, 'beta'), ['main write'])
})
