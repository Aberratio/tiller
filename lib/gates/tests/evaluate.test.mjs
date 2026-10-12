import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { evaluate, authorityOf, globToRegExp } from '../evaluate.mjs'
import { check } from '../../contract/validate.mjs'
import { FIXTURE, ROOT, renderFacts } from './helpers.mjs'

const facts = renderFacts(FIXTURE)
const HEAD = 'a'.repeat(40)
const green = { state: 'green', headSha: HEAD, evidence: 'observed' }
const allGreen = { ci: green, lint: green }
const run = (files, observations = allGreen, preconditions = {}) =>
  evaluate({ facts, headSha: HEAD, files, observations, preconditions })

test('all paths agent and every gate green: merge allowed', () => {
  const r = run(['app/main.ts', 'docs/readme.md'])
  assert.equal(r.authority, 'agent')
  assert.equal(r.mergeAllowed, true)
  assert.equal(r.readyToSign, false)
  assert.deepEqual(r.humanPaths, [])
})

test('a human path with every gate green: ready to sign, not mergeable', () => {
  const r = run(['app/main.ts', 'core/engine.ts'])
  assert.equal(r.authority, 'human')
  assert.equal(r.mergeAllowed, false)
  assert.equal(r.readyToSign, true)
  assert.deepEqual(r.humanPaths, ['core/engine.ts'])
})

test('an unconfirmed table: ready to sign', () => {
  const f = { ...facts, mergeAuthority: [{ paths: ['everything'], globs: ['**'], who: 'unconfirmed', whoRaw: 'unconfirmed', precondition: null }] }
  const r = evaluate({ facts: f, headSha: HEAD, files: ['app/main.ts'], observations: allGreen })
  assert.equal(r.authority, 'unconfirmed')
  assert.equal(r.readyToSign, true)
  assert.equal(r.mergeAllowed, false)
})

test('an unlisted path requires a signature', () => {
  const r = run(['build.config.js'])
  assert.equal(r.authority, 'human')
  assert.deepEqual(r.humanPaths, ['build.config.js'])
  assert.equal(r.mergeAllowed, false)
})

test('an unlisted path takes unconfirmed when the table has it', () => {
  const ma = [...facts.mergeAuthority, { paths: ['x/**'], globs: ['x/**'], who: 'unconfirmed', whoRaw: '', precondition: null }]
  assert.equal(authorityOf('elsewhere.txt', ma), 'unconfirmed')
})

test('any gate blocked: park, neither mergeable nor ready to sign', () => {
  for (const files of [['app/main.ts'], ['core/engine.ts']]) {
    const r = run(files, { ci: green, lint: { ...green, state: 'blocked' } })
    assert.equal(r.mergeAllowed, false)
    assert.equal(r.readyToSign, false)
  }
})

test('a red gate parks', () => {
  const r = run(['app/main.ts'], { ci: { ...green, state: 'red' }, lint: green })
  assert.equal(r.mergeAllowed, false)
  assert.equal(r.readyToSign, false)
})

test('missing, unreadable or stale observations are blocked', () => {
  const r = run(['app/main.ts'], { ci: { ...green, headSha: 'b'.repeat(40) }, lint: { ...green, state: 'passed' } })
  assert.deepEqual(r.conditions.map(c => c.state), ['blocked', 'blocked'])
  assert.equal(run(['app/main.ts'], { ci: green }).conditions[1].state, 'blocked')
})

test('no declared gates never allows a merge', () => {
  const r = evaluate({ facts: { ...facts, gates: [] }, headSha: HEAD, files: ['app/main.ts'] })
  assert.equal(r.mergeAllowed, false)
})

test('an unmet precondition blocks; a met one lets the merge through', () => {
  const text = 'after a note to the infra owner'
  const unmet = run(['infra/deploy.yml'])
  assert.equal(unmet.authority, 'agent')
  assert.equal(unmet.mergeAllowed, false)
  assert.equal(unmet.conditions.at(-1).state, 'blocked')
  const met = run(['infra/deploy.yml'], allGreen, { [text]: { met: true, evidence: 'note sent' } })
  assert.equal(met.mergeAllowed, true)
  assert.equal(met.conditions.at(-1).state, 'green')
})

test('the most specific glob wins, in either direction', () => {
  assert.equal(authorityOf('core/theme/colors.ts', facts.mergeAuthority), 'agent')
  assert.equal(authorityOf('core/engine.ts', facts.mergeAuthority), 'human')
})

test('a specificity tie goes to the stricter row', () => {
  const ma = [
    { globs: ['lib/*.ts'], who: 'agent' },
    { globs: ['lib/a*ts'], who: 'human' },
  ]
  assert.equal(authorityOf('lib/a.ts', ma), 'human')
})

test('glob semantics', () => {
  assert.ok(globToRegExp('**').test('any/depth/file'))
  assert.ok(globToRegExp('dir/**').test('dir/a/b'))
  assert.ok(!globToRegExp('dir/**').test('dirx/a'))
  assert.ok(globToRegExp('*.md').test('a.md'))
  assert.ok(!globToRegExp('*.md').test('d/a.md'))
  assert.ok(globToRegExp('**/*.md').test('d/e/a.md'))
})

test('output validates as a gate-result', () => {
  for (const r of [run(['app/main.ts']), run(['core/x']), run(['infra/y'], {})])
    assert.deepEqual(check('gate-result', r), [])
})

const cli = input => spawnSync('node', [join(ROOT, 'lib', 'gates', 'evaluate.mjs'), '-'], { input: JSON.stringify(input), encoding: 'utf8' })

test('CLI prints one script-result line carrying the gate-result', () => {
  const r = cli({ facts, headSha: HEAD, files: ['core/engine.ts'], observations: allGreen })
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(check('script-result', out, 0), [])
  const { status, ...payload } = out
  assert.equal(status, 'ok')
  assert.deepEqual(check('gate-result', payload), [])
  assert.equal(payload.readyToSign, true)
})

test('CLI refuses unusable input with a script-error', () => {
  const r = cli({ facts: { ...facts, gates: [] }, headSha: HEAD, files: ['a'] })
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.equal(out.kind, 'script-error')
  assert.deepEqual(check('script-result', out, 1), [])
})

test('no changed files known: signature required, never agent, and the evidence says why', () => {
  for (const files of [[], undefined, null]) {
    const r = evaluate({ facts, headSha: HEAD, files, observations: allGreen })
    assert.equal(r.authority, 'unconfirmed', JSON.stringify(files))
    assert.equal(r.mergeAllowed, false)
    assert.equal(r.readyToSign, false, 'a signer cannot be told which paths to sign')
    const c = r.conditions.find(x => x.name === 'touched-paths')
    assert.ok(c, 'a condition names the missing input')
    assert.equal(c.state, 'blocked')
    assert.match(c.evidence, /no changed files/)
    assert.deepEqual(check('gate-result', r), [])
  }
})
