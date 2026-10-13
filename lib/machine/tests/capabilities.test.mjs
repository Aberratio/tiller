import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURES, capabilities, installCommand } from '../capabilities.mjs'

const tool = p => ({ path: p, version: '1.0' })
function machine(platform = 'darwin', { drop = [], agents = ['claude', 'copilot'], shell = true } = {}) {
  const tools = Object.fromEntries(['node', 'git', 'gh', 'jq', 'timeout'].map(t => [t, drop.includes(t) ? null : tool(`/bin/${t}`)]))
  const a = name => ({ bin: agents.includes(name) ? `/bin/${name}` : null, configDir: `/h/.${name}`, configDirExists: false })
  return { platform, shell: shell ? { path: '/bin/bash', kind: 'bash' } : null, tools, agents: { claude: a('claude'), copilot: a('copilot') } }
}
const byId = list => Object.fromEntries(list.map(f => [f.id, f]))

test('features follow the spec table order', () => {
  assert.deepEqual(FEATURES.map(f => f.id),
    ['skills', 'role-agents', 'private-access', 'profile-resolution', 'unattended', 'pull-requests'])
})

test('a fully equipped machine has every feature ready', () => {
  for (const f of capabilities(machine())) assert.equal(f.status, 'ready', f.id)
})

test('missing jq makes the private-access hook unavailable with the install command for this OS', () => {
  for (const [platform, cmd] of [['darwin', 'brew install jq'], ['linux', 'sudo apt install jq'], ['win32', 'winget install jqlang.jq']]) {
    const f = byId(capabilities(machine(platform, { drop: ['jq'] })))['private-access']
    assert.equal(f.status, 'unavailable')
    assert.deepEqual(f.missing, ['jq'])
    assert.deepEqual(f.install, [cmd])
  }
})

test('win32 without Git Bash loses the hook and profile resolution but keeps skills', () => {
  const f = byId(capabilities(machine('win32', { shell: false })))
  assert.equal(f['private-access'].status, 'unavailable')
  assert.equal(f['profile-resolution'].status, 'unavailable')
  assert.match(f['profile-resolution'].reason, /Git Bash/)
  assert.deepEqual(f['profile-resolution'].install, ['winget install Git.Git'])
  assert.equal(f.skills.status, 'ready')
})

test('Copilot alone runs role agents but not unattended runs', () => {
  const f = byId(capabilities(machine('linux', { agents: ['copilot'] })))
  assert.equal(f['role-agents'].status, 'ready')
  assert.equal(f.unattended.status, 'unavailable')
  assert.match(f.unattended.reason, /Claude Code/)
})

test('no agent at all degrades skills to the files fallback and drops role agents', () => {
  const f = byId(capabilities(machine('darwin', { agents: [] })))
  assert.equal(f.skills.status, 'degraded')
  assert.match(f.skills.reason, /files/)
  assert.equal(f['role-agents'].status, 'unavailable')
  assert.deepEqual(f['role-agents'].install,
    ['curl -fsSL https://claude.ai/install.sh | bash  OR  brew install --cask copilot-cli'])
})

test('missing gh names gh once per feature it disables', () => {
  const f = byId(capabilities(machine('darwin', { drop: ['gh', 'timeout'] })))
  assert.deepEqual(f['pull-requests'].missing, ['gh'])
  assert.deepEqual(f.unattended.missing, ['timeout', 'gh'])
  assert.deepEqual(f.unattended.install, ['brew install coreutils', 'brew install gh'])
})

test('installCommand covers every tool on every platform', () => {
  for (const t of ['node', 'git', 'gh', 'jq', 'timeout', 'shell', 'claude', 'copilot'])
    for (const p of ['darwin', 'linux', 'win32']) assert.ok(installCommand(t, p), `${t} on ${p}`)
})
