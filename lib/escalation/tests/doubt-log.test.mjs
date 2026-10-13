import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'doubt-log.sh')

function profile() {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'doubt-log-')))
  writeFileSync(join(dir, 'profile.md'), '# profile\n')
  return join(dir, 'profile.md')
}

function run(args, { env = {}, input } = {}) {
  const base = { ...process.env, HOME: '/home/someone' }
  delete base.TILLER_DOUBT_LOG
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...base, ...env }, input })
  return { code: r.status, out: r.stdout.trim(), err: r.stderr }
}

const today = () => new Date().toISOString().slice(0, 10)

test('no field and no env: the log lives in the profile directory, one file per UTC day', () => {
  const p = profile()
  assert.equal(run(['resolve', '--profile', p, '--date', '2026-01-02']).out, join(dirname(p), 'doubts', '2026-01-02.md'))
  assert.equal(run(['resolve', '--profile', p]).out, join(dirname(p), 'doubts', `${today()}.md`))
})

test('the env var applies when the profile names no log', () => {
  const p = profile()
  const r = run(['resolve', '--profile', p, '--date', '2026-01-02'], { env: { TILLER_DOUBT_LOG: '~/logs/<date>.md' } })
  assert.equal(r.out, '/home/someone/logs/2026-01-02.md')
})

test('the profile field beats the env var', () => {
  const p = profile()
  const r = run(['resolve', '--profile', p, '--date', '2026-01-02', '/abs/d-<date>.md'], { env: { TILLER_DOUBT_LOG: '/env.md' } })
  assert.equal(r.out, '/abs/d-2026-01-02.md')
})

test('a relative path resolves against the profile directory, from either source', () => {
  const p = profile()
  assert.equal(run(['resolve', '--profile', p, 'notes/d.md']).out, join(dirname(p), 'notes', 'd.md'))
  assert.equal(run(['resolve', '--profile', p], { env: { TILLER_DOUBT_LOG: 'x.md' } }).out, join(dirname(p), 'x.md'))
})

test('a malformed date or a missing profile is a usage error', () => {
  assert.equal(run(['resolve', '--profile', profile(), '--date', '2026-1-2']).code, 2)
  assert.equal(run(['resolve']).code, 2)
})

test('append creates the parent directory and appends', () => {
  const p = profile()
  const log = run(['resolve', '--profile', p]).out
  assert.equal(existsSync(dirname(log)), false)
  assert.equal(run(['append', log], { input: 'first\n' }).code, 0)
  assert.equal(run(['append', log], { input: 'second\n' }).code, 0)
  assert.equal(readFileSync(log, 'utf8'), 'first\nsecond\n')
})

test('append refuses a path that was not resolved', () => {
  for (const bad of ['doubts/x.md', '~/x.md', '/abs/<date>.md']) {
    assert.equal(run(['append', bad], { input: 'x\n' }).code, 2, bad)
  }
})
