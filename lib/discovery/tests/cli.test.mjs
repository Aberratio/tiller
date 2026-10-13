import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'discovery.mjs')
const VALID = join(HERE, '..', '..', 'testing', 'fixtures', 'discovery', 'valid')
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })
function root() { const d = mkdtempSync(join(tmpdir(), 'brains-')); temps.push(d); return d }
const run = (brains, ...args) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV, TILLER_BRAINS_DIR: brains } })

test('new scaffolds a client brain with git', () => {
  const b = root()
  const r = run(b, 'new', 'acme')
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['client.md', 'decisions.md', 'questions.md', 'meetings', 'recaps', 'spec', '.git']) assert.ok(existsSync(join(b, 'acme', f)), f)
})

test('new --pet omits client.md and recaps', () => {
  const b = root()
  assert.equal(run(b, 'new', 'side', '--pet').status, 0)
  assert.ok(!existsSync(join(b, 'side', 'client.md')))
  assert.ok(!existsSync(join(b, 'side', 'recaps')))
})

test('new refuses an existing brain and changes nothing', () => {
  const b = root()
  run(b, 'new', 'acme')
  writeFileSync(join(b, 'acme', 'client.md'), 'kept')
  const r = run(b, 'new', 'acme')
  assert.equal(r.status, 3)
  assert.equal(readFileSync(join(b, 'acme', 'client.md'), 'utf8'), 'kept')
})

test('a bad name is a usage error', () => {
  assert.equal(run(root(), 'new', 'Acme Corp').status, 2)
})

test('check: 0 on the valid brain, 1 with one line per violation', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  assert.equal(run(b, 'check', 'acme', '--spec', join(b, 'acme', 'spec')).status, 0)
  const p = join(b, 'acme', 'decisions.md')
  writeFileSync(p, readFileSync(p, 'utf8').replace('- Superseded by: D-003\n', ''))
  const r = run(b, 'check', 'acme')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /D-002 superseded without Superseded by/)
})

test('check --spec on a missing dir is a usage error', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  assert.equal(run(b, 'check', 'acme', '--spec', join(b, 'nope')).status, 2)
})

test('check on a missing brain is a usage error', () => {
  assert.equal(run(root(), 'check', 'ghost').status, 2)
})

test('status prints awaiting, open and readiness', () => {
  const b = root()
  cpSync(VALID, join(b, 'acme'), { recursive: true })
  const r = run(b, 'status', 'acme')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /awaiting confirmation: D-004/)
  assert.match(r.stdout, /open other: Q-002/)
  assert.match(r.stdout, /spec: ready/)
})
