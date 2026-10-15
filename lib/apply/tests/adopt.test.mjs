import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptable, adoptableSkills, copySkills, foreignAgents, portable, writeLayer } from '../adopt.mjs'
import { skillRoots } from '../../adapters/skills.mjs'
import { InvalidNativeFile } from '../merge.mjs'
import { BLOCK_HEADER, claudeTargets } from '../../adapters/claude.mjs'
import { copilotTargets } from '../../adapters/copilot.mjs'

const VARS = { TILLER_HOME: '/h/tiller', HOME: '/h' }
const DIR = '/h/.claude'
const tmp = () => mkdtempSync(join(tmpdir(), 'tiller-adopt-'))
const json = v => JSON.stringify(v, null, 2) + '\n'

// Claude targets rendered from a resolved state, the way apply renders them before planning.
const claude = (desired = {}) => claudeTargets({ env: { TILLER_HOME: VARS.TILLER_HOME }, ...desired }, { configDir: DIR, platform: 'darwin' })
const currents = entries => new Map(entries)
const ids = r => r.items.map(i => i.id)

// --- portable ----------------------------------------------------------------------------------

test('portable folds the tiller path and home back into their variables, longest first', () => {
  assert.equal(portable('/h/tiller/x', VARS), '${TILLER_HOME}/x')
  assert.equal(portable('/h/notes', VARS), '${HOME}/notes')
  assert.equal(portable('/h', VARS), '${HOME}')
  assert.equal(portable("'/h/tiller/hook.sh' --home /h", VARS), "'${TILLER_HOME}/hook.sh' --home ${HOME}")
})

test('portable leaves other prefixes and non-strings alone', () => {
  assert.equal(portable('/hx/notes', VARS), '/hx/notes')
  assert.equal(portable('/h/tillerx', VARS), '${HOME}/tillerx')
  assert.equal(portable(3, VARS), 3)
  assert.equal(portable(true, VARS), true)
  assert.equal(portable(null, VARS), null)
})

test('portable on win32 also folds the forward-slash form of each path', () => {
  const vars = { TILLER_HOME: 'C:\\Users\\sam\\tiller', HOME: 'C:\\Users\\sam' }
  assert.equal(portable('C:\\Users\\sam\\tiller\\x', vars, 'win32'), '${TILLER_HOME}\\x')
  assert.equal(portable('C:/Users/sam/tiller/x', vars, 'win32'), '${TILLER_HOME}/x')
  assert.equal(portable('C:/Users/sam/notes', vars, 'win32'), '${HOME}/notes')
})

// --- adoptable: claude -----------------------------------------------------------------------------

test('claude settings leaves become native pointers and env.* becomes env items', () => {
  const settings = { model: 'opus', permissions: { allow: ['Bash(ls)'] }, env: { FOO: 'bar' } }
  const r = adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), json(settings)]]))
  assert.deepEqual(r.items.map(i => [i.id, i.value, i.op]), [
    ['/model', 'opus', 'set'],
    ['/permissions/allow', ['Bash(ls)'], 'set'],
    ['/env/FOO', 'bar', 'set'],
  ])
  assert.ok(r.items.every(i => i.path === join(DIR, 'settings.json')))
  assert.equal(r.same, 0)
})

test('a leaf equal to the rendered item of the same id is counted as already reproduced', () => {
  const settings = { env: { TILLER_HOME: '/h/tiller' }, model: 'opus' }
  const r = adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), json(settings)]]))
  assert.deepEqual(ids(r), ['/model'])
  assert.equal(r.same, 1)
})

test('a value differing from the rendered one is proposed, not counted as reproduced', () => {
  const settings = { env: { TILLER_HOME: '/elsewhere' } }
  const r = adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), json(settings)]]))
  assert.deepEqual(r.items.map(i => [i.id, i.value]), [['/env/TILLER_HOME', '/elsewhere']])
  assert.equal(r.same, 0)
})

test('hooks are never adopted: user entries are reported, tiller entries ignored', () => {
  const settings = {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-hook' }] },
        { matcher: 'Read', hooks: [{ type: 'command', command: "TILLER_HOOK=private-access '/h/tiller/lib/hooks/private-access.sh'" }] },
      ],
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }],
    },
  }
  const r = adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), json(settings)]]))
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.left, [
    { path: join(DIR, 'settings.json'), what: 'hooks.PreToolUse: 1 user entry stays native' },
    { path: join(DIR, 'settings.json'), what: 'hooks.Stop: 1 user entry stays native' },
  ])
})

test('an absent settings file yields nothing', () => {
  const r = adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), null]]))
  assert.deepEqual(r, { items: [], same: 0, left: [] })
})

test('the CLAUDE.md block body becomes a block item; text outside the markers is not read', () => {
  const md = `# Mine\n\nkeep out\n\n<!-- tiller:begin -->\n${BLOCK_HEADER}\nBe terse.\n<!-- tiller:end -->\n`
  const r = adoptable('claude', claude(), currents([[join(DIR, 'CLAUDE.md'), md]]))
  assert.deepEqual(r.items, [{ path: join(DIR, 'CLAUDE.md'), id: 'block', value: `${BLOCK_HEADER}\nBe terse.`, op: 'set' }])
  assert.deepEqual(r.left, [])
})

test('a block equal to the rendered body is already reproduced', () => {
  const md = `<!-- tiller:begin -->\n${BLOCK_HEADER}\nBe terse.\n<!-- tiller:end -->\n`
  const r = adoptable('claude', claude({ instructions: { body: 'Be terse.' } }), currents([[join(DIR, 'CLAUDE.md'), md]]))
  assert.deepEqual(r.items, [])
  assert.equal(r.same, 1)
})

test('CLAUDE.md without markers is left with a reason', () => {
  const r = adoptable('claude', claude(), currents([[join(DIR, 'CLAUDE.md'), '# Mine\n\nkeep out\n']]))
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.left, [{ path: join(DIR, 'CLAUDE.md'), what: 'no managed block' }])
})

test('an unparseable native file refuses the whole adopt', () => {
  assert.throws(() => adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), '{ nope']])), InvalidNativeFile)
  assert.throws(() => adoptable('claude', claude(), currents([[join(DIR, 'settings.json'), '[1]']])), InvalidNativeFile)
  assert.throws(() => adoptable('claude', claude(), currents([[join(DIR, 'CLAUDE.md'), '<!-- tiller:end -->\n<!-- tiller:begin -->\n']])), InvalidNativeFile)
})

// --- adoptable: copilot ----------------------------------------------------------------------------

const CDIR = '/h/.copilot'
const copilot = (desired = {}) => copilotTargets({ env: {}, ...desired }, { configDir: CDIR, tillerHome: VARS.TILLER_HOME, platform: 'darwin' })

test('copilot settings leaves are read through comments and the tiller hooks file is skipped', () => {
  const settings = `{\n  // mine\n  "stayInAutopilot": true,\n  "theme": { "name": "dark" }\n}\n`
  const hooks = json({ version: 1, hooks: { PreToolUse: [{ type: 'command', bash: 'x' }] } })
  const r = adoptable('copilot', copilot(), currents([
    [join(CDIR, 'hooks', 'tiller.json'), hooks],
    [join(CDIR, 'settings.json'), settings],
    [join(CDIR, 'copilot-instructions.md'), '# mine\n'],
  ]))
  assert.deepEqual(r.items.map(i => [i.id, i.value]), [['/stayInAutopilot', true], ['/theme/name', 'dark']])
  assert.ok(r.items.every(i => i.path === join(CDIR, 'settings.json')))
  assert.deepEqual(r.left, [{ path: join(CDIR, 'copilot-instructions.md'), what: 'no managed block' }])
})

test('an invalid copilot settings file refuses the adopt', () => {
  assert.throws(() => adoptable('copilot', copilot(), currents([[join(CDIR, 'settings.json'), '{ "a": }']])), InvalidNativeFile)
})

// --- writeLayer ------------------------------------------------------------------------------------

test('writeLayer creates the directory and routes items into env, native and instructions', () => {
  const dir = join(tmp(), 'personal', 'sam')
  const written = writeLayer(dir, [
    { agent: 'claude', id: '/env/FOO', value: 'bar' },
    { agent: 'claude', id: '/model', value: 'opus' },
    { agent: 'claude', id: '/permissions/allow', value: ['Bash(ls)'] },
    { agent: 'copilot', id: '/stayInAutopilot', value: true },
    { agent: 'claude', id: 'block', value: `${BLOCK_HEADER}\nBe terse.` },
  ], { vars: VARS })
  assert.deepEqual(written.sort(), [join(dir, 'harness.json'), join(dir, 'instructions.md')])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')), {
    env: { FOO: 'bar' },
    native: { claude: { model: 'opus', permissions: { allow: ['Bash(ls)'] } }, copilot: { stayInAutopilot: true } },
  })
  assert.equal(readFileSync(join(dir, 'instructions.md'), 'utf8'), 'Be terse.\n')
})

test('writeLayer merges into an existing harness.json and keeps its other keys', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'harness.json'), json({ $comment: 'mine', env: { KEEP: '1' }, native: { claude: { model: 'old', other: 1 } } }))
  const written = writeLayer(dir, [{ agent: 'claude', id: '/model', value: 'new' }], { vars: VARS })
  assert.deepEqual(written, [join(dir, 'harness.json')])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')), {
    $comment: 'mine', env: { KEEP: '1' }, native: { claude: { model: 'new', other: 1 } },
  })
  assert.equal(existsSync(join(dir, 'instructions.md')), false)
})

test('writeLayer stores values portably, also inside arrays and objects', () => {
  const dir = tmp()
  writeLayer(dir, [
    { agent: 'claude', id: '/env/TILLER_HOME', value: '/h/tiller' },
    { agent: 'claude', id: '/permissions/allow', value: ['Read(/h/notes/**)', 'Bash(/h/tiller/bin/*)'] },
    { agent: 'copilot', id: '/paths', value: { a: '/h/a' } },
  ], { vars: VARS })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')), {
    env: { TILLER_HOME: '${TILLER_HOME}' },
    native: { claude: { permissions: { allow: ['Read(${HOME}/notes/**)', 'Bash(${TILLER_HOME}/bin/*)'] } }, copilot: { paths: { a: '${HOME}/a' } } },
  })
})

test('writeLayer with an undefined value removes the key, as drift adopt of a removed item does', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'harness.json'), json({ env: { GONE: '1', KEEP: '2' } }))
  writeLayer(dir, [{ agent: 'claude', id: '/env/GONE', value: undefined }], { vars: VARS })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'harness.json'), 'utf8')), { env: { KEEP: '2' } })
})

test('writeLayer writes an empty instructions.md for a block that holds only the header', () => {
  const dir = tmp()
  mkdirSync(dir, { recursive: true })
  writeLayer(dir, [{ agent: 'copilot', id: 'block', value: BLOCK_HEADER }], { vars: VARS })
  assert.equal(readFileSync(join(dir, 'instructions.md'), 'utf8'), '')
})

// --- foreign skills and agents -------------------------------------------------------------------

const skill = (root, name, body = `# ${name}\n`) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), body)
  return join(root, name)
}

// A synthetic machine: tiller checkout, personal layer, agent config dir and home, all under one temp root.
function world() {
  const root = tmp()
  const tillerHome = join(root, 'tiller'), personalDir = join(root, 'personal', 'sam'), home = join(root, 'home')
  const configDir = join(home, '.claude')
  for (const d of [join(tillerHome, 'skills'), join(configDir, 'skills'), join(home, '.agents', 'skills'), join(configDir, 'agents')]) mkdirSync(d, { recursive: true })
  skill(join(tillerHome, 'skills'), 'tracked')
  return { root, tillerHome, personalDir, home, configDir }
}

test('skillRoots names one root for claude and two for copilot', () => {
  assert.deepEqual(skillRoots('claude', { configDir: '/h/.claude', home: '/h' }), ['/h/.claude/skills'])
  assert.deepEqual(skillRoots('copilot', { configDir: '/h/.copilot', home: '/h' }), ['/h/.agents/skills', '/h/.copilot/skills'])
})

test('a real skill directory is proposed for copy into the personal layer', () => {
  const w = world()
  const from = skill(join(w.configDir, 'skills'), 'mine')
  const r = adoptableSkills('claude', w)
  assert.deepEqual(r, { copy: [{ name: 'mine', from, to: join(w.personalDir, 'skills', 'mine') }], left: [] })
})

test('a symlink into the tiller checkout is tiller\'s own link and is passed over silently', () => {
  const w = world()
  symlinkSync(join(w.tillerHome, 'skills', 'tracked'), join(w.configDir, 'skills', 'tracked'))
  assert.deepEqual(adoptableSkills('claude', w), { copy: [], left: [] })
})

test('a symlink into another tree is copied from its target', () => {
  const w = world()
  const target = skill(join(w.root, 'dotfiles', 'skills'), 'linked')
  symlinkSync(target, join(w.configDir, 'skills', 'linked'))
  const r = adoptableSkills('claude', w)
  assert.deepEqual(r.copy, [{ name: 'linked', from: join(w.configDir, 'skills', 'linked'), to: join(w.personalDir, 'skills', 'linked') }])
})

test('entries without SKILL.md are ignored', () => {
  const w = world()
  mkdirSync(join(w.configDir, 'skills', 'empty'))
  writeFileSync(join(w.configDir, 'skills', 'README.md'), 'x\n')
  assert.deepEqual(adoptableSkills('claude', w), { copy: [], left: [] })
})

test('a name matching a tracked skill is left because it would shadow it', () => {
  const w = world()
  const path = skill(join(w.configDir, 'skills'), 'tracked')
  assert.deepEqual(adoptableSkills('claude', w), { copy: [], left: [{ path, what: "would shadow tiller's skill" }] })
})

test('a name already in the personal layer is left, never overwritten', () => {
  const w = world()
  skill(join(w.personalDir, 'skills'), 'mine', 'personal\n')
  const path = skill(join(w.configDir, 'skills'), 'mine', 'native\n')
  assert.deepEqual(adoptableSkills('claude', w), { copy: [], left: [{ path, what: 'already in the personal layer' }] })
  assert.equal(readFileSync(join(w.personalDir, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'personal\n')
})

test('a dangling symlink is left', () => {
  const w = world()
  const path = join(w.configDir, 'skills', 'gone')
  symlinkSync(join(w.root, 'nowhere'), path)
  assert.deepEqual(adoptableSkills('claude', w), { copy: [], left: [{ path, what: 'dangling symlink' }] })
})

test('copilot reads both roots and reports a name seen twice', () => {
  const w = world()
  const configDir = join(w.home, '.copilot')
  mkdirSync(join(configDir, 'skills'), { recursive: true })
  const a = skill(join(w.home, '.agents', 'skills'), 'a')
  const b = skill(join(configDir, 'skills'), 'b')
  const again = skill(join(configDir, 'skills'), 'a')
  const r = adoptableSkills('copilot', { ...w, configDir })
  assert.deepEqual(r.copy, [
    { name: 'a', from: a, to: join(w.personalDir, 'skills', 'a') },
    { name: 'b', from: b, to: join(w.personalDir, 'skills', 'b') },
  ])
  assert.deepEqual(r.left, [{ path: again, what: `same name as ${a}` }])
})

test('foreignAgents lists hand written and renamed files, not a rendered role', () => {
  const w = world()
  const dir = join(w.configDir, 'agents')
  writeFileSync(join(dir, 'flow-resolver.md'), '---\nname: flow-resolver\n---\n<!-- generated by lib/agents/install-agents.mjs -->\n')
  writeFileSync(join(dir, 'flow-x.md'), '---\nname: flow-x\n---\nmine\n')
  writeFileSync(join(dir, 'reviewer.md'), '<!-- generated by lib/agents/install-agents.mjs -->\n')
  writeFileSync(join(dir, 'notes.txt'), 'x\n')
  assert.deepEqual(foreignAgents('claude', { configDir: w.configDir, desiredAgents: ['flow-resolver'] }), [
    { path: join(dir, 'flow-x.md'), what: 'not a tiller role' },
    { path: join(dir, 'reviewer.md'), what: 'not a tiller role' },
  ])
})

test('foreignAgents reports a desired role whose file lacks the generated marker', () => {
  const w = world()
  writeFileSync(join(w.configDir, 'agents', 'flow-resolver.md'), 'edited by hand\n')
  assert.deepEqual(foreignAgents('claude', { configDir: w.configDir, desiredAgents: ['flow-resolver'] }), [
    { path: join(w.configDir, 'agents', 'flow-resolver.md'), what: 'no generated marker' },
  ])
})

test('foreignAgents for copilot reads *.agent.md and the copilot marker', () => {
  const w = world()
  const dir = join(w.home, '.copilot', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'flow-resolver.agent.md'), '---\nname: flow-resolver\n---\n<!-- generated by tiller apply from x; edits here are reported as drift -->\n')
  writeFileSync(join(dir, 'other.agent.md'), 'x\n')
  assert.deepEqual(foreignAgents('copilot', { configDir: join(w.home, '.copilot'), desiredAgents: ['flow-resolver'] }), [
    { path: join(dir, 'other.agent.md'), what: 'not a tiller role' },
  ])
})

test('foreignAgents with no agents directory is empty', () => {
  assert.deepEqual(foreignAgents('claude', { configDir: join(tmp(), 'none'), desiredAgents: [] }), [])
})

test('copySkills copies nested files, dereferencing links, and refuses an existing destination', () => {
  const w = world()
  const from = skill(join(w.configDir, 'skills'), 'mine')
  mkdirSync(join(from, 'refs'))
  writeFileSync(join(from, 'refs', 'a.md'), 'a\n')
  const target = skill(join(w.root, 'dotfiles', 'skills'), 'linked', 'linked body\n')
  symlinkSync(target, join(w.configDir, 'skills', 'linked'))
  const { copy } = adoptableSkills('claude', w)
  copySkills(copy)
  assert.equal(readFileSync(join(w.personalDir, 'skills', 'mine', 'refs', 'a.md'), 'utf8'), 'a\n')
  assert.equal(readFileSync(join(w.personalDir, 'skills', 'linked', 'SKILL.md'), 'utf8'), 'linked body\n')
  assert.equal(lstatSync(join(w.personalDir, 'skills', 'linked')).isSymbolicLink(), false)
  assert.throws(() => copySkills(copy), /exists/)
})
