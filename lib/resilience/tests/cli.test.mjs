// Exercises the three scripts as the exec lane would: spawn by absolute path, read one JSON
// stdout line, check the exit code names the same row as `status` (docs/harness.md "Script I/O").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB = join(HERE, '..')

function run(script, args) {
  const proc = spawnSync(process.execPath, [join(LIB, script), ...args], { encoding: 'utf8' })
  const lines = proc.stdout.trim().split('\n').filter(Boolean)
  return { exitCode: proc.status, lines, json: lines.length ? JSON.parse(lines[lines.length - 1]) : null, stderr: proc.stderr }
}

test('classify-failure.mjs: one stdout line, exit code matches status', () => {
  const { exitCode, lines, json } = run('classify-failure.mjs', [join(HERE, 'fixtures', 'rate-limit', '01.txt')])
  assert.equal(lines.length, 1)
  assert.equal(json.status, 'blocked')
  assert.equal(json.kind, 'rate-limit')
  assert.equal(exitCode, 3)
})

test('classify-failure.mjs: unclassified text exits 0 with status ok', () => {
  const { exitCode, json } = run('classify-failure.mjs', [join(HERE, 'fixtures', 'unclassified', '01.txt')])
  assert.equal(json.status, 'ok')
  assert.equal(exitCode, 0)
})

test('verify-claim.mjs: mismatch still exits 0 (status ok) — the mismatch is in the payload, not the exit', () => {
  const profile = join(HERE, 'fixtures', 'profiles', 'four-column.md')
  const { exitCode, json } = run('verify-claim.mjs', [profile, 'mobile', 'pass'])
  assert.equal(exitCode, 0)
  assert.equal(json.status, 'ok')
  assert.equal(json.mismatch, true)
})

test('verify-claim.mjs: no matching row exits 3 (blocked, toolchain)', () => {
  const profile = join(HERE, 'fixtures', 'profiles', 'four-column.md')
  const { exitCode, json } = run('verify-claim.mjs', [profile, 'nowhere', 'pass'])
  assert.equal(exitCode, 3)
  assert.equal(json.status, 'blocked')
  assert.equal(json.kind, 'toolchain')
})

test('with-backoff.mjs: passes a non-rate-limited script result through unchanged', () => {
  const { exitCode, json } = run('with-backoff.mjs', [join(HERE, 'bin', 'always-ok.mjs')])
  assert.equal(exitCode, 0)
  assert.equal(json.status, 'ok')
})
