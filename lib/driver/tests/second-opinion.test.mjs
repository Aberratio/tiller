// The second opinion in the review phase: called once per run when two axes disagree on a file or
// the fix rounds run out, routed away from the model that raised the contested findings, able to
// downgrade a finding only with evidence, never to raise one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildArgs, decisionsOf, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { journalPath, readJournal } from '../journal.mjs'
import { verdictsPath } from '../../journal/verdicts.mjs'
import { check } from '../../contract/validate.mjs'

const FILE = 'server-new/a.ts'
const high = { id: 'STD-1', axis: 'standards', severity: 'high', summary: 'unbounded buffer', locations: [`${FILE}:12`] }

// The simulator has no default for the second-opinion lane: its calls are answered here, before
// the simulator sees them, and recorded with the request that reached them.
function withSecondOpinion(sim, reply) {
  const seen = []
  const inner = sim.runtime.lane
  sim.runtime.lane = async req => {
    if (!/:second-opinion:/.test(req.label)) return inner(req)
    seen.push(req)
    const result = reply(req)
    if (result) assert.deepEqual(check('lane-second-opinion', result), [], 'stub violates lane-second-opinion')
    return { result, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, costUsd: 0, durationMs: 0, model: req.model }
  }
  return seen
}

const opinion = (req, verdicts) => ({ reviewedSha: (/reviewedSha ([0-9a-f]{7,40})/.exec(req.prompt) || [])[1] || 'ba5e000', verdicts, report: 'second opinion', awaiting: [] })
const laneLines = (root, lane) => readJournal(journalPath(root, 'ABC-1')).filter(l => l.lane === lane)

test('axes disagree on a file: one second opinion, routed away from the axis model, and an evidenced downgrade closes the finding', async () => {
  const root = tmpRoot('so-disagree')
  const args = buildArgs(root)
  const sim = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis' && ctx.detail === 'standards' ? { findings: [high] } : undefined })
  const seen = withSecondOpinion(sim, req => opinion(req, [{ id: 'STD-1', axis: 'standards', verdict: 'downgrade', severity: 'medium', reason: 'the buffer is bounded by the caller', evidence: `${FILE}:12 const buf = new Array(MAX)` }]))
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(seen.length, 1)
  assert.match(seen[0].prompt, /STD-1/)
  assert.match(seen[0].label, /^review:second-opinion:T3/)
  assert.ok(!sim.labels.some(l => l.split(':')[1] === 'fix'), `no fix round after the downgrade: ${sim.labels.join(' ')}`)
  const [line] = laneLines(root, 'second-opinion')
  assert.equal(line.outcome, 'ok')
  assert.equal(line.route.lane, 'second-opinion')
  // Day one admits one model at T3, so the contested model gives the opinion and says so.
  assert.equal(line.route.sameModel, true)
  assert.equal(line.route.model, args.tiers.T3)
  assert.deepEqual(check('route-decision', line.route), [])
  const verdicts = readFileSync(verdictsPath(root, 'ABC-1'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const raised = verdicts.find(v => v.kind === 'verdict' && v.lane === 'review-axis' && v.field === 'finding:STD-1')
  assert.ok(raised, 'the axis finding is a verdict on the ledger')
  const overturned = verdicts.find(v => v.kind === 'overturned' && v.verdictId === raised.id)
  assert.ok(overturned, 'the downgrade overturns it')
  assert.equal(overturned.source, 'second-opinion')
})

test('a downgrade without evidence is refuted: the lane is marked invalid, nothing is downgraded, the fix round runs', async () => {
  const root = tmpRoot('so-no-evidence')
  const args = buildArgs(root)
  const sim = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis' && ctx.detail === 'standards' ? { findings: [high] } : undefined })
  const seen = withSecondOpinion(sim, req => opinion(req, [{ id: 'STD-1', axis: 'standards', verdict: 'downgrade', severity: 'low', reason: 'looks fine', evidence: '' }]))
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(seen.length, 1, 'no other admitted model at T3: the refuted lane parks instead of climbing')
  assert.deepEqual(laneLines(root, 'second-opinion').map(l => l.outcome), ['invalid'])
  assert.ok(sim.labels.some(l => l.split(':')[1] === 'fix'), sim.labels.join(' '))
})

test('a downgrade never raises: a higher severity is ignored, and the opinion is spent for the run', async () => {
  const root = tmpRoot('so-upgrade')
  const args = buildArgs(root)
  // The standards axis keeps its finding open through every re-verify, so the fix rounds run out.
  const sim = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis' && ctx.detail.startsWith('standards') ? { findings: [high], resolved: [], stillOpen: ['STD-1'] } : undefined })
  const seen = withSecondOpinion(sim, req => opinion(req, [{ id: 'STD-1', axis: 'standards', verdict: 'downgrade', severity: 'blocker', reason: 'worse than raised', evidence: `${FILE}:12` }]))
  await runTicketDriver(sim)
  assert.equal(seen.length, 1, 'the cap is one per run: disagreement and exhaustion do not each get one')
  assert.equal(sim.labels.filter(l => l.split(':')[1] === 'fix').length, args.caps.fixRounds)
  const split = decisionsOf(root).find(d => d.kind === 'split')
  assert.ok(split, 'the exhausted fix rounds still end in a split decision')
  assert.match(split.question, /STD-1/)
  assert.ok(!readFileSync(verdictsPath(root, 'ABC-1'), 'utf8').includes('"kind":"overturned"'), 'nothing is overturned')
})

test('fix rounds exhausted with no earlier disagreement: the second opinion is asked before the split', async () => {
  const root = tmpRoot('so-exhausted')
  const args = buildArgs(root)
  // Both axes raise on the same file, so there is no disagreement; the finding outlives every fix round.
  const spec = { ...high, id: 'SPEC-1', axis: 'spec', severity: 'high', summary: 'field missing' }
  const sim = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis'
    ? (ctx.detail.startsWith('standards') ? { findings: [high], resolved: [], stillOpen: ['STD-1'] } : { findings: [spec], resolved: [], stillOpen: ['SPEC-1'] })
    : undefined })
  const seen = withSecondOpinion(sim, req => opinion(req, [
    { id: 'STD-1', axis: 'standards', verdict: 'downgrade', severity: 'low', reason: 'bounded', evidence: `${FILE}:12 const buf = new Array(MAX)` },
    { id: 'SPEC-1', axis: 'spec', verdict: 'uphold', severity: 'high', reason: 'the spec names the field', evidence: 'spec line 4' },
  ]))
  await runTicketDriver(sim)
  assert.equal(seen.length, 1)
  assert.equal(sim.labels.filter(l => l.split(':')[1] === 'fix').length, args.caps.fixRounds, 'the opinion comes after the rounds, not instead of them')
  const split = decisionsOf(root).find(d => d.kind === 'split')
  assert.ok(split)
  assert.match(split.question, /SPEC-1/)
  assert.doesNotMatch(split.question, /STD-1/, 'the downgraded finding is no longer open')
})

test('a clean review asks for no second opinion', async () => {
  const root = tmpRoot('so-none')
  const sim = makeSim(root, buildArgs(root))
  const seen = withSecondOpinion(sim, () => { throw new Error('unexpected second opinion') })
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(seen.length, 0)
})
