import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs, decisionsOf, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { journalPath, readJournal, report } from '../journal.mjs'
import { drive } from '../drive.mjs'
import { Stop, clipWords, reasonOf } from '../core.mjs'
import { measuredHead } from '../phases.mjs'

const lanesOf = sim => sim.labels.map(l => l.split(':')[1])
const phasesOf = sim => sim.labels.map(l => l.split(':')[0])
const stepsOf = root => readFileSync(join(root, 'tickets', 'ABC-1', 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))

test('killed during implement, the rerun calls no start, premise or plan lane and no worktree script', async () => {
  const root = tmpRoot('drv-kill-impl')
  const args = buildArgs(root)
  const first = makeSim(root, args, { agent: lane => lane === 'implement' ? { hang: true } : undefined })
  const killed = await runTicketDriver(first)
  assert.ok(killed.killed, JSON.stringify(killed))
  assert.ok(lanesOf(first).includes('plan'))

  const second = makeSim(root, args)
  const r = await runTicketDriver(second)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(phasesOf(second)[0], 'implement', second.labels.join(' '))
  assert.ok(!phasesOf(second).some(p => ['start', 'premise', 'plan'].includes(p)), second.labels.join(' '))
  assert.ok(!second.execs.some(e => e.name === 'worktree.mjs'), 'no second worktree')
  assert.ok(second.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'implement'))
})

test('killed after the plan lane returned but before its checkpoint, the rerun replays the plan from the step log', async () => {
  const root = tmpRoot('drv-kill-plan')
  const args = buildArgs(root)
  const first = makeSim(root, args, { exec: (name, argv) => name === 'state.mjs' && argv[0] === 'phase-done' && argv[2] === 'plan' ? { hang: true } : undefined })
  const killed = await runTicketDriver(first)
  assert.ok(killed.killed)
  assert.ok(lanesOf(first).includes('plan'))

  const second = makeSim(root, args)
  const r = await runTicketDriver(second)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.ok(!lanesOf(second).includes('plan'), 'the plan lane is not called again')
  assert.ok(lanesOf(second).includes('implement'))
  const plan = readJournal(journalPath(root, 'ABC-1')).filter(l => l.lane === 'plan')
  assert.deepEqual(plan.map(l => l.replayed), [false, true])
  assert.equal(stepsOf(root).filter(s => s.step === 'plan/lane:plan#1').length, 1, 'the replay writes no second record')
})

test('every lane call and every exec call leaves one journal line of the fixed shape', async () => {
  const root = tmpRoot('drv-journal')
  const sim = makeSim(root, buildArgs(root))
  const r = await runTicketDriver(sim)
  const lines = readJournal(journalPath(root, 'ABC-1'))
  const lanes = lines.filter(l => l.kind !== 'exec')
  const execs = lines.filter(l => l.kind === 'exec')
  assert.equal(lanes.length, sim.labels.length)
  assert.equal(lanes.length, r.calls.length)
  assert.equal(execs.length, sim.execs.length)
  for (const l of lanes) {
    assert.deepEqual(Object.keys(l), ['runId', 'phase', 'label', 'lane', 'model', 'outcome', 'durationMs', 'costUsd', 'usage', 'replayed', 'at', 'route'])
    assert.deepEqual(Object.keys(l.usage), ['input', 'output', 'cacheRead', 'cacheCreate'])
    assert.match(l.label, /^[a-z-]+:[a-z-]+:T[0-3](:.+)?$/)
    assert.equal(l.label.split(':')[0], l.phase)
    assert.equal(l.replayed, false)
  }
  for (const l of execs) {
    assert.deepEqual(Object.keys(l), ['runId', 'phase', 'label', 'kind', 'script', 'exitCode', 'durationMs', 'replayed'])
    assert.equal(typeof l.exitCode, 'number')
  }
  assert.equal(new Set(lines.map(l => l.runId)).size, 1)
  const t3 = lanes.filter(l => l.label.split(':')[2] === 'T3')
  assert.ok(t3.length && t3.every(l => l.model === buildArgs(root).tiers.T3))
  assert.match(report(lines).text, /\| implement \| 0\.0k \/ 0\.00M \|/)
})

test('an exec call hands its argv to the runtime verbatim, with no model in the path', async () => {
  const root = tmpRoot('drv-argv')
  const sim = makeSim(root, buildArgs(root))
  await runTicketDriver(sim)
  const wt = sim.execs.find(e => e.name === 'worktree.mjs')
  assert.equal(wt.argv[0], 'new')
  assert.deepEqual(wt.argv.filter((a, i) => i % 2 === 1), ['--repo', '--branch', '--base', '--command'])
  assert.equal(wt.argv.at(-1), sim.args.facts.worktreeCreate, 'the profile worktree command reaches worktree.mjs verbatim')
  assert.ok(!sim.labels.some(l => l.split(':')[1] === 'exec'), 'no exec lane is dispatched')
  assert.deepEqual(sim.labels.filter(l => l.startsWith('start:')), [], 'start calls no lane at all')
})

test('resume re-runs exec calls (11): killed in the review fan-out after one axis returned, the rerun does not call that axis again', async () => {
  const root = tmpRoot('drv-kill-review')
  const args = buildArgs(root)
  const first = makeSim(root, args, { agent: (lane, ctx) => lane === 'review-axis' && ctx.detail === 'spec' ? { hang: true } : undefined })
  const killed = await runTicketDriver(first)
  assert.ok(killed.killed, JSON.stringify(killed))
  const done = () => stepsOf(root).some(s => s.step === 'review/axis:standards/lane:review-axis#1')
  for (let i = 0; i < 200 && !done(); i++) await new Promise(r => setTimeout(r, 5))
  assert.ok(done(), 'the standards axis returned before the kill')

  // The worktree outlives the kill, so the rerun measures the head the first run left in it.
  const second = makeSim(root, args)
  Object.assign(second.heads, first.heads)
  const r = await runTicketDriver(second)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  const axes = second.labels.filter(l => l.startsWith('review:review-axis'))
  assert.deepEqual(axes, ['review:review-axis:T3:spec'], second.labels.join(' '))
  assert.ok(!second.execs.some(e => e.name === 'verify-claim.mjs' && e.label.startsWith('review:')), 'verify-claim and the static checks replay too')
  assert.ok(second.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'review'))
})

test('killed during the second CI wait, the rerun replays the settled first wait and polls on from the second', async () => {
  const root = tmpRoot('drv-kill-poll')
  const args = buildArgs(root)
  let polls = 0
  const first = makeSim(root, args, {
    exec: (name, argv) => name !== 'wait-ci.mjs' ? undefined : polls++ === 0 ? { status: 'pending', sha: argv[3] } : { hang: true },
  })
  const killed = await runTicketDriver(first)
  assert.ok(killed.killed, JSON.stringify(killed))
  assert.ok(stepsOf(root).some(s => s.step === 'ci/exec:wait-ci#1' && s.result.result.status === 'pending'))

  let seen = 0
  const second = makeSim(root, args, { exec: name => { if (name === 'wait-ci.mjs') seen++ } })
  const r = await runTicketDriver(second)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(seen, 1, 'only the unfinished wait runs again')
  assert.ok(!lanesOf(second).includes('pr-description'), 'the pr phase is not redone')
  assert.ok(second.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'review-bot'))
})

const harnessAxis = (lane, ctx) => lane === 'review-axis' && ctx.detail === 'spec'
  ? { findings: [{ id: 'SPEC-9', axis: 'spec', severity: 'blocker', summary: 'verify-claim could not run the test command', locations: [], source: 'verify-claim' }] }
  : undefined

test('a resume after review keeps the review\'s harness findings: killed in confidence, the gate still holds on them', async () => {
  const root = tmpRoot('drv-held-conf')
  const args = buildArgs(root)
  const first = makeSim(root, args, { agent: (lane, ctx) => lane === 'confidence-dim' ? { hang: true } : harnessAxis(lane, ctx) })
  assert.ok((await runTicketDriver(first)).killed)

  const second = makeSim(root, args)
  const r = await runTicketDriver(second)
  assert.ok(!lanesOf(second).includes('review-axis'), 'review is not redone')
  const held = r.gate.conditions.find(x => x.name === 'harness')
  assert.equal(held.state, 'blocked')
  assert.match(held.evidence, /SPEC-9/)
  assert.ok(!second.execs.some(e => e.name === 'pr-merge.mjs'))
})

test('a resume after review keeps its static-check results: killed in the gate, the repin axes are still told what the checks cover', async () => {
  const root = tmpRoot('drv-statics-gate')
  const args = buildArgs(root)
  let dimCalls = 0
  const confidenceFix = (lane, ctx) => {
    if (lane === 'confidence-dim' && ctx.detail === 'correctness') { dimCalls++; return { findings: dimCalls === 1 ? [{ id: 'C1', axis: 'correctness', severity: 'high', summary: 'off-by-one', locations: ['a.ts:1'] }] : [] } }
    if (lane === 'reverify') return { findingId: ctx.detail, verdict: 'confirmed' }
    return undefined
  }
  const first = makeSim(root, args, { agent: confidenceFix, exec: name => name === 'diff-since-review.mjs' ? { hang: true } : undefined })
  assert.ok((await runTicketDriver(first)).killed)

  const prompts = []
  const second = makeSim(root, args, { agent: (lane, ctx) => { if (lane === 'review-axis') prompts.push(ctx.prompt) } })
  await runTicketDriver(second)
  assert.ok(!lanesOf(second).includes('confidence-dim'), 'confidence is not redone')
  assert.equal(prompts.length, 2, second.labels.join(' '))
  for (const p of prompts) assert.match(p, /Static checks already run on /)
})

test('a usage-limit pause mid fan-out, then a relaunch: finished phases and finished dimensions are not dispatched again, and the run ends terminal', async () => {
  const root = tmpRoot('drv-usage')
  const args = buildArgs(root)
  const first = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'confidence-dim' && ctx.detail === 'correctness' ? { throw: 'You have hit your usage limit. Limit resets at 2026-09-28T23:00:00Z' } : undefined,
  })
  const r1 = await runTicketDriver(first)
  assert.equal(r1.status, 'paused-usage', JSON.stringify(r1))
  const run = () => JSON.parse(readFileSync(join(root, 'tickets', 'ABC-1', 'run.json'), 'utf8'))
  assert.equal(run().status, 'paused-usage')
  const finished = stepsOf(root).map(s => /^confidence\/dim:([a-z-]+)\/lane:confidence-dim#1$/.exec(s.step)).filter(Boolean).map(m => m[1])
  assert.ok(finished.length > 0 && !finished.includes('correctness'), finished.join(' '))

  const second = makeSim(root, args)
  const r2 = await runTicketDriver(second)
  assert.equal(r2.status, 'merged', JSON.stringify(r2))
  assert.equal(run().status, 'merged')
  const lanes = lanesOf(second)
  for (const l of ['premise', 'plan', 'implement', 'review-axis', 'pr-description']) assert.ok(!lanes.includes(l), `${l} not re-dispatched`)
  const dims = second.labels.filter(l => l.startsWith('confidence:confidence-dim')).map(l => l.split(':')[3])
  assert.ok(dims.includes('correctness'))
  for (const d of finished) assert.ok(!dims.includes(d), `${d} replayed from the step log, not dispatched`)
  assert.ok(second.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'logs'))
})

test('a supervised child never holds an outward-channel tool: every lane the driver calls gets the args disallowedTools', async () => {
  const root = tmpRoot('drv-disallow')
  const args = buildArgs(root)
  assert.ok(args.disallowedTools.includes('mcp__claude_ai_Slack__slack_send_message'))
  const sim = makeSim(root, args)
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.ok(sim.laneOpts.length > 5)
  for (const o of sim.laneOpts) assert.deepEqual(o.disallowedTools, args.disallowedTools, o.label)
})

test('a plan that corrects the premise returns its evidence as a string, as lane-plan.json says, and the run parks on the premise decision instead of dying (ABC-8716)', async () => {
  const root = tmpRoot('drv-plan-corrected')
  const args = buildArgs(root)
  const sim = makeSim(root, args, { agent: lane => lane === 'plan'
    ? { ok: true, planPath: 'docs/plans/p.md', planSummary: 's', ticketKind: 'code', premiseVerdict: 'corrected-without-oracle', premiseEvidence: 'one screen already refuses', authorisedFiles: ['src/'], awaiting: [] }
    : undefined })
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.match(r.reason, /premise corrected-without-oracle/)
  const d = decisionsOf(root)
  assert.equal(d.length, 1)
  assert.equal(d[0].kind, 'premise')
  assert.equal(d[0].why, 'one screen already refuses')
})

// ABC-8846 (2026-10-02): every resume died right after the logs phase with reason "[object Object]".
// The log-prose lane was parked as harness-blocked; the Stop it raised escaped the logs scope.
const refusedProse = { agent: lane => lane === 'log-prose' ? { throw: 'Permission to use Bash has been denied' } : undefined }

test('ABC-8846 defect 1: a log-prose lane refused twice does not crash the run; it keeps its status and the logs checkpoint lands', async () => {
  const root = tmpRoot('drv-logs-refused')
  const sim = makeSim(root, buildArgs(root), refusedProse)
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
  assert.equal(sim.labels.filter(l => l.startsWith('logs:log-prose')).length, 2, sim.labels.join(' '))
  assert.ok(sim.execs.some(e => e.name === 'state.mjs' && e.argv[0] === 'phase-done' && e.argv[2] === 'logs'), 'the terminal status still reaches run.json')
})

test('ABC-8846 defect 1: a usage limit in the log-prose lane pauses the run instead of crashing it', async () => {
  const root = tmpRoot('drv-logs-usage')
  const sim = makeSim(root, buildArgs(root), { agent: lane => lane === 'log-prose' ? { throw: 'You have hit your usage limit. Limit resets at 2026-09-28T23:00:00Z' } : undefined })
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'paused-usage', JSON.stringify(r))
})

test('ABC-8846 defect 1: a thrown value that is not an Error still yields a readable reason', async () => {
  const root = tmpRoot('drv-plain-throw')
  const sim = makeSim(root, buildArgs(root))
  const runtime = { ...sim.runtime, exec: async () => { throw { code: 'EPIPE', detail: 'stdout closed' } } }
  const { result, fatal } = await drive(sim.args, runtime)
  assert.ok(fatal)
  assert.equal(result.status, 'died')
  assert.match(result.reason, /EPIPE/)
  assert.match(result.reason, /stdout closed/)
})

test('ABC-8846 defect 1: reasonOf names an Error, a Stop, a plain object and a bare value', () => {
  assert.equal(reasonOf(new TypeError('x is undefined')), 'TypeError: x is undefined')
  assert.equal(reasonOf(new Stop('parked', 'harness-blocked: denied')), 'parked: harness-blocked: denied')
  assert.equal(reasonOf({ code: 'EPIPE' }), '{"code":"EPIPE"}')
  assert.equal(reasonOf('plain text'), 'plain text')
  assert.equal(reasonOf(undefined), 'undefined')
  assert.doesNotMatch(reasonOf({ toString: undefined, a: 1 }), /\[object Object\]/)
})

test('clipWords leaves short text alone and cuts long text at a word boundary with an ellipsis', () => {
  assert.equal(clipWords('short reason', 200), 'short reason')
  assert.equal(clipWords('alpha beta gamma', 12), 'alpha beta…')
  assert.equal(clipWords('abcdefghij', 4), 'abcd…', 'a single long word is still cut')
  assert.equal(clipWords(null), '')
})

// ABC-8846 implement lane #2 (steps.jsonl line 17): ok:true, eight commits, green gates, and one
// harness-blocked awaiting item describing the test container's git, plus prose that quotes an
// earlier session's "harness-blocked" claim. It was journaled harness-blocked twice and parked.
const finishedWithEnvNote = why => (lane, ctx) => lane === 'implement' ? {
  ok: true, headSha: ctx.nextSha(), commits: ['efceddaf feat: a', '0bb83b70 test: b'], testCommand: 'make test', testResult: 'pass',
  notes: 'The previous session\'s ledger entry claiming no frontend gate could run was wrong. That false "harness-blocked" claim had masked 19 failures; all are fixed.',
  awaiting: [{ kind: 'harness-blocked', question: 'Container cannot run git', why, blocks: 'three frontend test files' }],
} : undefined

// A quoted refusal on a finished lane is not the lane's to park on, but it does hold the gate.
for (const [what, why, status] of [
  ['an environment note', "In the container: `spawnSync git ENOENT`, and after installing git, `fatal: not a git repository` - the worktree's .git is a file pointing at /repo/.git/worktrees/x, which is not mounted", 'merged'],
  ['a literally quoted refusal', 'Permission to use Bash has been denied', 'parked'],
]) {
  test(`ABC-8846 defect 2: a lane that returns ok:true with ${what} filed as harness-blocked is recorded ok, run once, and the lane never parks the run`, async () => {
    const root = tmpRoot('drv-ok-wins')
    const sim = makeSim(root, buildArgs(root), { agent: finishedWithEnvNote(why), skipLaneCheck: true })
    const r = await runTicketDriver(sim)
    assert.equal(r.status, status, JSON.stringify(r))
    if (status === 'parked') assert.equal(r.reason, 'gate: environment blocked')
    assert.equal(lanesOf(sim).filter(l => l === 'implement').length, 1, sim.labels.join(' '))
    const impl = readJournal(journalPath(root, 'ABC-1')).filter(l => l.lane === 'implement')
    assert.deepEqual(impl.map(l => l.outcome), ['ok'])
    assert.ok(!decisionsOf(root).some(d => d.kind === 'harness-blocked'))
  })
}

test('an unmeasurable head keeps the previous measured head and holds, never adopting the lane\'s claim', async () => {
  const holds = []
  const c = { wt: '/wt', head: 'aaaa111', out: { start: { baseSha: 'ba5e000' } }, run: async () => ({ status: 'error', reason: 'git failed' }),
    holdHarness: h => holds.push(...h), overturn: () => {} }
  assert.equal(await measuredHead(c, 'c1a1m00', 'implement'), 'aaaa111')
  assert.match(holds[0].summary, /head unmeasured after implement/)
})
