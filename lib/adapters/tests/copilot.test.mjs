import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_HEADER } from '../claude.mjs'
import { copilotTargets, copilotEnvLines } from '../copilot.mjs'
import { readLayers, resolve } from '../../apply/layers.mjs'
import { plan } from '../../apply/merge.mjs'
import { probe } from '../../machine/probe.mjs'
import { cleanEnv, makeHome } from '../../testing/private-access.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolvePath(HERE, '..', '..', '..')
const CONFIG = '/home/user/.copilot'
const OPTS = { configDir: CONFIG, tillerHome: '/opt/tiller' }

function desiredFor(personalDir, vars = { TILLER_HOME: '/opt/tiller', HOME: '/home/user' }) {
  const stateHome = join(mkdtempSync(join(tmpdir(), 'copilot-adapter-')), 'state')
  return resolve(readLayers({ tillerHome: REPO, personalDir, stateHome }), { vars })
}

const render = (target, current = null, entry = null) => plan(target, current, entry, [])

test('golden: base plus a personal layer renders the hooks file, settings.json and the instructions block', () => {
  const [hooks, settings, block] = copilotTargets(desiredFor(join(HERE, 'fixtures', 'personal')), OPTS)
  assert.equal(hooks.path, join(CONFIG, 'hooks', 'tiller.json'))
  assert.equal(settings.path, join(CONFIG, 'settings.json'))
  assert.equal(settings.kind, 'jsonc')
  assert.equal(block.path, join(CONFIG, 'copilot-instructions.md'))
  for (const [t, name] of [[hooks, 'tiller.json'], [settings, 'settings.json'], [block, 'copilot-instructions.md']]) {
    assert.equal(render(t).next.text, readFileSync(join(HERE, 'golden', 'copilot', name), 'utf8'), name)
  }
})

test('an empty personal layer leaves only the tracked header in the block and no settings item', () => {
  const [, settings, block] = copilotTargets(desiredFor(null), OPTS)
  assert.equal(block.body, BLOCK_HEADER)
  assert.deepEqual(settings.items, [])
})

test('no hooks desired: the hooks file has no item, so nothing is written', () => {
  const [hooks] = copilotTargets({ env: {}, hooks: [], native: {}, instructions: { body: '' } }, OPTS)
  assert.deepEqual(hooks.items, [])
  assert.equal(render(hooks).write, false)
})

test('a hook entry waits 120 s, since a Copilot hook that times out lets the call through', () => {
  const [hooks] = copilotTargets(desiredFor(null), OPTS)
  assert.equal(hooks.items.find(i => i.id === '/hooks/PreToolUse').value[0].timeoutSec, 120)
})

test('env is printed as shell-profile lines, shell-quoted', () => {
  assert.deepEqual(copilotEnvLines({ env: { TILLER_HOME: "/a b/it's" } }), [`export TILLER_HOME='/a b/it'\\''s'`])
  assert.deepEqual(copilotEnvLines({ env: {} }), [])
})

test('the rendered bash command denies a private path in the format Copilot reads, with a spaced TILLER_HOME', { skip: process.platform === 'win32' && 'POSIX PATH and a directory symlink; the powershell test covers Windows' }, () => {
  const { base, home, cwd } = makeHome()
  symlinkSync(join(REPO, 'lib'), join(home, 'lib'))
  const desired = {
    env: { TILLER_HOME: home },
    hooks: [{ id: 'private-access', event: 'preToolUse', kinds: ['read', 'shell'], command: `${home}/lib/hooks/private-access.sh` }],
    native: {}, instructions: { body: '' },
  }
  const [hooks] = copilotTargets(desired, { configDir: CONFIG, tillerHome: home })
  const [entry] = hooks.items.find(i => i.id === '/hooks/PreToolUse').value
  assert.equal(entry.matcher, 'Read|Bash')
  assert.deepEqual(entry.env, { TILLER_HOME: home })
  const env = cleanEnv({
    HOME: base, ...entry.env, PATH: `/usr/bin:/bin:/opt/homebrew/bin:${dirname(process.execPath)}`,
    CLAUDE_CONFIG_DIR: undefined, COPILOT_HOME: undefined,
  })
  const payload = tool_input => JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 's', timestamp: '2026-10-13T12:00:00.000Z', cwd: cwd.beta, tool_name: 'Bash', tool_input,
  })
  const denied = spawnSync('bash', ['-c', entry.bash], { encoding: 'utf8', input: payload({ command: 'cat brains/main/note.md' }), env })
  assert.equal(denied.status, 0, denied.stderr)
  assert.equal(JSON.parse(denied.stdout).permissionDecision, 'deny')
  const allowed = spawnSync('bash', ['-c', entry.bash], { encoding: 'utf8', input: payload({ command: 'ls /srv' }), env })
  assert.equal(allowed.status, 0, allowed.stderr)
  assert.equal(allowed.stdout, '')
})

const GIT_BASH = { path: 'C:\\Program Files\\Git\\bin\\bash.exe', posixPath: 'C:/Program Files/Git/bin/bash.exe', kind: 'git-bash' }

test('win32: the bash key runs the translator and the hook through Git Bash with forward slashes', () => {
  const desired = desiredFor(null, { TILLER_HOME: 'C:\\tiller home', HOME: 'C:\\Users\\u' })
  const [hooks] = copilotTargets(desired, { configDir: 'C:\\Users\\u\\.copilot', tillerHome: 'C:\\tiller home', platform: 'win32', shell: GIT_BASH })
  const [entry] = hooks.items.find(i => i.id === '/hooks/PreToolUse').value
  assert.equal(entry.bash,
    "'C:/Program Files/Git/bin/bash.exe' 'C:/tiller home/lib/hooks/copilot-pretooluse.sh' 'C:/tiller home/lib/hooks/private-access.sh'")
  assert.equal(entry.powershell,
    "& 'C:/Program Files/Git/bin/bash.exe' 'C:/tiller home/lib/hooks/copilot-pretooluse.sh' 'C:/tiller home/lib/hooks/private-access.sh'; exit $LASTEXITCODE")
})

test('a quote in TILLER_HOME is escaped for each shell in its own way', () => {
  const desired = desiredFor(null, { TILLER_HOME: "C:\\it's home", HOME: 'C:\\Users\\u' })
  const [hooks] = copilotTargets(desired, { configDir: 'C:\\Users\\u\\.copilot', tillerHome: "C:\\it's home", platform: 'win32', shell: GIT_BASH })
  const [entry] = hooks.items.find(i => i.id === '/hooks/PreToolUse').value
  assert.equal(entry.bash,
    "'C:/Program Files/Git/bin/bash.exe' 'C:/it'\\''s home/lib/hooks/copilot-pretooluse.sh' 'C:/it'\\''s home/lib/hooks/private-access.sh'")
  assert.equal(entry.powershell,
    "& 'C:/Program Files/Git/bin/bash.exe' 'C:/it''s home/lib/hooks/copilot-pretooluse.sh' 'C:/it''s home/lib/hooks/private-access.sh'; exit $LASTEXITCODE")
})

test('win32: env is printed as PowerShell user-variable lines', () => {
  assert.deepEqual(copilotEnvLines({ env: { TILLER_HOME: "C:\\it's home" } }, 'win32'),
    ["[Environment]::SetEnvironmentVariable('TILLER_HOME', 'C:\\it''s home', 'User')"])
})

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0

test('the powershell key runs the wrapper and keeps its non-zero exit', { skip: !pwsh && 'pwsh is not on PATH' }, () => {
  const { base } = makeHome()
  const stub = join(base, 'stub.sh')
  writeFileSync(stub, 'exit 3\n')
  const desired = { env: {}, hooks: [{ id: 'stub', event: 'preToolUse', kinds: ['read'], command: stub }], native: {}, instructions: { body: '' } }
  const [hooks] = copilotTargets(desired, { configDir: CONFIG, tillerHome: REPO, platform: process.platform,
    shell: probe({ platform: process.platform, env: process.env, home: base }).shell })
  const [entry] = hooks.items.find(i => i.id === '/hooks/PreToolUse').value
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', entry.powershell], { encoding: 'utf8', input: '{"tool_name":"Read"}' })
  assert.equal(r.status, 1, r.stderr)
})

