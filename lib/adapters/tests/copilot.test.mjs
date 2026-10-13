import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BLOCK_HEADER } from '../claude.mjs'
import { copilotTargets, copilotEnvLines } from '../copilot.mjs'
import { readLayers, resolve } from '../../apply/layers.mjs'
import { plan } from '../../apply/merge.mjs'
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

test('env is printed as shell-profile lines, shell-quoted', () => {
  assert.deepEqual(copilotEnvLines({ env: { TILLER_HOME: "/a b/it's" } }), [`export TILLER_HOME='/a b/it'\\''s'`])
  assert.deepEqual(copilotEnvLines({ env: {} }), [])
})

test('the rendered bash command denies a private path in the format Copilot reads, with a spaced TILLER_HOME', () => {
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
