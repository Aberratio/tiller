import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildArgs, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { calibration, verdictsPath } from '../../journal/verdicts.mjs'

const ledger = root => existsSync(verdictsPath(root, 'ABC-1'))
  ? readFileSync(verdictsPath(root, 'ABC-1'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const run = async (tag, hooks) => {
  const root = tmpRoot(`verdicts-${tag}`)
  const sim = makeSim(root, buildArgs(root), hooks)
  const r = await runTicketDriver(sim)
  return { root, r, lines: ledger(root) }
}
const verdict = (lines, lane, field) => lines.find(l => l.kind === 'verdict' && l.lane === lane && l.field === field)
const overturnsOf = (lines, v) => lines.filter(l => l.kind === 'overturned' && v && l.verdictId === v.id)

test('a clean run records the premise, test and head verdicts with the model that gave them, and no overturn', async () => {
  const { lines, r } = await run('clean')
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const premise = verdict(lines, 'premise', 'verdict')
  assert.equal(premise.value, 'holds')
  assert.equal(premise.model, 'sonnet')
  assert.equal(premise.tier, 'T2')
  assert.equal(verdict(lines, 'implement', 'testResult').value, 'pass')
  assert.ok(verdict(lines, 'implement', 'headSha'))
  assert.equal(lines.filter(l => l.kind === 'overturned').length, 0)
})

test('a "pass" the profile\'s test command contradicts is overturned by verify-claim', async () => {
  let calls = 0
  const { lines } = await run('claim', {
    exec: (name, argv) => name === 'verify-claim.mjs' && !argv.includes('--section') && calls++ === 0
      ? { status: 'ok', command: 'npm test', claim: 'pass', actual: 'fail', exitCode: 1, mismatch: true } : undefined,
  })
  const v = verdict(lines, 'implement', 'testResult')
  const o = overturnsOf(lines, v)
  assert.equal(o.length, 1)
  assert.equal(o[0].by, 'script')
  assert.equal(o[0].source, 'verify-claim')
  assert.equal(calibration(lines)['implement|opus'].overturns >= 1, true)
})

test('a premise that holds and a plan that finds it falsified overturn the premise lane', async () => {
  const { lines } = await run('premise', {
    agent: lane => lane === 'plan' ? { ok: true, ticketKind: 'code', premiseVerdict: 'falsified', premiseEvidence: 'no such code', planPath: 'x', planSummary: 's', authorisedFiles: ['src/'], awaiting: [] } : undefined,
  })
  const o = overturnsOf(lines, verdict(lines, 'premise', 'verdict'))
  assert.equal(o.length, 1)
  assert.equal(o[0].source, 'plan')
})

test('a confidence finding the reverify lane refutes is overturned', async () => {
  let once = 0
  const { lines } = await run('confidence', {
    agent: (lane, ctx) => lane === 'confidence-dim' && ctx.detail === 'correctness' && once++ === 0
      ? { dimension: 'correctness', reviewedSha: ctx.head, findings: [{ id: 'C1', axis: 'correctness', severity: 'high', summary: 'off by one', locations: [] }], report: 'r', acCoverage: [], awaiting: [] } : undefined,
  })
  const v = verdict(lines, 'confidence-dim', 'finding:C1')
  assert.equal(v.value, 'high')
  const o = overturnsOf(lines, v)
  assert.equal(o.length, 1)
  assert.equal(o[0].source, 'reverify')
})

test('a head the worktree does not carry overturns the implement lane\'s headSha', async () => {
  let n = 0
  const { lines } = await run('head', {
    exec: (name, argv) => name === 'head-truth.mjs' && argv.includes('--expect') && n++ === 0
      ? { status: 'ok', headSha: 'f'.repeat(40), matchesExpect: false, clean: true, descendsFromBase: true } : undefined,
  })
  const o = overturnsOf(lines, verdict(lines, 'implement', 'headSha'))
  assert.equal(o.length, 1)
  assert.equal(o[0].source, 'head-truth')
})
