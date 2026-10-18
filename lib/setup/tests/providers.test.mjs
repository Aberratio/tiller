// The providers step (`tiller login`): which provider, its CLI, its skills, its sign-in. The CLIs are
// stubs whose sign-in state is a file in the sandbox; real sign-in is the owner's hand-off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { calls, out, REPO, run, sandbox, snapshot, stub as writeStub } from './sandbox.mjs'

// `claude auth status` answers from a file, `claude auth login` creates it.
const claude = (sb, { login = true } = {}) => `f="${sb.root}/claude-in"
case "$1 $2" in
  "auth status") if [ -e "$f" ]; then echo '{"loggedIn": true}'; else echo '{"loggedIn": false}'; exit 1; fi ;;
  "auth login") ${login ? 'touch "$f"' : 'exit 1'} ;;
esac`
const codex = sb => `f="${sb.root}/codex-in"
case "$1 $2" in
  "login status") [ -e "$f" ] ;;
  "login ") touch "$f" ;;
esac`

function box({ have = ['claude'], loggedIn = [], claudeLogin = true } = {}) {
  const sb = sandbox({ stubs: { brew: '', gh: '' } })
  const bodies = { claude: claude(sb, { login: claudeLogin }), codex: codex(sb) }
  for (const p of have) writeStub(sb, p, bodies[p])
  for (const p of loggedIn) writeFileSync(join(sb.root, `${p}-in`), '')
  // The installers. Claude's script lands the CLI in ~/.local/bin, which a fresh shell may not have
  // on PATH; npm puts codex on PATH.
  for (const p of ['claude', 'codex']) writeFileSync(join(sb.root, `${p}.cli`), `#!/bin/bash\necho "${p} $*" >> "${sb.log}"\n${bodies[p]}\n`)
  writeStub(sb, 'curl', `echo 'mkdir -p "$HOME/.local/bin" && cp "${sb.root}/claude.cli" "$HOME/.local/bin/claude" && chmod +x "$HOME/.local/bin/claude"'`)
  writeStub(sb, 'npm', `[ "$*" = "install -g @openai/codex" ] && cp "${sb.root}/codex.cli" "${sb.bin}/codex" && chmod +x "${sb.bin}/codex"`)
  return sb
}

const linked = (dir, skill = 'flow-tdd') => existsSync(join(dir, skill)) && lstatSync(join(dir, skill)).isSymbolicLink() && realpathSync(join(dir, skill)) === realpathSync(join(REPO, 'skills', skill))

test('claude on PATH, not linked, signed out: skills linked, TILLER_HOME written, sign-in run', () => {
  const sb = box()
  const r = run(sb, ['login'], { answers: { providers: { use: ['claude'] } } })
  assert.equal(r.status, 0, out(r))
  assert.ok(linked(sb.skills))
  assert.equal(JSON.parse(readFileSync(sb.settings, 'utf8')).env.TILLER_HOME, REPO)
  assert.deepEqual(calls(sb).filter(c => c.startsWith('claude')), ['claude auth status', 'claude auth login', 'claude auth status'])
  assert.ok(!existsSync(sb.codex), 'codex was not chosen')
})

test('the default is every provider CLI already on PATH', () => {
  const sb = box({ have: ['claude', 'codex'] })
  const r = run(sb, ['login', '--yes'])
  assert.equal(r.status, 0, out(r))
  assert.ok(linked(sb.skills))
  assert.ok(linked(sb.codexSkills))
  assert.match(readFileSync(sb.codex, 'utf8'), /^TILLER_HOME = /m)
  assert.ok(calls(sb).includes('codex login'))
})

test('with no provider CLI on PATH the default is Claude Code, installed with its own installer', () => {
  const sb = box({ have: [] })
  const r = run(sb, ['login', '--yes'])
  assert.equal(r.status, 0, out(r))
  assert.equal(calls(sb)[0], 'curl -fsSL https://claude.ai/install.sh')
  assert.ok(linked(sb.skills))
  assert.ok(calls(sb).includes('claude auth login'))
  assert.ok(!calls(sb).some(c => c.startsWith('npm')))
})

test('codex chosen and absent: installed through npm, linked, signed in', () => {
  const sb = box({ have: ['claude'], loggedIn: ['claude'] })
  const r = run(sb, ['login'], { answers: { providers: { use: ['codex'] } } })
  assert.equal(r.status, 0, out(r))
  assert.ok(calls(sb).includes('npm install -g @openai/codex'))
  assert.ok(linked(sb.codexSkills))
  assert.ok(!existsSync(sb.skills), 'claude was not chosen this time')
  assert.deepEqual(calls(sb).filter(c => c.startsWith('codex')), ['codex login status', 'codex login', 'codex login status'])
})

test('`tiller login codex` names the provider; no question, claude untouched', () => {
  const sb = box({ have: ['claude', 'codex'] })
  const r = run(sb, ['login', 'codex'])
  assert.equal(r.status, 0, out(r))
  assert.ok(linked(sb.codexSkills))
  assert.ok(!calls(sb).some(c => c.startsWith('claude')))
})

test('a sign-in that does not take stops with the command that repeats it', () => {
  const sb = box({ claudeLogin: false })
  const r = run(sb, ['login', 'claude'])
  assert.equal(r.status, 1, out(r))
  assert.match(r.stderr, /signing in to claude failed/)
  assert.match(r.stderr, /resume: +tiller login claude$/m)
})

// Each part of a finished link, taken away on its own, is put back by the next run.
const undo = {
  'a skill link': sb => rmSync(join(sb.skills, 'flow-tdd')),
  'TILLER_HOME in the settings': sb => writeFileSync(sb.settings, JSON.stringify({ env: {} })),
  'the rc PATH line': sb => writeFileSync(sb.rc, readFileSync(sb.rc, 'utf8').replace(/^export PATH=.*# tiller\n/m, '')),
}
for (const [part, take] of Object.entries(undo)) {
  test(`linked and signed in, then ${part} removed: the next run links again`, () => {
    const sb = box({ loggedIn: ['claude'] })
    assert.equal(run(sb, ['login', 'claude']).status, 0)
    const before = snapshot(sb)
    take(sb)
    const r = run(sb, ['login', 'claude'])
    assert.equal(r.status, 0, out(r))
    assert.match(r.stdout, /^done +providers\b/m)
    assert.deepEqual(snapshot(sb), before)
  })
}

test('a CLI without a status command: the login runs, and its exit 0 counts as signed in', () => {
  const sb = box({ have: [] })
  writeStub(sb, 'claude', 'case "$1 $2" in "auth status") echo "unknown command" >&2; exit 2 ;; esac; exit 0')
  const r = run(sb, ['login', 'claude'])
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(calls(sb).filter(c => c.startsWith('claude')), ['claude auth status', 'claude auth login'])
})

test('no provider named, none on PATH, no terminal: the choice is exit 4', () => {
  const sb = box({ have: [] })
  const r = run(sb, ['login'])
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /providers\.use/)
  assert.deepEqual(calls(sb), [])
})

test('linked and signed in: one ok line, only the status is asked, no file changes', () => {
  const sb = box({ loggedIn: ['claude'] })
  assert.equal(run(sb, ['login', 'claude']).status, 0)
  const before = snapshot(sb)
  const r = run(sb, ['login'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +providers\b/m)
  assert.deepEqual(snapshot(sb), before)
  assert.ok(!calls(sb).slice(-2).includes('claude auth login'))
})

test('an unknown provider is a usage error', () => {
  const sb = box()
  const r = run(sb, ['login', 'gemini'])
  assert.equal(r.status, 2, out(r))
})
