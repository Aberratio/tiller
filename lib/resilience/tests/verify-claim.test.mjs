import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verify, testToolchainRows, findCommand } from '../verify-claim.mjs'
import { check } from '../../contract/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const profiles = name => readFileSync(join(HERE, 'fixtures', 'profiles', `${name}.md`), 'utf8')

test('parses a 4-column (Lane/Runner/Command/Proof gate) table by header name, not position', () => {
  const { rows } = testToolchainRows(profiles('four-column'))
  const web = rows.find(r => r.cells[0] === 'web')
  assert.equal(web.command, 'true')
})

test('parses a differently-ordered 3-column (Repo/Level/Command) table the same way', () => {
  const { rows } = testToolchainRows(profiles('three-column'))
  const unit = rows.find(r => r.cells[0] === 'client-new')
  assert.equal(unit.command, 'true')
})

test('matches a row by an exact key in any cell, case-insensitively, never by substring', () => {
  assert.equal(findCommand(profiles('four-column'), 'WEB').command, 'true')
  assert.equal(findCommand(profiles('three-column'), 'accuracy').command, 'false')
  assert.ok(findCommand(profiles('three-column'), 'valid').error)
  assert.ok(findCommand(profiles('three-column'), 'client').error)
})

test('an org/repo slug matches the row keyed by its short name', () => {
  assert.equal(findCommand(profiles('three-column'), 'example-org/acme').command, 'true')
})

test('a matching row whose command cell is prose is skipped for the next runnable one', () => {
  assert.equal(findCommand(profiles('three-column'), 'acme').command, 'true')
})

test('a claim of "pass" that matches a passing re-run has no mismatch', () => {
  const result = verify({ profileText: profiles('four-column'), match: 'web', claim: 'pass' })
  assert.equal(result.status, 'ok')
  assert.equal(result.actual, 'pass')
  assert.equal(result.mismatch, false)
})

// The 09-16 case this script exists for: the claim says green, the re-run says otherwise.
test('a claim of "pass" against a command that actually fails is reported as a mismatch', () => {
  const result = verify({ profileText: profiles('four-column'), match: 'mobile', claim: 'pass' })
  assert.equal(result.status, 'ok')
  assert.equal(result.actual, 'fail')
  assert.equal(result.mismatch, true)
})

test('a claim that agrees with a failing re-run is not a mismatch', () => {
  const result = verify({ profileText: profiles('three-column'), match: 'accuracy', claim: 'fail' })
  assert.equal(result.mismatch, false)
})

// A command that cannot run says nothing about the claim: it is blocked, never a mismatch, so it
// cannot feed a fix round that no code change can close.
test('no matching row is blocked with a named reason, never runs an invented command', () => {
  const result = verify({ profileText: profiles('four-column'), match: 'nonexistent-lane', claim: 'pass' })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /no test toolchain row matches "nonexistent-lane"/)
  assert.equal(result.mismatch, undefined)
})

test('a table with no runnable command (template-shaped) is blocked rather than defaulting', () => {
  const result = verify({ profileText: profiles('empty-table'), match: 'lane', claim: 'pass' })
  assert.equal(result.status, 'blocked')
})

test('a prose command cell is blocked as not a command, not run under sh', () => {
  const result = verify({ profileText: profiles('three-column'), match: 'prose-repo', claim: 'pass' })
  assert.equal(result.status, 'blocked')
  assert.match(result.reason, /not a runnable command/)
})

for (const [match, code] of [['lint', 126], ['e2e', 127]]) {
  test(`a command that exits ${code} is blocked as not runnable, not a failing test`, () => {
    const result = verify({ profileText: profiles('four-column'), match, claim: 'pass' })
    assert.equal(result.status, 'blocked')
    assert.equal(result.exitCode, code)
    assert.match(result.reason, new RegExp(`exit ${code}`))
    assert.equal(result.mismatch, undefined)
  })
}

test('every verify() outcome validates against schemas/script-result.json', () => {
  const cases = [
    verify({ profileText: profiles('four-column'), match: 'web', claim: 'pass' }),
    verify({ profileText: profiles('four-column'), match: 'mobile', claim: 'pass' }),
    verify({ profileText: profiles('four-column'), match: 'nowhere', claim: 'pass' }),
    verify({ profileText: profiles('four-column'), match: 'e2e', claim: 'pass' }),
    verify({ profileText: profiles('three-column'), match: 'prose-repo', claim: 'pass' }),
  ]
  const kindsJson = JSON.parse(readFileSync(join(HERE, '..', '..', 'contract', 'kinds.json'), 'utf8'))
  for (const result of cases) {
    const exit = result.kind ? kindsJson.kinds[result.kind].exit : kindsJson.statuses[result.status]
    assert.deepEqual(check('script-result', result, exit), [], JSON.stringify(result))
  }
})

const STATIC = '## test toolchain\n\n| Repo | Level | Command |\n|---|---|---|\n| `app` | unit | `true` |\n\n' +
  '## static checks\n\n| Repo | Check | Command |\n|---|---|---|\n| `app` | typecheck | `true` |\n| `app` | lint | `exit 1` |\n| `app` | format | n/a |\n'

test('--section static checks reads that table, not the test toolchain', () => {
  assert.equal(verify({ profileText: STATIC, match: 'typecheck', claim: 'pass', section: 'static checks' }).actual, 'pass')
  const lint = verify({ profileText: STATIC, match: 'lint', claim: 'pass', section: 'static checks' })
  assert.equal(lint.actual, 'fail')
  assert.equal(lint.mismatch, true)
  assert.ok(findCommand(STATIC, 'unit', 'static checks').error, 'a toolchain row is not a static check')
})

test('a static check that cannot run is blocked with kind toolchain', () => {
  const r = verify({ profileText: STATIC, match: 'format', claim: 'pass', section: 'static checks' })
  assert.equal(r.status, 'blocked')
  assert.equal(r.kind, 'toolchain')
  assert.match(r.reason, /static checks/)
})

test('--expect-sha: the claim is re-run only on the expected, clean head', async () => {
  const { mkdtempSync, writeFileSync: write } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const repo = mkdtempSync(join(tmpdir(), 'verify-claim-head-'))
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t.invalid'); g('config', 'user.name', 't')
  write(join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'a')
  const head = g('rev-parse', 'HEAD').stdout.trim()
  const base = { profileText: STATIC, match: 'app', claim: 'pass', cwd: repo }

  assert.equal(verify({ ...base, expectSha: head }).status, 'ok')
  const other = verify({ ...base, expectSha: 'deadbeefdeadbeef' })
  assert.equal(other.status, 'blocked')
  assert.equal(other.kind, 'toolchain')
  assert.equal(other.mismatch, undefined, 'never a mismatch, so never a fix round')
  assert.match(other.reason, new RegExp(head))
  write(join(repo, 'b.txt'), 'b\n')
  const dirty = verify({ ...base, expectSha: head })
  assert.equal(dirty.status, 'blocked')
  assert.match(dirty.reason, /b\.txt/)
  const kindsJson = JSON.parse(readFileSync(join(HERE, '..', '..', 'contract', 'kinds.json'), 'utf8'))
  for (const r of [other, dirty]) assert.deepEqual(check('script-result', r, kindsJson.kinds[r.kind].exit), [], JSON.stringify(r))
})
