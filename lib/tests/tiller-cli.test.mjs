import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
  for (const cmd of ['onboard', 'uninstall']) {
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

function copilotMachine({ settings, personal } = {}) {
  const m = claudeMachine({ personal })
  m.copilot = join(m.home, '.copilot')
  mkdirSync(m.copilot)
  if (settings !== undefined) writeFileSync(join(m.copilot, 'settings.json'), settings)
  return m
}

const copilotHooksOf = m => JSON.parse(readFileSync(join(m.copilot, 'hooks', 'tiller.json'), 'utf8'))

test('apply --agents copilot writes the hooks file and instructions block and prints the shell line', () => {
  const m = copilotMachine()
  const r = tiller(['apply', '--yes', '--agents', 'copilot'], m)
  assert.equal(r.status, 0, r.stderr)
  const hooks = copilotHooksOf(m)
  assert.equal(hooks.version, 1)
  assert.match(hooks.hooks.PreToolUse[0].bash, /copilot-pretooluse\.sh' '.*private-access\.sh'$/)
  assert.equal(hooks.hooks.PreToolUse[0].env.TILLER_HOME, REPO)
  assert.match(readFileSync(join(m.copilot, 'copilot-instructions.md'), 'utf8'), /<!-- tiller:begin -->/)
  assert.equal(tree(m.copilot).includes('settings.json'), false, 'no native copilot settings, no settings.json')
  assert.equal(tree(m.claude).length, 0, 'claude was not asked for')
  const owned = ownedOf(m)
  assert.deepEqual(Object.keys(owned.files[join(m.copilot, 'hooks', 'tiller.json')].items), ['/version', '/hooks/PreToolUse'])
  assert.equal(owned.files[join(m.copilot, 'hooks', 'tiller.json')].agent, 'copilot')
  assert.match(r.stdout, new RegExp(`export TILLER_HOME='${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`))
  const again = tiller(['apply', '--yes', '--agents', 'copilot'], m)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
})

test('apply without --agents applies every detected agent, copilot included', () => {
  const m = copilotMachine()
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /not supported/)
  assert.ok(settingsOf(m).env.TILLER_HOME)
  assert.equal(copilotHooksOf(m).version, 1)
})

test('copilot settings.json keeps the comments of the user around owned keys', () => {
  const settings = '{\n  // mine\n  "model": "x"\n}\n'
  const m = copilotMachine({ settings, personal: { 'harness.json': '{ "native": { "copilot": { "stayInAutopilot": false } } }\n' } })
  const r = tiller(['apply', '--yes', '--agents', 'copilot', '--user', 'sam'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(m.copilot, 'settings.json'), 'utf8'), '{\n  // mine\n  "model": "x",\n  "stayInAutopilot": false\n}\n')
  assert.deepEqual(Object.keys(ownedOf(m).files[join(m.copilot, 'settings.json')].items), ['/stayInAutopilot'])
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

async function applyCopilotWith(m, answer) {
  const { main } = await import('../../bin/tiller.mjs')
  const out = [], asked = []
  const code = main(['apply', '--yes', '--agents', 'copilot', '--user', 'sam'], {
    env: m.env, home: m.home, isTTY: true,
    stdout: s => out.push(s), stderr: s => out.push(s),
    prompt: q => { asked.push(q); return answer },
  })
  return { code, out: out.join(''), asked }
}

test('drift in the copilot hooks file offers no adopt', async () => {
  const m = copilotMachine({ personal: { 'harness.json': '{}\n' } })
  assert.equal(tiller(['apply', '--yes', '--agents', 'copilot'], m).status, 0)
  const file = join(m.copilot, 'hooks', 'tiller.json')
  writeFileSync(file, JSON.stringify({ ...copilotHooksOf(m), version: 2 }, null, 2) + '\n')
  const r = await applyCopilotWith(m, 'a')
  assert.notEqual(r.code, 0)
  assert.ok(r.asked.length > 0)
  for (const q of r.asked) assert.doesNotMatch(q, /adopt/)
  assert.equal(copilotHooksOf(m).version, 2)
})

test('adopting a drifted copilot setting writes it under native.copilot', async () => {
  const m = copilotMachine({ personal: { 'harness.json': '{ "native": { "copilot": { "stayInAutopilot": false } } }\n' } })
  assert.equal(tiller(['apply', '--yes', '--agents', 'copilot', '--user', 'sam'], m).status, 0)
  const file = join(m.copilot, 'settings.json')
  writeFileSync(file, readFileSync(file, 'utf8').replace('false', 'true'))
  const r = await applyCopilotWith(m, 'a')
  assert.equal(r.code, 0, r.out)
  const layer = JSON.parse(readFileSync(join(m.personal, 'harness.json'), 'utf8'))
  assert.deepEqual(layer.native, { copilot: { stayInAutopilot: true } })
  const again = tiller(['apply', '--yes', '--agents', 'copilot', '--user', 'sam'], m)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
})

// Answers by question: each rule is [regex, answer]; the first matching rule answers.
async function applyAnswering(m, args, rules) {
  const { main } = await import('../../bin/tiller.mjs')
  const out = [], asked = []
  const code = main(['apply', ...args], {
    env: m.env, home: m.home, isTTY: true,
    stdout: s => out.push(s), stderr: s => out.push(s),
    prompt: q => { asked.push(q); return rules.find(([re]) => re.test(q))?.[1] ?? null },
  })
  return { code, out: out.join(''), asked }
}

const FIRST = /\[m\]erge \/ \[s\]kip \/ \[q\]uit/

test('an existing file tiller never managed is asked about: merge one, skip the other', async () => {
  const m = claudeMachine({ settings: '{\n  "model": "x"\n}\n' })
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# mine\n')
  const r = await applyAnswering(m, ['--agents', 'claude'], [[/settings\.json.*\[m\]erge/s, 'm'], [/CLAUDE\.md.*\[m\]erge/s, 's'], [/Apply these/, 'y']])
  assert.equal(r.code, 0, r.out)
  assert.equal(r.asked.filter(q => FIRST.test(q)).length, 2)
  assert.equal(settingsOf(m).model, 'x')
  assert.ok(settingsOf(m).env.TILLER_HOME)
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# mine\n')
  const owned = ownedOf(m)
  assert.ok(owned.files[join(m.claude, 'settings.json')])
  assert.equal(owned.files[join(m.claude, 'CLAUDE.md')], undefined, 'a skipped file is not recorded, so it is asked again')
  const again = await applyAnswering(m, ['--agents', 'claude'], [[FIRST, 's']])
  assert.equal(again.asked.filter(q => FIRST.test(q)).length, 1)
  assert.match(again.asked.find(q => FIRST.test(q)), /CLAUDE\.md/)
})

test('quit at an existing file writes nothing', async () => {
  const m = claudeMachine({ settings: '{}\n' })
  const r = await applyAnswering(m, ['--agents', 'claude'], [[FIRST, 'q']])
  assert.equal(r.code, 3)
  assert.equal(readFileSync(join(m.claude, 'settings.json'), 'utf8'), '{}\n')
  assert.deepEqual(tree(m.claude), ['settings.json'])
  assert.equal(tree(m.state), null)
})

test('no question for a file already in the manifest or an existing file with nothing to write', async () => {
  const m = copilotMachine({ settings: '{ "model": "x" }\n' })
  assert.equal(tiller(['apply', '--yes', '--agents', 'claude'], m).status, 0)
  const r = await applyAnswering(m, [], [[FIRST, 'q'], [/Apply these/, 'y']])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(r.asked.filter(q => FIRST.test(q)), [])
})

test('--yes merges into an existing file and names it with its backup', () => {
  const m = claudeMachine({ settings: '{\n  "model": "x"\n}\n' })
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find(l => l.startsWith('merged into existing'))
  assert.ok(line, r.stdout)
  assert.ok(line.includes(join(m.claude, 'settings.json')))
  assert.match(line, /backup .*settings\.json/)
})

test('an unparseable file in a terminal can be skipped while the rest is applied', async () => {
  const m = copilotMachine({ settings: '{ "model": "x", }\n' })
  const r = await applyAnswering(m, ['--agents', 'copilot'], [[/\[s\]kip this file \/ \[q\]uit/, 's'], [/Apply these/, 'y']])
  assert.equal(r.code, 0, r.out)
  assert.equal(readFileSync(join(m.copilot, 'settings.json'), 'utf8'), '{ "model": "x", }\n')
  assert.equal(copilotHooksOf(m).version, 1)
  assert.equal(ownedOf(m).files[join(m.copilot, 'settings.json')], undefined)
})

test('an unparseable file in a terminal: quit writes nothing', async () => {
  const m = copilotMachine({ settings: '{ "model": "x", }\n' })
  const r = await applyAnswering(m, ['--agents', 'copilot'], [[/\[s\]kip this file/, 'q']])
  assert.equal(r.code, 3)
  assert.deepEqual(tree(m.copilot), ['settings.json'])
})

const LEGACY = { matcher: 'Read', hooks: [{ type: 'command', command: 'TILLER_HOME=/x /x/lib/hooks/private-access.sh' }] }

test('in a terminal the hand-merged private-access hook can be removed, with a backup', async () => {
  const original = JSON.stringify({ hooks: { PreToolUse: [LEGACY, { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } }, null, 2) + '\n'
  const m = claudeMachine({ settings: original })
  const r = await applyAnswering(m, ['--agents', 'claude'], [[FIRST, 'm'], [/remove the hand-merged/, 'y'], [/Apply these/, 'y']])
  assert.equal(r.code, 0, r.out)
  const groups = settingsOf(m).hooks.PreToolUse
  assert.equal(groups.some(g => g.hooks.some(h => h.command === LEGACY.hooks[0].command)), false)
  assert.ok(groups.some(g => g.hooks.some(h => h.command === 'echo hi')), 'other user hooks stay')
  assert.ok(groups.some(g => g.hooks.some(h => h.command.startsWith('TILLER_HOOK=private-access '))))
  const backup = tree(join(m.state, 'backups')).find(f => f.endsWith('settings.json'))
  assert.equal(readFileSync(join(m.state, 'backups', backup), 'utf8'), original)
})

test('in a terminal, declining keeps the hand-merged hook', async () => {
  const m = claudeMachine({ settings: JSON.stringify({ hooks: { PreToolUse: [LEGACY] } }) })
  const r = await applyAnswering(m, ['--agents', 'claude'], [[FIRST, 'm'], [/remove the hand-merged/, 'n'], [/Apply these/, 'y']])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(settingsOf(m).hooks.PreToolUse[0], LEGACY)
})

const SKILLS = readdirSync(join(REPO, 'skills')).filter(n => existsSync(join(REPO, 'skills', n, 'SKILL.md'))).sort()
const ROLES = ['flow-resolver', 'flow-owner-proxy', 'flow-pm']
const linkOf = p => (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(p) : null)

test('apply links every skill and writes the role agents for each agent, then changes nothing', () => {
  const m = copilotMachine()
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  for (const s of SKILLS) {
    assert.equal(linkOf(join(m.claude, 'skills', s)), join(REPO, 'skills', s), s)
    assert.equal(linkOf(join(m.home, '.agents', 'skills', s)), join(REPO, 'skills', s), s)
  }
  for (const a of ROLES) {
    assert.match(readFileSync(join(m.claude, 'agents', `${a}.md`), 'utf8'), new RegExp(`^---\\nname: ${a}\\n`))
    assert.match(readFileSync(join(m.copilot, 'agents', `${a}.agent.md`), 'utf8'), new RegExp(`^---\\nname: ${a}\\n`))
  }
  const links = ownedOf(m).links
  assert.deepEqual(links[join(m.claude, 'skills', SKILLS[0])], { agent: 'claude', kind: 'skill', mode: 'symlink', source: join(REPO, 'skills', SKILLS[0]) })
  assert.equal(links[join(m.copilot, 'agents', 'flow-pm.agent.md')].mode, 'rendered')
  assert.match(links[join(m.copilot, 'agents', 'flow-pm.agent.md')].hash, /^[0-9a-f]{64}$/)
  assert.equal(Object.keys(links).length, 2 * (SKILLS.length + ROLES.length))
  const owned = readFileSync(join(m.state, 'owned.json'), 'utf8')
  const again = tiller(['apply', '--yes'], m)
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /unchanged/)
  assert.equal(readFileSync(join(m.state, 'owned.json'), 'utf8'), owned)
})

test('apply --dry-run lists the links and writes none', () => {
  const m = claudeMachine()
  const r = tiller(['apply', '--dry-run'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`\\+ skill ${SKILLS[0]}`))
  assert.match(r.stdout, /\+ agent flow-pm/)
  assert.deepEqual(tree(m.claude), [])
})

test('a skill dir or agent file that is not tiller\'s is reported and left alone', () => {
  const m = claudeMachine()
  mkdirSync(join(m.claude, 'skills', SKILLS[0]), { recursive: true })
  writeFileSync(join(m.claude, 'skills', SKILLS[0], 'SKILL.md'), 'mine\n')
  mkdirSync(join(m.claude, 'agents'))
  writeFileSync(join(m.claude, 'agents', 'flow-pm.md'), 'my own flow-pm\n')
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, new RegExp(`skipped: ${join(m.claude, 'skills', SKILLS[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(r.stdout, /skipped: .*flow-pm\.md/)
  assert.equal(readFileSync(join(m.claude, 'skills', SKILLS[0], 'SKILL.md'), 'utf8'), 'mine\n')
  assert.equal(readFileSync(join(m.claude, 'agents', 'flow-pm.md'), 'utf8'), 'my own flow-pm\n')
  const links = ownedOf(m).links
  assert.equal(links[join(m.claude, 'skills', SKILLS[0])], undefined)
  assert.equal(links[join(m.claude, 'agents', 'flow-pm.md')], undefined)
})

test('an agent file written by install.sh --agents is taken over and refreshed', () => {
  const m = claudeMachine()
  mkdirSync(join(m.claude, 'agents'))
  writeFileSync(join(m.claude, 'agents', 'flow-pm.md'), '---\nname: flow-pm\n---\n<!-- generated by lib/agents/install-agents.mjs from x; edits here are overwritten -->\nold\n')
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(readFileSync(join(m.claude, 'agents', 'flow-pm.md'), 'utf8'), /\nold\n/)
  assert.ok(ownedOf(m).links[join(m.claude, 'agents', 'flow-pm.md')])
})

test('a personal skill that disappeared has its link removed', () => {
  const m = claudeMachine({ personal: { 'harness.json': '{}\n' } })
  mkdirSync(join(m.personal, 'skills', 'mine'), { recursive: true })
  writeFileSync(join(m.personal, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: mine\n---\n')
  assert.equal(tiller(['apply', '--yes', '--user', 'sam'], m).status, 0)
  assert.equal(linkOf(join(m.claude, 'skills', 'mine')), join(m.personal, 'skills', 'mine'))
  rmSync(join(m.personal, 'skills', 'mine'), { recursive: true })
  const r = tiller(['apply', '--yes', '--user', 'sam'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /- skill mine/)
  assert.equal(existsSync(join(m.claude, 'skills', 'mine')) || Boolean(linkOf(join(m.claude, 'skills', 'mine'))), false)
  assert.equal(ownedOf(m).links[join(m.claude, 'skills', 'mine')], undefined)
})

function editedAgent() {
  const m = claudeMachine()
  assert.equal(tiller(['apply', '--yes'], m).status, 0)
  const file = join(m.claude, 'agents', 'flow-pm.md')
  writeFileSync(file, readFileSync(file, 'utf8') + 'my note\n')
  return { m, file }
}

test('an edited role agent without a terminal refuses, naming the file', () => {
  const { m, file } = editedAgent()
  const r = tiller(['apply', '--yes'], m)
  assert.equal(r.status, 3)
  assert.match(r.stderr, /flow-pm\.md/)
  assert.match(readFileSync(file, 'utf8'), /my note\n$/)
})

test('an edited role agent in a terminal: overwrite restores it, release keeps the edit for good', async () => {
  const one = editedAgent()
  const o = await applyAnswering(one.m, [], [[/flow-pm\.md.*\[o\]verwrite \/ \[r\]elease/s, 'o'], [/Apply these/, 'y']])
  assert.equal(o.code, 0, o.out)
  assert.doesNotMatch(readFileSync(one.file, 'utf8'), /my note/)
  assert.ok(!o.asked.some(q => /\[a\]dopt/.test(q) && /flow-pm\.md/.test(q)), 'no adopt for a rendered agent')

  const two = editedAgent()
  const rel = await applyAnswering(two.m, [], [[/flow-pm\.md.*\[o\]verwrite \/ \[r\]elease/s, 'r'], [/Apply these/, 'y']])
  assert.equal(rel.code, 0, rel.out)
  assert.match(readFileSync(two.file, 'utf8'), /my note\n$/)
  assert.equal(ownedOf(two.m).links[two.file], undefined)
  const after = tiller(['apply', '--yes'], two.m)
  assert.equal(after.status, 0, after.stderr)
  assert.match(after.stdout, /skipped: .*flow-pm\.md/)
  assert.match(readFileSync(two.file, 'utf8'), /my note\n$/)
})

const snapshot = m => ({ tree: tree(m.root), owned: readFileSync(join(m.state, 'owned.json'), 'utf8'), machine: readFileSync(join(m.state, 'machine.json'), 'utf8') })
const statusOf = m => {
  const r = tiller(['status', '--json'], m)
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('status after a clean apply: every item and link ok, and status writes nothing', () => {
  const m = claudeMachine()
  assert.equal(tiller(['apply', '--yes'], m).status, 0)
  const before = snapshot(m)
  const s = statusOf(m)
  const settings = s.files.find(f => f.path === join(m.claude, 'settings.json'))
  assert.deepEqual(settings.items, [{ id: '/env/TILLER_HOME', state: 'ok' }, { id: 'hook:PreToolUse:private-access', state: 'ok' }])
  assert.equal(settings.agent, 'claude')
  assert.ok(s.links.length > 0)
  assert.deepEqual([...new Set(s.links.map(l => l.state))], ['ok'])
  const text = tiller(['status'], m)
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /settings\.json/)
  assert.match(text.stdout, /ok +\/env\/TILLER_HOME/)
  assert.match(text.stdout, new RegExp(`claude: ${s.links.length} links ok`))
  assert.deepEqual(snapshot(m), before)
})

test('status names an edited key drifted, a removed link missing, a replaced one foreign, a released key released', async () => {
  const m = claudeMachine({ personal: { 'harness.json': '{ "native": { "claude": { "model": "x" } } }\n' } })
  assert.equal(tiller(['apply', '--yes', '--user', 'sam'], m).status, 0)
  const edit = change => {
    const doc = settingsOf(m)
    change(doc)
    writeFileSync(join(m.claude, 'settings.json'), JSON.stringify(doc, null, 2) + '\n')
  }
  edit(doc => { doc.model = 'mine' })
  assert.equal((await applyAnswering(m, ['--user', 'sam'], [[/\/model drifted/, 'r']])).code, 0)
  edit(doc => { doc.env.TILLER_HOME = '/by/hand' })
  unlinkSync(join(m.claude, 'skills', SKILLS[0]))
  unlinkSync(join(m.claude, 'skills', SKILLS[1]))
  mkdirSync(join(m.claude, 'skills', SKILLS[1]))
  rmSync(join(m.claude, 'CLAUDE.md'))
  const s = statusOf(m)
  const settings = s.files.find(f => f.path === join(m.claude, 'settings.json'))
  assert.equal(settings.items.find(i => i.id === '/env/TILLER_HOME').state, 'drifted')
  assert.deepEqual(settings.released, ['/model'])
  assert.equal(s.files.find(f => f.path === join(m.claude, 'CLAUDE.md')).items[0].state, 'missing')
  const byDest = Object.fromEntries(s.links.map(l => [l.dest, l.state]))
  assert.equal(byDest[join(m.claude, 'skills', SKILLS[0])], 'missing')
  assert.equal(byDest[join(m.claude, 'skills', SKILLS[1])], 'foreign')
  const text = tiller(['status'], m).stdout
  assert.match(text, /drifted +\/env\/TILLER_HOME/)
  assert.match(text, new RegExp(`missing +skill ${SKILLS[0]}`))
  assert.match(text, /released +\/model/)
})

test('status of a machine tiller never touched says so', () => {
  const m = claudeMachine()
  const r = tiller(['status'], m)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /manages nothing/)
  assert.equal(tree(m.state), null)
})
