// Windows behaviour exercised on any host: platform 'win32' and the probe are injected, and junctions
// land as symlinks off Windows, which is what Node reports a junction as on Windows too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runApply } from '../apply.mjs'
import { runStatus } from '../status.mjs'
import { runUninstall } from '../uninstall.mjs'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const SKILLS = readdirSync(join(REPO, 'skills')).filter(n => existsSync(join(REPO, 'skills', n, 'SKILL.md'))).sort()

function winMachine({ shell = { path: 'C:\\Program Files\\Git\\bin\\bash.exe', posixPath: 'C:/Program Files/Git/bin/bash.exe', kind: 'git-bash' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tiller-win-'))
  const home = join(root, 'home'), state = join(root, 'state')
  mkdirSync(join(home, '.claude'), { recursive: true })
  assert.ok(existsSync(home))
  assert.notEqual(home, homedir())
  const env = { USERPROFILE: home, TILLER_STATE_HOME: state, TILLER_PERSONAL_ROOT: join(root, 'personal') }
  const probe = {
    platform: 'win32',
    shell,
    tools: { jq: { path: 'C:/bin/jq.exe', version: '1.7.1' } },
    agents: {
      claude: { bin: 'C:\\bin\\claude.exe', configDir: join(home, '.claude'), configDirExists: true },
      copilot: { bin: null, configDir: join(home, '.copilot'), configDirExists: false },
    },
  }
  const lines = []
  const base = { tillerHome: REPO, home, env, platform: 'win32', stateHome: state, personalDir: join(root, 'personal', 'none'),
    isTTY: false, out: s => lines.push(s) }
  return {
    root, home, state, lines, probe,
    skill: n => join(home, '.claude', 'skills', n),
    apply: (extra = {}) => runApply({ ...base, agents: ['claude'], yes: true, probeMachine: () => probe, ...extra }),
    status: () => runStatus({ stateHome: state, platform: 'win32' }),
    uninstall: (extra = {}) => runUninstall({ stateHome: state, platform: 'win32', yes: true, isTTY: false, out: s => lines.push(s), ...extra }),
  }
}

const owned = m => JSON.parse(readFileSync(join(m.state, 'owned.json'), 'utf8'))

test('win32 apply records a junction for every skill and rendered role agents', () => {
  const m = winMachine()
  assert.equal(m.apply().status, 'written')
  const links = owned(m).links
  for (const n of SKILLS) {
    assert.deepEqual(links[m.skill(n)], { agent: 'claude', kind: 'skill', mode: 'junction', source: join(REPO, 'skills', n) })
    assert.ok(lstatSync(m.skill(n)).isSymbolicLink())
  }
  const agents = Object.values(links).filter(e => e.kind === 'agent')
  assert.ok(agents.length > 0)
  assert.ok(agents.every(e => e.mode === 'rendered'))
  assert.doesNotMatch(m.lines.join(''), /step 5/)

  m.lines.length = 0
  assert.equal(m.apply().status, 'unchanged')
})

test('win32 apply skips a foreign skill directory', () => {
  const m = winMachine()
  mkdirSync(m.skill(SKILLS[0]), { recursive: true })
  writeFileSync(join(m.skill(SKILLS[0]), 'SKILL.md'), 'mine\n')
  m.apply()
  assert.equal(owned(m).links[m.skill(SKILLS[0])], undefined)
  assert.match(m.lines.join(''), new RegExp(`skipped: .*${SKILLS[0]} exists and is not tiller's`))
})

test('win32 status reports junctions ok, then missing after removal', () => {
  const m = winMachine()
  m.apply()
  const stateOf = () => m.status().links.find(l => l.dest === m.skill(SKILLS[0])).state
  assert.equal(stateOf(), 'ok')
  unlinkSync(m.skill(SKILLS[0]))
  assert.equal(stateOf(), 'missing')
})

test('win32 uninstall removes our junctions and leaves a foreign one', () => {
  const m = winMachine()
  m.apply()
  const other = join(m.root, 'elsewhere')
  mkdirSync(other)
  unlinkSync(m.skill(SKILLS[0]))
  symlinkSync(other, m.skill(SKILLS[0]), 'junction')
  assert.equal(m.uninstall().status, 'written')
  for (const n of SKILLS.slice(1)) assert.equal(existsSync(m.skill(n)), false)
  assert.ok(lstatSync(m.skill(SKILLS[0])).isSymbolicLink())
  assert.ok(existsSync(join(REPO, 'skills', SKILLS[1], 'SKILL.md')))
})
