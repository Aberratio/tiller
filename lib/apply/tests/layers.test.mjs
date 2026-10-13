import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLayers, resolve } from '../layers.mjs'

const REPO = resolvePath(fileURLToPath(import.meta.url), '..', '..', '..', '..')

// A throwaway tiller home with its own base layer, a personal dir and a state dir.
function world({ base, personal, instructions, machine } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'layers-'))
  const tillerHome = join(root, 'Other Repos', 'tiller')
  const personalDir = join(root, 'personal', 'sam')
  const stateHome = join(root, 'state')
  mkdirSync(join(tillerHome, 'config', 'harness'), { recursive: true })
  writeFileSync(join(tillerHome, 'config', 'harness', 'base.json'),
    typeof base === 'string' ? base : JSON.stringify(base ?? BASE))
  if (personal !== undefined || instructions !== undefined) mkdirSync(personalDir, { recursive: true })
  if (personal !== undefined) writeFileSync(join(personalDir, 'harness.json'), typeof personal === 'string' ? personal : JSON.stringify(personal))
  if (instructions !== undefined) writeFileSync(join(personalDir, 'instructions.md'), instructions)
  if (machine !== undefined) {
    mkdirSync(stateHome, { recursive: true })
    writeFileSync(join(stateHome, 'machine.json'), typeof machine === 'string' ? machine : JSON.stringify(machine))
  }
  return { tillerHome, personalDir, stateHome }
}

const BASE = {
  env: { TILLER_HOME: '${TILLER_HOME}' },
  hooks: [{ id: 'private-access', event: 'preToolUse', kinds: ['read'], command: '${TILLER_HOME}/lib/hooks/private-access.sh' }],
  agents: ['flow-resolver'],
  instructions: { file: 'instructions.md' },
}

const desiredOf = (w, vars = { TILLER_HOME: w.tillerHome, HOME: '/home/sam' }) => resolve(readLayers(w), { vars })

test('the tracked base layer carries the spec example without native settings', async () => {
  const { readFileSync } = await import('node:fs')
  const base = JSON.parse(readFileSync(join(REPO, 'config', 'harness', 'base.json'), 'utf8'))
  assert.deepEqual(Object.keys(base).sort(), ['agents', 'env', 'hooks', 'instructions'])
  assert.equal(base.hooks[0].id, 'private-access')
})

test('base only: variables expanded, no instructions body', () => {
  const w = world()
  const d = desiredOf(w)
  assert.deepEqual(d.env, { TILLER_HOME: w.tillerHome })
  assert.equal(d.hooks[0].command, `${w.tillerHome}/lib/hooks/private-access.sh`)
  assert.deepEqual(d.agents, ['flow-resolver'])
  assert.deepEqual(d.native, {})
  assert.equal(d.instructions.body, '')
})

test('a missing personal dir resolves to the base layer alone', () => {
  const w = world()
  assert.deepEqual(readLayers(w).map(l => l.name), ['base'])
  assert.deepEqual(readLayers({ ...w, personalDir: null }).map(l => l.name), ['base'])
})

test('personal overrides an env key and adds a native.claude key', () => {
  const w = world({ personal: { env: { TILLER_HOME: '/elsewhere', EXTRA: '1' }, native: { claude: { statusLine: { type: 'command' } } } } })
  const d = desiredOf(w)
  assert.deepEqual(d.env, { TILLER_HOME: '/elsewhere', EXTRA: '1' })
  assert.deepEqual(d.native, { claude: { statusLine: { type: 'command' } } })
})

test('hooks merge by id and a remove entry drops one', () => {
  const merged = desiredOf(world({ personal: { hooks: [{ id: 'private-access', kinds: ['read', 'shell'] }, { id: 'mine', event: 'preToolUse', kinds: [], command: 'x' }] } }))
  assert.deepEqual(merged.hooks.map(h => h.id), ['private-access', 'mine'])
  assert.deepEqual(merged.hooks[0].kinds, ['read', 'shell'])
  assert.match(merged.hooks[0].command, /private-access\.sh$/)
  const removed = desiredOf(world({ personal: { hooks: [{ id: 'private-access', remove: true }] } }))
  assert.deepEqual(removed.hooks, [])
})

test('arrays without ids are replaced and null deletes a key', () => {
  const d = desiredOf(world({ personal: { agents: ['flow-pm'], env: { TILLER_HOME: null } } }))
  assert.deepEqual(d.agents, ['flow-pm'])
  assert.deepEqual(d.env, {})
})

test('only TILLER_HOME and HOME are expanded; other ${...} stay verbatim', () => {
  const w = world({ personal: { native: { claude: { statusLine: { command: '${HOME}/bin/s ${PWD} ${TILLER_HOME}' } } } } })
  const d = desiredOf(w, { TILLER_HOME: '/a b/tiller', HOME: '/home/sam' })
  assert.equal(d.native.claude.statusLine.command, '/home/sam/bin/s ${PWD} /a b/tiller')
  assert.equal(d.env.TILLER_HOME, '/a b/tiller')
})

test('the personal instructions.md is the body', () => {
  const w = world({ instructions: '# Mine\n\nBe brief.\n' })
  assert.equal(desiredOf(w).instructions.body, '# Mine\n\nBe brief.')
})

test('machine.json contributes its layer keys and its probe is ignored', () => {
  const w = world({ machine: { probe: { platform: 'darwin' }, user: 'sam', env: { MACHINE: '1' } } })
  const layers = readLayers(w)
  assert.deepEqual(layers.map(l => l.name), ['base', 'machine'])
  assert.equal(layers[1].data.probe, undefined)
  assert.equal(desiredOf(w).env.MACHINE, '1')
})

test('invalid JSON in any layer throws naming the file', () => {
  assert.throws(() => readLayers(world({ base: '{' })), /base\.json/)
  assert.throws(() => readLayers(world({ personal: '{nope' })), /harness\.json/)
  assert.throws(() => readLayers(world({ machine: '[' })), /machine\.json/)
})
