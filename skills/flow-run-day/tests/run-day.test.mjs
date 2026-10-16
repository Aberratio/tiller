import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE, NO_TRACKER, buildDayArgs, decisionsOf, harness, makeSim, runDayDriver as runDay, state, tmpRoot } from '../../flow-run-ticket/tests/dryrun.mjs'

const fresh = (tag, queue, opts = {}) => {
  const root = tmpRoot(`day-${tag}`)
  const args = buildDayArgs(root, { queue, ...opts })
  if (args.refused) throw new Error(JSON.stringify(args.refused))
  return { root, args }
}
const lanesOf = sim => sim.labels.map(l => l.split(':')[1]).filter(l => l !== 'exec')
const statuses = r => Object.fromEntries(r.results.map(x => [x.ticket, x.status]))
const QUEUE = [['ABC-1', 'ABC-2'], ['ABC-3']]

// Decisions another session wrote to the same STATE_ROOT.
function seed(root, n, kind = 'question') {
  for (let i = 0; i < n; i++) {
    const d = { ticket: `ABC-9${i}`, kind, question: `seeded ${i}`, why: 'another session', blocks: 'ABC-9' }
    if (kind !== 'harness-blocked') Object.assign(d, { options: ['a', 'b'], recommendation: 'a', reversalCost: 'low' })
    const r = state(root, 'decide', JSON.stringify(d))
    assert.equal(r.status, 'ok', JSON.stringify(r))
  }
}

test('happy day: every wave runs, children share the root, the next wave starts through the owner proxy', async () => {
  const { root, args } = fresh('happy', QUEUE)
  const sim = makeSim(root, args)
  const r = await runDay(sim)
  assert.equal(r.status, 'done', JSON.stringify(r.reason))
  assert.deepEqual(statuses(r), { 'ABC-1': 'merged', 'ABC-2': 'merged', 'ABC-3': 'merged' })
  assert.deepEqual(sim.children, ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.equal(sim.labels.filter(l => l.startsWith('waves:owner-proxy:T3:start-next-ticket')).length, 1)
  assert.ok(sim.labels.some(l => l.startsWith('sweep:sweep-summary:T2')), 'sweep after merges')
  assert.match(readFileSync(join(root, 'state.md'), 'utf8'), /supervisor: done/)
  assert.match(readFileSync(join(root, 'day-summary.md'), 'utf8'), /# Day 2026-09-28/)
  assert.equal(state(root, 'open-count').open, 0)
})

// The runtime adds the dispatch tools (Agent, Task, Workflow) itself, tested in lib/driver/tests/runtime.test.mjs;
// what the day must hand every lane is the profile's outward denies.
test('every day-level lane is handed the profile\'s disallowed tools', async () => {
  const { root, args } = fresh('dispatch-deny', QUEUE)
  const sim = makeSim(root, args)
  await runDay(sim)
  assert.ok(sim.laneOpts.length > 0)
  assert.ok(args.disallowedTools.length > 0)
  for (const o of sim.laneOpts) assert.deepEqual(o.disallowedTools, args.disallowedTools, o.label)
})

test('the ceiling is checked before every chunk: a chunk that reaches it stops the next one', async () => {
  const { root, args } = fresh('ceiling', [['ABC-1', 'ABC-2', 'ABC-3']])
  seed(root, args.facts.runPolicy.dayCeiling - 1)
  const sim = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'qa-judge' && ctx.ticket === 'ABC-1'
      ? { criteria: [{ id: 'AC1', verdict: 'fail', evidence: 'observed a mismatch' }] } : undefined,
  })
  const r = await runDay(sim)
  assert.equal(r.status, 'ceiling')
  assert.deepEqual(sim.children, ['ABC-1', 'ABC-2'], 'ABC-3 never started')
  const ceiling = decisionsOf(root).filter(d => d.kind === 'ceiling')
  assert.equal(ceiling.length, 1)
  assert.match(ceiling[0].blocks, /ABC-3/)
  assert.ok(!sim.labels.some(l => l.includes(':owner-proxy:T3:lift-cap-once')), 'lift-cap-once is outside this mandate, so no proxy call')
})

test('decisions from another session on the same root count: nothing starts at the ceiling', async () => {
  const { root, args } = fresh('cross', QUEUE)
  seed(root, args.facts.runPolicy.dayCeiling)
  const sim = makeSim(root, args)
  const r = await runDay(sim)
  assert.equal(r.status, 'ceiling')
  assert.deepEqual(sim.children, [])
})

test('harness-blocked parks are never counted toward the ceiling', async () => {
  const { root, args } = fresh('blocked', QUEUE)
  seed(root, args.facts.runPolicy.dayCeiling - 1)
  seed(root, 5, 'harness-blocked')
  const sim = makeSim(root, args, { exec: name => name === 'pr-open.mjs' ? { denied: 'Permission denied by rule Bash(gh pr create:*)' } : undefined })
  const r = await runDay(sim)
  assert.deepEqual(statuses(r), { 'ABC-1': 'parked', 'ABC-2': 'parked', 'ABC-3': 'parked' })
  assert.deepEqual(sim.children, ['ABC-1', 'ABC-2', 'ABC-3'], 'the second wave still started')
  assert.equal(state(root, 'open-count').open, args.facts.runPolicy.dayCeiling - 1)
  // The driver runs pr-open itself, so each child parks on one harness-blocked decision (plus the day's own).
  assert.equal(decisionsOf(root).filter(d => d.kind === 'harness-blocked').length, 5)
})

test('a usage limit in a child pauses the day; the rerun finishes without redoing finished work', async () => {
  const { root, args } = fresh('usage', QUEUE)
  let hit = false
  const first = makeSim(root, args, {
    agent: (lane, ctx) => lane === 'confidence-dim' && ctx.ticket === 'ABC-1' && !hit
      ? (hit = true, { throw: 'You have hit your usage limit. Limit resets at 2026-09-28T23:00:00Z' }) : undefined,
  })
  const r1 = await runDay(first)
  assert.equal(r1.status, 'paused-usage')
  assert.ok(!first.children.includes('ABC-3'), 'no new wave after a pause')
  assert.ok(!existsSync(join(root, 'day-summary.md')), 'no day summary while paused')
  assert.match(readFileSync(join(root, 'state.md'), 'utf8'), /supervisor: paused-usage 2026-09-28T23:00:00Z/)
  const second = makeSim(root, args)
  const r2 = await runDay(second)
  assert.equal(r2.status, 'done')
  assert.deepEqual(statuses(r2), { 'ABC-1': 'merged', 'ABC-2': 'merged', 'ABC-3': 'merged' })
  assert.equal(lanesOf(second).filter(l => l === 'implement').length, 1, 'only ABC-3 is implemented on the rerun')
  assert.ok(second.labels.some(l => l.startsWith('waves:owner-proxy:T3:resume-run')))
})

test('killed mid-wave, the rerun resumes each child from its checkpoint without restarting the wave', async () => {
  const { root, args } = fresh('kill', QUEUE)
  const first = makeSim(root, args, { exec: name => name === 'wait-ci.mjs' ? { hang: true } : undefined })
  const r1 = await runDay(first)
  assert.ok(r1.killed, 'killed')
  const second = makeSim(root, args)
  const r2 = await runDay(second)
  assert.equal(r2.status, 'done')
  assert.deepEqual(statuses(r2), { 'ABC-1': 'merged', 'ABC-2': 'merged', 'ABC-3': 'merged' })
  const reimplemented = lanesOf(second).filter(l => l === 'implement').length
  assert.ok(reimplemented < 3, `finished phases are not redone (${reimplemented} implement lanes)`)
  const resumed = ['ABC-1', 'ABC-2'].filter(t => JSON.parse(readFileSync(join(root, 'tickets', t, 'run.json'), 'utf8')).counters.resumes === 1)
  assert.ok(resumed.length >= 1, 'at least one child resumed from a checkpoint')
  const third = makeSim(root, args)
  const r3 = await runDay(third)
  assert.ok(r3.results.every(x => x.skipped), 'a finished day reruns as a no-op')
  assert.deepEqual(third.children, [])
})

test('a day run is refused without an owner proxy, a ceiling, or a valid queue', () => {
  const root = tmpRoot('day-refuse')
  const noProxy = join(root, 'no-proxy.md')
  const text = readFileSync(NO_TRACKER, 'utf8')
  writeFileSync(noProxy, text.slice(0, text.indexOf('## owner proxy')) + text.slice(text.indexOf('## escalation')))
  const spec = join(root, 'add-flag.md')
  writeFileSync(spec, '# Add a flag\n')
  assert.match(buildDayArgs(root, { profile: noProxy, queue: [[{ spec }]] }).refused.reason, /owner proxy/)
  assert.match(buildDayArgs(root, { queue: [['OTHER-1']] }).refused.reason, /tracker keys/)
  assert.match(buildDayArgs(root, { queue: [['ABC-1'], ['ABC-1']] }).refused.reason, /queued twice/)
  assert.match(buildDayArgs(root, { queue: [] }).refused.reason, /non-empty/)
})

test('no-tracker profile: a day of specs runs with command gates', async () => {
  const root = tmpRoot('day-spec')
  const spec = join(root, 'add-flag.md')
  writeFileSync(spec, '# Add a --verbose flag\n')
  const args = buildDayArgs(root, { profile: NO_TRACKER, queue: [[{ spec, notes: ['keep it small'] }]] })
  assert.ok(!args.refused, JSON.stringify(args.refused))
  assert.equal(args.waves[0][0].ticket, 'ADD-FLAG')
  const sim = makeSim(root, args, { files: ['src/cli.js'] })
  const r = await runDay(sim)
  assert.equal(r.status, 'done', JSON.stringify(r.reason))
  assert.deepEqual(statuses(r), { 'ADD-FLAG': 'merged' })
  assert.ok(sim.execs.some(e => e.name === 'command'), 'command gate ran')
})

test('supervisor environment is rendered from the profile', () => {
  const root = tmpRoot('day-env')
  const m = harness(root, 'supervise-env', '--profile', PROFILE).result
  assert.equal(m.env.SUPERVISE_STOP_HOUR, '')
  assert.ok(!m.channels.includes('public-comment'), 'the profile prose narrows the channel list')
  assert.match(m.env.SUPERVISE_DISALLOWED_TOOLS, /slack_send_message/)
  assert.doesNotMatch(m.env.SUPERVISE_DISALLOWED_TOOLS, /send_message_draft/)
  const f = harness(root, 'supervise-env', '--profile', NO_TRACKER, '--disallow', 'mcp__x__post').result
  assert.equal(f.env.SUPERVISE_STOP_HOUR, '19')
  assert.ok(f.channels.includes('public-comment'))
  assert.match(f.env.SUPERVISE_DISALLOWED_TOOLS, /mcp__x__post$/)
})

test('the sweep follows the base branch: a merge outside the waves is swept, an unchanged base is not', async () => {
  const { root, args } = fresh('sweep', [['ABC-1']])
  const sim = makeSim(root, args, { exec: name => name === 'pr-merge.mjs' ? { status: 'error', kind: 'script-error', reason: 'merge refused' } : undefined })
  const r = await runDay(sim)
  assert.deepEqual(r.merged, [])
  assert.ok(sim.labels.some(l => l.startsWith('sweep:sweep-summary:')), 'swept although no wave merged')
  assert.equal(readFileSync(join(root, 'sweep-sha'), 'utf8'), 'ma1n001')
  const again = makeSim(root, args)
  await runDay(again)
  assert.ok(!again.labels.some(l => l.startsWith('sweep:sweep-summary:')), 'same base, no second sweep')
  const moved = makeSim(root, args, { baseHead: 'ma1n002' })
  await runDay(moved)
  assert.ok(moved.labels.some(l => l.startsWith('sweep:sweep-summary:')), 'base moved, swept again')
})

test('the sweep and the day summary cannot raise decisions: their awaiting[] is never retried or parked on', async () => {
  const { root, args } = fresh('prose-awaiting', [['ABC-1']])
  const env = { kind: 'harness-blocked', question: 'the staging oracle could not be reached', why: 'Couldn\'t find env file: .env.worktree', blocks: 'nothing' }
  const ask = { kind: 'question', question: 'Sweep again tomorrow?', why: 'one oracle was skipped', blocks: 'nothing', options: ['yes', 'no'], recommendation: 'yes', reversalCost: 'low' }
  const sim = makeSim(root, args, { skipLaneCheck: true, agent: (lane, ctx) => lane === 'sweep-summary' ? { summary: 'Day summary.', regressions: [], awaiting: [env, ask] }
    : lane === 'log-prose' && /day run/.test(ctx.prompt) ? { text: 'Day summary.', awaiting: [env] } : undefined })
  const r = await runDay(sim)
  assert.equal(r.status, 'done', JSON.stringify(r.reason))
  assert.equal(sim.labels.filter(l => l.startsWith('sweep:sweep-summary:')).length, 1, 'no identical retry of the sweep')
  assert.equal(decisionsOf(root).length, 0, JSON.stringify(decisionsOf(root)))
})

test('hard-stop prose that names no known channel keeps every channel a hard stop', async () => {
  const { hardStopChannels } = await import('../../flow-run-ticket/bin/harness.mjs')
  const all = hardStopChannels({ ownerProxy: null })
  assert.deepEqual(hardStopChannels({ ownerProxy: { hardStopChannels: 'anything outward, see policy' } }), all)
  assert.deepEqual(hardStopChannels({ ownerProxy: { hardStopChannels: 'calendar writes only' } }), ['calendar-write'])
})

test('a child that died inside start, before its first checkpoint, is resumed through the resume-run mandate on the rerun', async () => {
  const { root, args } = fresh('start-death', [['ABC-1']])
  // The duplicate guard is the last non-mutating start step; a death inside worktree new is an interrupted step.
  // Its argv carries the ticket as --key; the sim cannot read the ticket off that command line.
  const first = makeSim(root, args, { exec: (name, argv) => name === 'duplicate-guard.mjs' && argv[argv.indexOf('--key') + 1] === 'ABC-1' ? { hang: true } : undefined })
  const r1 = await runDay(first)
  assert.ok(r1.killed, 'killed inside start')
  assert.equal(state(root, 'phase-get', 'ABC-1', 'start').found, false, 'no start checkpoint')
  const second = makeSim(root, args)
  const r2 = await runDay(second)
  assert.equal(r2.status, 'done', JSON.stringify(r2.reason))
  assert.deepEqual(statuses(r2), { 'ABC-1': 'merged' })
  assert.ok(second.labels.some(l => l.startsWith('waves:owner-proxy:T3:resume-run')), second.labels.join(' '))
  assert.ok(!second.labels.some(l => l.startsWith('waves:owner-proxy:T3:start-next-ticket')), 'not treated as a fresh ticket')
})
