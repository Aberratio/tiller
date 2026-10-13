import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const TILLER = join(REPO, 'bin', 'tiller.mjs')

// A synthetic machine: its own HOME, state dir and PATH of stub tools. Nothing points at the real home.
function machine({ tools = { jq: 'jq-1.7.1', gh: 'gh version 2.62.0' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tiller-cli-'))
  const home = join(root, 'home'), state = join(root, 'state'), bin = join(root, 'bin')
  for (const d of [home, bin]) mkdirSync(d, { recursive: true })
  for (const [name, out] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${out}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    PATH: [bin, dirname(process.execPath), '/bin'].join(':'),
    HOME: home, USERPROFILE: home, TILLER_STATE_HOME: state, TILLER_PERSONAL_ROOT: join(root, 'personal'),
  }
  assert.notEqual(env.HOME, homedir())
  return { root, home, state, env }
}

function tiller(args, m, cmd = [TILLER]) {
  const [exe, ...pre] = cmd.length === 1 ? [process.execPath, ...cmd] : cmd
  return spawnSync(exe, [...pre, ...args], { encoding: 'utf8', env: m.env, cwd: m.root })
}

const tree = dir => { try { return readdirSync(dir, { recursive: true }).sort() } catch { return null } }

test('doctor lists every feature in table order and writes nothing', () => {
  const m = machine()
  const before = [tree(m.home), tree(m.state)]
  const r = tiller(['doctor'], m)
  assert.equal(r.status, 0, r.stderr)
  const labels = r.stdout.trim().split('\n').map(l => l.replace(/^(ready|degraded|unavailable)\s+/, '').split(' - ')[0])
  assert.deepEqual(labels, ['Skills', 'Harness role agents', 'Private-access hook', 'Profile resolution in skills', 'Unattended runs', 'Pull requests'])
  assert.deepEqual([tree(m.home), tree(m.state)], before)
})

test('doctor names a missing tool with its install command', () => {
  const m = machine({ tools: { gh: 'gh version 2.62.0' } })
  const r = tiller(['doctor'], m)
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find(l => l.includes('Private-access hook'))
  assert.match(line, /^unavailable/)
  assert.match(line, /needs jq/)
  assert.match(line, process.platform === 'darwin' ? /brew install jq/ : /apt install jq/)
})

test('doctor --json carries the probe and the features', () => {
  const m = machine()
  const r = tiller(['doctor', '--json'], m)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.probe.platform, process.platform)
  assert.equal(out.probe.tools.jq.version, '1.7.1')
  assert.equal(out.features.length, 6)
})

test('an unknown command exits 2 with usage', () => {
  const r = tiller(['frobnicate'], machine())
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: tiller/i)
})

test('commands of later delivery steps say they are not available yet', () => {
  for (const cmd of ['onboard', 'status', 'uninstall']) {
    const r = tiller([cmd], machine())
    assert.equal(r.status, 2, cmd)
    assert.match(r.stderr, /not available yet/)
  }
})

test('the POSIX shim works through a symlink on PATH', () => {
  const m = machine()
  const link = join(m.root, 'bin', 'tiller')
  symlinkSync(join(REPO, 'bin', 'tiller'), link)
  const env = { ...m.env, PATH: `${m.env.PATH}:/usr/bin` }
  const r = spawnSync('sh', ['-c', 'tiller doctor'], { encoding: 'utf8', env, cwd: m.root })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Skills/)
})

// --- apply -------------------------------------------------------------------------------------

// CLAUDE_CONFIG_DIR and COPILOT_HOME are absent from machine().env, so the default dirs under the
// synthetic HOME are used.
function claudeMachine({ settings, personal } = {}) {
  const m = machine()
  assert.equal(m.env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(m.env.COPILOT_HOME, undefined)
  m.claude = join(m.home, '.claude')
  mkdirSync(m.claude)
  if (settings !== undefined) writeFileSync(join(m.claude, 'settings.json'), settings)
  if (personal) {
    m.personal = join(m.root, 'personal', 'sam')
    mkdirSync(m.personal, { recursive: true })
    for (const [f, text] of Object.entries(personal)) writeFileSync(join(m.personal, f), text)
  }
  return m
}

const settingsOf = m => JSON.parse(readFileSync(join(m.claude, 'settings.json'), 'utf8'))
const ownedOf = m => JSON.parse(readFileSync(join(m.state, 'owned.json'), 'utf8'))
const mtime = f => statSync(f).mtimeMs

test('apply --yes on an empty config dir writes settings.json and CLAUDE.md and records ownership', () => {
  const m = claudeMachine()
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  const s = settingsOf(m)
  assert.equal(s.env.TILLER_HOME, REPO)
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /^TILLER_HOOK=private-access '.*private-access\.sh'$/)
  assert.match(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), /<!-- tiller:begin -->/)
  const owned = ownedOf(m)
  assert.deepEqual(Object.keys(owned.files[join(m.claude, 'settings.json')].items), ['/env/TILLER_HOME', 'hook:PreToolUse:private-access'])
  assert.deepEqual(Object.keys(owned.files[join(m.claude, 'CLAUDE.md')].items), ['block'])
  assert.equal(tree(join(m.state, 'backups')), null, 'no backup for files that did not exist')
  assert.ok(JSON.parse(readFileSync(join(m.state, 'machine.json'), 'utf8')).probe)
})

test('apply backs up only the files that existed', () => {
  const m = claudeMachine({ settings: '{\n  "model": "x"\n}\n' })
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  const backups = tree(join(m.state, 'backups')).filter(f => /\.(json|md)$/.test(f))
  assert.equal(backups.length, 1)
  assert.match(backups[0], /settings\.json$/)
  assert.equal(readFileSync(join(m.state, 'backups', backups[0]), 'utf8'), '{\n  "model": "x"\n}\n')
  assert.equal(settingsOf(m).model, 'x')
})

test('a second apply --yes is unchanged and touches nothing', () => {
  const m = claudeMachine({ settings: '{}\n' })
  assert.equal(tiller(['apply', '--yes'], m).status, 0)
  const files = [join(m.claude, 'settings.json'), join(m.claude, 'CLAUDE.md')]
  const before = { owned: readFileSync(join(m.state, 'owned.json'), 'utf8'), backups: tree(join(m.state, 'backups')), mtimes: files.map(mtime) }
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /unchanged/)
  assert.equal(readFileSync(join(m.state, 'owned.json'), 'utf8'), before.owned)
  assert.deepEqual(tree(join(m.state, 'backups')), before.backups)
  assert.deepEqual(files.map(mtime), before.mtimes)
})

test('apply without a terminal and without --yes refuses and writes nothing', () => {
  const m = claudeMachine()
  const r = tiller(['apply'], m)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /--yes/)
  assert.deepEqual(tree(m.claude), [])
  assert.equal(tree(m.state), null)
})

test('apply --dry-run prints the diff and writes nothing, not even machine.json', () => {
  const m = claudeMachine()
  const r = tiller(['apply', '--dry-run'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\+ \/env\/TILLER_HOME = /)
  assert.match(r.stdout, /\+ hook:PreToolUse:private-access/)
  assert.deepEqual(tree(m.claude), [])
  assert.equal(tree(m.state), null)
})

test('invalid settings.json refuses the apply and CLAUDE.md is not written either', () => {
  const m = claudeMachine({ settings: '{"env": ' })
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /settings\.json/)
  assert.deepEqual(tree(m.claude), ['settings.json'])
  assert.equal(readFileSync(join(m.claude, 'settings.json'), 'utf8'), '{"env": ')
})

test('apply warns about a hand-merged private-access hook and leaves it in place', () => {
  const legacy = { matcher: 'Read', hooks: [{ type: 'command', command: 'TILLER_HOME=/x /x/lib/hooks/private-access.sh' }] }
  const m = claudeMachine({ settings: JSON.stringify({ hooks: { PreToolUse: [legacy] } }) })
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout + r.stderr, /run twice/)
  assert.deepEqual(settingsOf(m).hooks.PreToolUse[0], legacy)
})

test('apply --agents copilot says it is not supported yet', () => {
  const r = tiller(['apply', '--yes', '--agents', 'copilot'], claudeMachine())
  assert.equal(r.status, 3)
  assert.match(r.stderr, /copilot.*not supported yet/)
})

function editedMachine() {
  const m = claudeMachine({ personal: { 'harness.json': '{}\n' } })
  assert.equal(tiller(['apply', '--yes'], m).status, 0)
  const s = settingsOf(m)
  s.env.TILLER_HOME = '/by/hand'
  writeFileSync(join(m.claude, 'settings.json'), JSON.stringify(s, null, 2) + '\n')
  return m
}

test('an edited owned key without a terminal refuses, naming the pointer', () => {
  const m = editedMachine()
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /\/env\/TILLER_HOME/)
  assert.equal(settingsOf(m).env.TILLER_HOME, '/by/hand')
})

async function applyWith(m, answer) {
  const { main } = await import('../../bin/tiller.mjs')
  const out = [], asked = []
  const code = main(['apply', '--yes', '--user', 'sam'], {
    env: m.env, home: m.home, isTTY: true,
    stdout: s => out.push(s), stderr: s => out.push(s),
    prompt: q => { asked.push(q); return answer },
  })
  return { code, out: out.join(''), asked }
}

test('drift resolved by overwrite restores the desired value', async () => {
  const m = editedMachine()
  const r = await applyWith(m, 'o')
  assert.equal(r.code, 0, r.out)
  assert.equal(r.asked.length, 1)
  assert.match(r.asked[0], /\/env\/TILLER_HOME/)
  assert.equal(settingsOf(m).env.TILLER_HOME, REPO)
})

test('drift resolved by release keeps the edit and drops ownership for good', async () => {
  const m = editedMachine()
  const r = await applyWith(m, 'r')
  assert.equal(r.code, 0, r.out)
  assert.equal(settingsOf(m).env.TILLER_HOME, '/by/hand')
  const owned = ownedOf(m)
  const file = join(m.claude, 'settings.json')
  assert.equal(owned.files[file].items['/env/TILLER_HOME'], undefined)
  assert.deepEqual(owned.released[file], ['/env/TILLER_HOME'])
  const again = tiller(['apply', '--yes'], m)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
})

test('drift resolved by adopt writes the value into the personal layer', async () => {
  const m = editedMachine()
  const r = await applyWith(m, 'a')
  assert.equal(r.code, 0, r.out)
  assert.equal(settingsOf(m).env.TILLER_HOME, '/by/hand')
  assert.equal(JSON.parse(readFileSync(join(m.personal, 'harness.json'), 'utf8')).env.TILLER_HOME, '/by/hand')
  const again = tiller(['apply', '--yes', '--user', 'sam'], m)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
})
