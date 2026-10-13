import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, kinds } from '../../contract/validate.mjs'
import { MANDATES, NEVER, SIGN, ROUTES, route, runChain } from '../route.mjs'
import { FIXTURE, dropSection, renderFacts, replaceSection, variant } from '../../gates/tests/helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const CLI = join(HERE, '..', 'route.mjs')
const base = JSON.parse(readFileSync(join(HERE, 'fixtures', 'facts.json'), 'utf8'))
const scenarios = JSON.parse(readFileSync(join(HERE, 'fixtures', 'scenarios.json'), 'utf8'))

const inputOf = s => ({
  facts: typeof s.facts === 'string' ? base[s.facts] : s.facts,
  decision: s.decision === null ? null : { ...base.decision, ...(s.decision || {}) },
  step: s.step || {},
  answers: s.answers || {},
})

// Stub agents: each lane answers from the scenario and every call is recorded.
async function drive(s) {
  const calls = []
  const result = await runChain(inputOf(s), async (lane, brief) => {
    calls.push(lane)
    assert.ok(s.stubs[lane], `${s.name}: unexpected call to ${lane}`)
    assert.ok(brief && 'question' in brief && 'mandate' in brief, 'every lane call carries a brief')
    assert.equal(brief.doubtLog, inputOf(s).facts.escalation?.doubtLog || null, 'the brief carries the resolved doubt log')
    return s.stubs[lane]
  })
  return { result, calls }
}

for (const s of scenarios) {
  test(`scenario: ${s.name}`, async () => {
    const { result, calls } = await drive(s)
    const e = s.expect
    assert.equal(result.route, e.route)
    assert.deepEqual(calls, e.calls)
    if ('by' in e) assert.equal(result.by, e.by)
    if (e.reason) assert.match(result.reason, new RegExp(e.reason))
    if (e.notReason) assert.doesNotMatch(result.reason, new RegExp(e.notReason))
    if ('human' in e) assert.equal(result.human, e.human)
    if (e.status) assert.equal(result.record.status, e.status)
    if (e.resolution) assert.equal(result.record.resolution, e.resolution)
    if (e.recommendation) assert.equal(result.record.recommendation, e.recommendation)
    if (e.doubtLog) assert.equal(result.doubt.log, e.doubtLog)
    if (e.noOptions) assert.ok(!('options' in result.record) && !('recommendation' in result.record))
    if (e.harnessBlock) assert.deepEqual(check('decision', { id: 'X-D9', at: '2026-09-28T10:00:00Z', ...result.harnessBlock }), [])
    if (result.record) assert.deepEqual(check('decision', result.record), [], 'the routed record stays a valid decision')
    if (['decided', 'proxied'].includes(result.route) && result.record) assert.ok(['source-cascade', 'resolver', 'owner-proxy'].includes(result.record.resolvedBy))
    assert.ok(ROUTES.includes(result.route))
  })
}

test('stubbed agent answers follow their lane schemas, except the ones marked invalid on purpose', () => {
  for (const s of scenarios) {
    for (const [lane, ans] of Object.entries(s.stubs)) {
      const errs = check(`lane-${lane}`, ans)
      if (s.validStubs === false) assert.notDeepEqual(errs, [], `${s.name}: ${lane} stub should be invalid`)
      else assert.deepEqual(errs, [], `${s.name}: ${lane}`)
    }
  }
})

test('inlined vocabularies equal kinds.json', () => {
  const by = v => Object.keys(kinds.kinds).filter(k => kinds.kinds[k].escalate === v).sort()
  assert.deepEqual([...NEVER].sort(), by('never'))
  assert.deepEqual([...SIGN].sort(), by('sign'))
  assert.deepEqual(MANDATES, kinds.mandates)
})

test('a chain kind never reaches an agent without a resolver hop first', () => {
  for (const kind of Object.keys(kinds.kinds).filter(k => kinds.kinds[k].escalate === 'chain')) {
    const r = route({ facts: base['with-proxy'], decision: { ...base.decision, kind } })
    assert.equal(r.route, 'pending', kind)
    assert.equal(r.next, 'resolver', kind)
  }
})

test('rendered profile facts: a declared owner proxy lets its mandate through, none parks it', async () => {
  const facts = renderFacts(FIXTURE)
  const input = { facts, decision: null, step: { mandate: 'start-next-ticket' } }
  assert.equal(route(input).next, 'owner-proxy')

  const none = renderFacts(variant(t => replaceSection(t, 'owner proxy', 'none — no unattended day run')))
  assert.equal(none.ownerProxy, null)
  let called = false
  const r = await runChain({ ...input, facts: none }, async () => { called = true })
  assert.equal(r.route, 'parked-human')
  assert.equal(called, false)

  const missing = renderFacts(variant(t => dropSection(t, 'owner proxy')))
  assert.equal(route({ ...input, facts: missing }).route, 'parked-human')
})

test('rendered profile facts: the resolver citing a declared inviolable parks without the undeclared note', () => {
  const facts = renderFacts(FIXTURE)
  const resolver = { decision: '', park: true, rationale: 'r', reversalCost: 'none', inviolable: 'weaken an access condition', awaiting: [] }
  const r = route({ facts, decision: base.decision, answers: { resolver } })
  assert.equal(r.route, 'inviolable-park')
  assert.doesNotMatch(r.reason, /not declared/)
})

function cli(input) {
  const p = spawnSync(process.execPath, [CLI, '-'], { input: JSON.stringify(input), encoding: 'utf8' })
  return { code: p.status, line: JSON.parse(p.stdout) }
}

test('CLI prints one valid script-result line and exits 0 on a routed decision', () => {
  const { code, line } = cli({ facts: base['with-proxy'], decision: base.decision })
  assert.equal(code, 0)
  assert.deepEqual(check('script-result', line, code), [])
  assert.equal(line.route, 'pending')
  assert.equal(line.next, 'resolver')
})

test('CLI reports a schema-invalid lane answer instead of routing on it', () => {
  const resolver = { decision: 'x', park: 'no', rationale: 'r', reversalCost: 'low', awaiting: [] }
  const { code, line } = cli({ facts: base['with-proxy'], decision: base.decision, answers: { resolver } })
  assert.equal(code, 0)
  assert.equal(line.route, 'invalid-answer')
  assert.equal(line.lane, 'resolver')
})

test('CLI refuses a harness block shaped as a question', () => {
  const decision = { ...base.decision, kind: 'harness-blocked' }
  const { code, line } = cli({ facts: base['with-proxy'], decision })
  assert.equal(code, 1)
  assert.deepEqual(check('script-result', line, code), [])
})

// Built from pieces so a repo-wide grep for these words finds only the profiles that own them.
const BANNED = [
  ['as', 'ia'], ['joa', 'nna'], ['nh', 'at'], ['mich', 'al'], ['drmike', 'bot'], ['mo', 'cap'], ['d1', '6'], ['d1', '1'],
  ['code', 'rabbit'], ['be-a', 'sia'], ['pt-', 'resolver'], ['physi', 'track'], ['baseline', '.json'], ['client', '-new'],
  ['sl', 'ack'], ['gm', 'ail'], ['cf', 'r 11'],
].map(p => p.join(''))

function files(p) {
  if (!existsSync(p)) return []
  if (statSync(p).isFile()) return [p]
  return readdirSync(p).flatMap(f => files(join(p, f)))
}

test('role files, routine and doc name no person, project or project path', () => {
  const targets = ['skills/flow-resolver', 'skills/flow-owner-proxy', 'docs/escalation.md', 'lib/escalation/route.mjs']
    .flatMap(t => files(join(ROOT, t)))
  assert.ok(targets.length >= 4)
  const re = new RegExp(`\\b(${BANNED.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
  for (const f of targets) {
    const hit = readFileSync(f, 'utf8').match(re)
    assert.equal(hit, null, `${f}: "${hit?.[0]}"`)
  }
})
