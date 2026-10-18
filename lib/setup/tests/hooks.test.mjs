// The hook step (`tiller hooks`): the fragment `install.sh --hooks` prints, merged into the agent
// settings. The fragment itself is the expected value; the hooks' own behaviour has its own suite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env, out, REPO, run, sandbox, snapshot } from './sandbox.mjs'

const fragment = sb => {
  const r = spawnSync('bash', [join(REPO, 'install.sh'), '--hooks'], { encoding: 'utf8', env: env(sb) })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout).hooks
}
const settings = sb => JSON.parse(readFileSync(sb.settings, 'utf8'))
const commands = (s, ev) => (s.hooks?.[ev] || []).flatMap(g => g.hooks.map(h => h.command))
const write = (sb, value) => {
  mkdirSync(dirname(sb.settings), { recursive: true })
  writeFileSync(sb.settings, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
const mine = (f, ev) => f[ev][0].hooks[0].command

test('no settings file: both entries written as the fragment has them, and a restart is asked for', () => {
  const sb = sandbox()
  const f = fragment(sb)
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(settings(sb).hooks, f)
  assert.match(r.stdout, /restart/i)
})

test('other keys and other hooks are kept; ours is appended after them', () => {
  const sb = sandbox()
  const f = fragment(sb)
  const lint = { matcher: 'Edit', hooks: [{ type: 'command', command: '/usr/local/bin/lint-hook' }] }
  write(sb, { model: 'opus', env: { A: '1' }, hooks: { PreToolUse: [lint], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 0, out(r))
  const s = settings(sb)
  assert.equal(s.model, 'opus')
  assert.deepEqual(s.env, { A: '1' })
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }])
  assert.deepEqual(s.hooks.PreToolUse, [lint, ...f.PreToolUse])
  assert.deepEqual(s.hooks.SessionStart, f.SessionStart)
})

test("another checkout's hooks are replaced, the replacement is printed, a neighbour in the same group stays", () => {
  const sb = sandbox()
  const f = fragment(sb)
  const old = 'TILLER_HOME=/old/tiller /old/tiller/lib/hooks/private-access.sh'
  const oldSession = f.SessionStart[0].hooks[0].command.replaceAll(REPO.replaceAll(' ', '\\ '), '/old/tiller')
  write(sb, { hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: old }, { type: 'command', command: 'audit' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: oldSession }] }],
  } })
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 0, out(r))
  const s = settings(sb)
  assert.deepEqual(commands(s, 'PreToolUse'), ['audit', mine(f, 'PreToolUse')])
  assert.deepEqual(commands(s, 'SessionStart'), [mine(f, 'SessionStart')])
  assert.ok(r.stdout.includes(`replaced: ${old}`), out(r))
  assert.ok(r.stdout.includes(`replaced: ${oldSession}`), out(r))
})

test('invalid JSON stops the step naming the file and leaves it as it was', () => {
  const sb = sandbox()
  write(sb, '{ "hooks": ')
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 1, out(r))
  assert.ok(r.stderr.includes(sb.settings), out(r))
  assert.match(r.stderr, /resume: +tiller hooks$/m)
  assert.equal(readFileSync(sb.settings, 'utf8'), '{ "hooks": ')
})

test('a second run is one ok line and changes no file', () => {
  const sb = sandbox()
  assert.equal(run(sb, ['hooks']).status, 0)
  const before = snapshot(sb)
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +hook\b/m)
  assert.deepEqual(snapshot(sb), before)
})

test('Codex on PATH: the step says once that Codex has no hook; without it, Codex is not mentioned', () => {
  const sb = sandbox({ stubs: { codex: '' } })
  const r = run(sb, ['hooks'])
  assert.equal(r.status, 0, out(r))
  assert.equal(out(r).match(/Codex has no hook/g)?.length, 1, out(r))
  const plain = sandbox()
  assert.doesNotMatch(out(run(plain, ['hooks'])), /codex/i)
})
