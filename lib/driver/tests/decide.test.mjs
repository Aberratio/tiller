// c.decide never pads a decision: a request that fails the linter gets one repair round when the caller offers
// one, and is otherwise recorded with its violations listed instead of placeholder options.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildArgs, decisionsOf, makeSim, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { createContext } from '../core.mjs'

const GOOD = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixtures/hitl-request/valid-merge-ask.json', import.meta.url)), 'utf8'))
const ctx = tag => {
  const root = tmpRoot(tag)
  const args = buildArgs(root)
  const c = createContext(args, makeSim(root, args).runtime)
  c.cur = 'plan'
  return { root, c }
}
const PADDING = /no option offered|not stated by the lane/

test('a lane item with no options and no reversal cost is recorded with its violations, never padded', async () => {
  const { root, c } = ctx('decide-nopad')
  const r = await c.decide({ kind: 'question', question: 'no alternative was offered', why: 'the lane found only one path', blocks: 'closing this decision', options: [], recommendation: 'proceed' })
  await c.flush()
  assert.equal(r.ok, false)
  const [d] = decisionsOf(root)
  assert.ok(d, 'still recorded, so a person learns a decision is open')
  assert.doesNotMatch(JSON.stringify(d), PADDING)
  assert.equal(d.options, undefined)
  assert.equal(d.reversalCost, undefined)
  for (const rule of ['L01', 'L02', 'L15']) assert.ok(d.violations.some(v => v.startsWith(rule)), `${rule} in ${d.violations}`)
})

test('legacy free-text fields are linted as they are, and the run continues', async () => {
  const { root, c } = ctx('decide-legacy')
  const r = await c.decide({ kind: 'gate-red', question: 'Merge refused: conflict.', why: 'pr-merge did not merge', options: ['retry in a fresh run', 'a human merges'], recommendation: 'retry in a fresh run', reversalCost: 'low' })
  await c.flush()
  assert.equal(r.ok, false)
  const [d] = decisionsOf(root)
  assert.deepEqual(d.options, ['retry in a fresh run', 'a human merges'], 'what the caller said is kept as said')
  assert.ok(d.violations.some(v => v.startsWith('L03')), d.violations.join('\n'))
  assert.equal(d.request, undefined, 'an unreadable request is never stored as one')
})

test('a request that passes the linter is stored and the machine fields come from it', async () => {
  const { root, c } = ctx('decide-good')
  const r = await c.decide({ kind: 'gate-red', blocks: 'merge', request: GOOD })
  await c.flush()
  assert.equal(r.ok, true, JSON.stringify(r))
  const [d] = decisionsOf(root)
  assert.deepEqual(d.request, GOOD)
  assert.equal(d.violations, undefined)
  assert.equal(d.question, GOOD.ask)
  assert.equal(d.why, GOOD.situation)
  assert.deepEqual(d.options, ['Fix in a fresh run', 'Take over the branch yourself'])
  assert.equal(d.recommendation, 'Fix in a fresh run')
  assert.equal(d.reversalCost, 'low: Stop the run; the pull request stays open.')
})

test('one repair round through the caller\'s hook, with the violations handed over', async () => {
  const { root, c } = ctx('decide-repair')
  const bad = { ...structuredClone(GOOD), situation: 'ci-fix cap reached' }
  const calls = []
  const r = await c.decide({ kind: 'ci-red', blocks: 'merge', request: bad, repair: async v => { calls.push(v); return GOOD } })
  await c.flush()
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].some(v => v.rule === 'L16'), JSON.stringify(calls[0]))
  assert.deepEqual(decisionsOf(root)[0].request, GOOD)
})

test('a repair that still fails is not retried: recorded with the repaired attempt\'s violations', async () => {
  const { root, c } = ctx('decide-repair-fails')
  const bad = { ...structuredClone(GOOD), situation: 'ci-fix cap reached' }
  let calls = 0
  const r = await c.decide({ kind: 'ci-red', blocks: 'merge', request: bad, repair: async () => { calls += 1; return { ...bad, ask: 'TC3 inconclusive?' } } })
  await c.flush()
  assert.equal(r.ok, false)
  assert.equal(calls, 1)
  const [d] = decisionsOf(root)
  assert.ok(d.violations.some(v => v.startsWith('L09')), d.violations.join('\n'))
  assert.equal(d.request, undefined)
  assert.doesNotMatch(JSON.stringify(d), PADDING)
})

test('harness-blocked is not linted: nobody is asked to choose', async () => {
  const { root, c } = ctx('decide-hb')
  await c.decide({ kind: 'harness-blocked', question: 'gh pr merge refused', why: 'Permission denied: Bash(gh pr merge:*)', blocks: 'merge' })
  await c.flush()
  const [d] = decisionsOf(root)
  assert.equal(d.violations, undefined)
  assert.equal(d.options, undefined)
})
