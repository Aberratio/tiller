import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArgs, makeSim, runTicket as runWorkflow, runTicketDriver, tmpRoot } from './dryrun.mjs'
import { LIVE_IN_REPLAY } from './replay-extract.mjs'

const NODE = process.env.FLOW_TARGET === 'node'
const runTicket = NODE ? runTicketDriver : runWorkflow
const FIXTURES = join(import.meta.dirname, 'fixtures', 'replay')

// Answers every lane and exec call from the recording, by (phase, lane or exec detail, occurrence);
// verify-claim calls also by the toolchain row they name, since the static checks fan out and finish
// in any order. A call the recording never made falls back to the simulator default and is counted.
function replayMode(fx, root) {
  const load = v => JSON.parse(JSON.stringify(v).split('<ROOT>').join(root))
  const lanes = load(fx.lanes)
  // Recorded before the runner named the plan's place; the recorded plan went into the worktree, which
  // the runner now parks on, so the replay moves it to where a lane following today's brief writes it.
  for (const e of lanes) if (e.key.startsWith('plan:plan:') && e.result) e.result.planPath = join(root, 'tickets', fx.ticket, 'plan.md')
  const execs = load(fx.execs)
  const used = new Set()
  const misses = []
  const take = (pool, key, pick = () => true) => {
    const hit = pool.find(e => e.key === key && !used.has(e) && pick(e))
    if (hit) used.add(hit)
    return hit
  }
  return {
    misses,
    unused: () => [...lanes, ...execs].filter(e => !used.has(e)).map(e => `${e.key}#${e.occurrence}`),
    agent: (lane, ctx) => {
      const hit = take(lanes, `${ctx.phase}:${lane}:${ctx.detail}`)
      if (!hit) { misses.push(`${ctx.phase}:${lane}:${ctx.detail}`); return undefined }
      return hit.result
    },
    exec: (name, argv, ctx) => {
      if (LIVE_IN_REPLAY.has(name)) return undefined
      // The gate's whole-branch scope fence postdates the recording; the simulator's files are not the
      // recorded diff, so the replay measures it as in scope rather than invent a park the run never had.
      if (ctx.phase === 'gate' && ctx.detail === 'scope') return { status: 'ok', pin: 'p', head: ctx.head, changedFiles: [], authorised: [], extra: [], inScope: true }
      // The head measurement postdates the recording too; the simulator answers it as an honest worktree.
      if (name === 'head-truth.mjs') return undefined
      const key = `${ctx.phase}:${ctx.detail}:${name}`
      const hit = take(execs, key, e => name !== 'verify-claim.mjs' || (e.result && e.result.match) === argv[1])
      if (!hit) { misses.push(key); return undefined }
      return hit.result
    },
  }
}

async function replay(ticket) {
  const fx = JSON.parse(readFileSync(join(FIXTURES, `${ticket}.json`), 'utf8'))
  const root = tmpRoot(`replay-${ticket}`)
  const args = buildArgs(root, { ticket })
  const mode = replayMode(fx, root)
  // A recorded answer is what a live agent() call let through its structured-output schema, which is
  // looser than lib/contract (the recorded log-prose awaiting items carry no reversal cost).
  const sim = makeSim(root, args, { ...mode, skipLaneCheck: true })
  const r = await runTicket(sim)
  return { fx, r, mode, root }
}

test('ABC-102 (13 lanes + 17 execs recorded, 4 fallbacks) replayed from its recording parks where the real run parked: review-bot never reviewed, the confidence pass raised a harness finding on the raw PR prose, and diff-since-review returned no script-result line', async () => {
  const { fx, r, mode } = await replay('ABC-102')
  assert.equal(r.status, fx.terminal.status, JSON.stringify({ reason: r.reason, misses: mode.misses }))
  // Since the recording the runner treats changed files it could not read as unconfirmed merge
  // authority, so the recorded changed-files failure now also blocks touched-paths. It also gained
  // worktree-setup and base conditions, both green here. Otherwise the conditions that were not
  // green then are the ones that are not green now.
  const withTouched = list => list.flatMap(x => x === 'review-bot blocked' ? [x, 'touched-paths blocked'] : [x])
  assert.equal(r.reason, `gate: ${withTouched(fx.terminal.reason.replace(/^gate: /, '').split(', ')).join(', ')}`)
  const notGreen = cs => cs.filter(x => x.state !== 'green').map(x => `${x.name} ${x.state}`)
  assert.deepEqual(notGreen(r.gate.conditions), withTouched(notGreen(fx.terminal.gate)))
  assert.equal(r.prUrl, fx.terminal.prUrl)
  assert.equal(r.headSha, fx.terminal.headSha)
  // Every recorded answer is consumed. The calls the recording cannot answer are the ones the runner
  // gained after it: the worktree-setup check, the duplicate guard, the PR-title retry the recorded
  // title needed, the scripted security scan of the diff, and the mergeability read before the gate.
  // Each falls back to the simulator default.
  assert.deepEqual(mode.misses, [
    'start:duplicate-guard:duplicate-guard.mjs', 'start:worktree-setup:verify-claim.mjs',
    'pr:pr-description:prose-retry', 'confidence:scan-diff:scan-diff.mjs', 'gate:pr-state:pr-state.mjs',
  ])
  // PR #501 was opened as a draft, and the real run polled the bot six times on it. The runner no
  // longer polls a draft PR, so those recorded answers go unused and review-bot blocks on the draft.
  assert.deepEqual(mode.unused(), [1, 2, 3, 4, 5, 6].map(n => `review-bot:bot-review-bot:review-bot-green.mjs#${n}`))
  assert.match(r.gate.conditions.find(x => x.name === 'review-bot').evidence, /still draft/)
})
