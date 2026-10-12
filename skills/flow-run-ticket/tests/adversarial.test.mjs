// Adversarial replay: a recorded Node-driver run (fixtures/replay/<T>.steps.json) is replayed with
// one model claim flipped per mutant. The control reaches an agent merge; no mutant may.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs, makeSim, runTicketDriver, tmpRoot } from './dryrun.mjs'
import { LIVE_IN_REPLAY } from './replay-extract.mjs'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'replay')
const TICKET = 'ABC-101'
const fixture = () => JSON.parse(readFileSync(join(FIXTURES, `${TICKET}.steps.json`), 'utf8'))

// Lanes are answered from the recording by phase and lane in order, preferring the record whose
// sub-scope (axis, dimension, finding) names the call; execs by phase, detail and occurrence.
// Anything the recording lacks falls back to the simulator default.
function replayMode(fx, root, { lane: laneOverride, exec: execOverride } = {}) {
  const load = v => JSON.parse(JSON.stringify(v).split('<ROOT>').join(root))
  const lanes = load(fx.lanes)
  for (const e of lanes) if (e.key.startsWith('plan:plan:') && e.result) e.result.planPath = join(root, 'tickets', fx.ticket, 'plan.md')
  const execs = load(fx.execs)
  const used = new Set()
  const take = (pool, pick) => {
    const hit = pool.find(e => !used.has(e) && pick(e))
    if (hit) used.add(hit)
    return hit
  }
  return {
    agent: (lane, ctx) => {
      // The recorded owner proxy answered a PR the real run had already undrafted by hand.
      const recorded = lane === 'owner-proxy' ? undefined : (() => {
        const prefix = `${ctx.phase}:${lane}:`
        const scope = ctx.detail.split(':')[0]
        const scoped = take(lanes, e => e.key.startsWith(prefix) && e.key.slice(prefix.length).split(':').at(-1) === scope)
        return (scoped || take(lanes, e => e.key === prefix) || {}).result
      })()
      const o = laneOverride ? laneOverride(lane, ctx, recorded) : undefined
      return o === undefined ? recorded : o
    },
    exec: (name, argv, ctx) => {
      const o = execOverride ? execOverride(name, argv, ctx) : undefined
      if (o !== undefined) return o
      if (LIVE_IN_REPLAY.has(name)) return undefined
      // The recorded bot never reviewed; the control needs a green bot to reach the merge.
      if (name === 'review-bot-green.mjs' || name === 'sleep') return undefined
      // Changed files come from the simulator, so a mutant can move them.
      if (ctx.detail === 'changed-files') return undefined
      const hit = take(execs, e => e.key === `${ctx.phase}:${ctx.detail}` && (name !== 'verify-claim.mjs' || (e.result && e.result.match) === argv[1]))
      return hit ? hit.result : undefined
    },
  }
}

// The recorded diff minus the plan file, which sits outside the profile's agent-merge paths and
// would send even the control to a signature.
const changedFiles = fx => fx.execs.find(e => e.key === 'gate:changed-files').result.changedFiles.filter(f => !f.startsWith('docs/plans/'))

async function replay(over = {}) {
  const fx = fixture()
  const root = tmpRoot(`adv-${TICKET}`)
  const args = buildArgs(root, { ticket: TICKET })
  if (over.args) over.args(args)
  const sim = makeSim(root, args, { ...replayMode(fx, root, over), files: changedFiles(fx), skipLaneCheck: true })
  const out = await runTicketDriver(sim)
  return { r: out.result || out, sim, fatal: out.fatal || null }
}

const merged = sim => sim.execs.some(e => e.name === 'pr-merge.mjs')
const assertNoMerge = ({ r, sim }) => {
  assert.notEqual(r.status, 'merged', `run merged: ${r.reason}`)
  assert.equal(merged(sim), false, 'pr-merge.mjs ran')
}

test('control: the recorded ABC-101 run with a green review bot reaches an agent merge', async () => {
  const { r, sim, fatal } = await replay()
  assert.equal(fatal, null)
  assert.equal(r.status, 'merged', r.reason)
  assert.ok(merged(sim))
})

const recordedHead = '7174a503ef8000d4a72b2bbe9eb1d228b44e916c'
const highFinding = id => ({ id, axis: 'standards', severity: 'high', summary: 'a high finding planted by the mutant', locations: ['client-new/src/features/configuration/values.ts:1'] })
// The first standards axis raises one high finding, so a fix round and a re-verify follow.
const withPlantedFinding = (lane, ctx, recorded) => {
  if (lane === 'review-axis' && ctx.detail === 'standards' && recorded) return { ...recorded, findings: [...recorded.findings, highFinding('ADV-1')] }
  return undefined
}
const reverifyResolves = (lane, ctx) => lane === 'review-axis' && ctx.detail === 'standards:reverify'
  ? { axis: 'standards', reviewedSha: ctx.head, skipped: false, findings: [], report: 'fixed', resolved: [{ id: 'ADV-1', evidence: 'test added' }], stillOpen: [], awaiting: [] }
  : undefined
const both = (...fs) => (...a) => { for (const f of fs) { const o = f(...a); if (o !== undefined) return o } return undefined }

test('control: a planted high finding that the fix round resolves and the re-verify confirms still merges', async () => {
  const { r, sim } = await replay({ lane: both(withPlantedFinding, reverifyResolves) })
  assert.equal(r.status, 'merged', r.reason)
  assert.ok(sim.execs.some(e => e.name === 'scope-fence.mjs'), 'the fix round ran')
})

test('G1: a run whose profile declares zero gates never reaches an agent merge', async () => {
  assertNoMerge(await replay({ args: a => { a.facts.gates = [] } }))
})

test('G2a: changes outside the plan\'s authorised files block the merge even when no fix round ran', async () => {
  const lane = (l, ctx, recorded) => l === 'plan' && recorded ? { ...recorded, authorisedFiles: ['client-new/src/features/other/'] } : undefined
  assertNoMerge(await replay({ lane }))
})

test('G2b: a scope fence that errors is blocked, never read as "nothing outside scope"', async () => {
  const exec = name => name === 'scope-fence.mjs' ? { status: 'error', kind: 'script-error', reason: 'git diff --name-only failed' } : undefined
  assertNoMerge(await replay({ lane: both(withPlantedFinding, reverifyResolves), exec }))
})

test('G2c: a plan whose authorised files fence nothing parks before any code is written', async () => {
  for (const fence of [[], ['**'], ['/']]) {
    const lane = (l, ctx, recorded) => l === 'plan' && recorded ? { ...recorded, authorisedFiles: fence } : undefined
    const run = await replay({ lane })
    assertNoMerge(run)
    assert.match(run.r.reason || '', /^plan: authorisedFiles/, JSON.stringify(fence))
  }
})

test('G3: a finding the re-verify output leaves out stays open', async () => {
  const silent = (lane, ctx) => lane === 'review-axis' && ctx.detail === 'standards:reverify'
    ? { axis: 'standards', reviewedSha: ctx.head, skipped: false, findings: [], report: 'looked again', resolved: [], stillOpen: [], awaiting: [] }
    : undefined
  assertNoMerge(await replay({ lane: both(withPlantedFinding, silent) }))
})

// The lane echoes the SHA its brief named, but the worktree head moved while it ran: the first head
// measured in the review phase after that lane reads another commit, once.
function headMovedDuring(detail) {
  let moved = false
  return {
    lane: (lane, ctx) => { if (lane === 'review-axis' && ctx.detail === detail) moved = true; return undefined },
    exec: (name, argv, ctx) => {
      if (name !== 'head-truth.mjs' || !moved || ctx.phase !== 'review') return undefined
      moved = false
      return { status: 'ok', headSha: 'feedface00000000000000000000000000000000', clean: true, dirty: [], expect: null, matchesExpect: null, descendsFromBase: true }
    },
  }
}

test('G3b: a review axis that echoes the right SHA while the worktree head moved under it is not a review of this head', async () => {
  const m = headMovedDuring('standards')
  assertNoMerge(await replay({ lane: both(m.lane, (l, ctx, recorded) => l === 'review-axis' && ctx.detail === 'standards' && recorded ? { ...recorded, reviewedSha: ctx.head } : undefined), exec: m.exec }))
})

test('G3c: a re-verify that echoes the right SHA while the worktree head moved under it leaves every finding it was asked about open', async () => {
  const m = headMovedDuring('standards:reverify')
  assertNoMerge(await replay({ lane: both(m.lane, withPlantedFinding, reverifyResolves), exec: m.exec }))
})

test('G4a: the head the implement lane claims is not the head the worktree holds', async () => {
  const exec = name => name === 'head-truth.mjs' ? { status: 'ok', headSha: 'feedface00000000000000000000000000000000', clean: true, dirty: [], descendsFromBase: true } : undefined
  const r = await replay({ exec })
  assertNoMerge(r)
  assert.notEqual(r.r.headSha, recordedHead, 'the claimed head was used')
})

test('G4b: a worktree with uncommitted changes never reaches an agent merge', async () => {
  const exec = (name, argv, ctx) => name === 'head-truth.mjs' ? { status: 'ok', headSha: ctx.head, clean: false, dirty: ['client-new/src/features/configuration/values.ts'], descendsFromBase: true } : undefined
  assertNoMerge(await replay({ exec }))
})

test('G5: a confirmed high confidence finding is not dropped by a single refuted re-verify', { todo: 'deterministic re-verify of confidence findings is a later slice' }, async () => {
  const lane = (l, ctx, recorded) => {
    if (l === 'confidence-dim' && ctx.detail === 'correctness' && recorded) return { ...recorded, findings: [...recorded.findings, { ...highFinding('ADV-C1'), axis: 'correctness', source: 'code' }] }
    if (l === 'reverify') return { findingId: ctx.detail, verdict: 'refuted', rationale: 'not reproducible', awaiting: [] }
    return undefined
  }
  assertNoMerge(await replay({ lane }))
})
