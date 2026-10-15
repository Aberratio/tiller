import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adoptable, portable, writeLayer } from '../adopt.mjs'
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
