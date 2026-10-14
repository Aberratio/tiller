// Calibration feedback and the routing state it feeds: the harness `calibrate` command, the
// measured / recent / cooldown state the args carry, and the cooldowns the driver keeps live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROFILE, buildArgs, harness, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { createContext } from '../core.mjs'
import { exec } from '../runtime.mjs'
import { journalPath, laneLine, readJournal } from '../journal.mjs'

const writeJsonl = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n') }
const vline = (runId, i, lane, model) => ({ kind: 'verdict', id: `${runId}:${lane}:${i}`, runId, phase: lane, lane, model, tier: 'T3', field: `f${i}`, value: 'x', evidenceStatus: 'claimed', at: '2026-10-14T10:00:00.000Z' })
const oline = (runId, id) => ({ kind: 'overturned', verdictId: id, runId, by: 'script', source: 'verify-claim', evidence: 'e', at: '2026-10-14T10:00:00.000Z' })

const failingWith = (message, exitClass, okAfter = Infinity) => {
  const seen = []
  const run = async ({ model, prompt }) => {
    seen.push({ model, prompt })
    if (seen.length <= okAfter) throw Object.assign(new Error(message), { exitClass, usage: {}, costUsd: 0 })
    return { result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model }
  }
  return { seen, run }
}
function context(args, runtime) {
  const c = createContext(args, { exec, log: () => {}, ...runtime })
  c.cur = 'plan'
  c.out.start = { branch: 'b' }
  return c
}

test('a lane journal line carries the time it was written', () => {
  const l = laneLine({ runId: 'r', phase: 'plan', label: 'plan:plan:T3', lane: 'plan', model: 'opus', outcome: 'ok' })
  assert.ok(!Number.isNaN(Date.parse(l.at)), JSON.stringify(l))
})

test('harness calibrate folds the ledgers under the run-state root into measured.json and reports what it skipped', () => {
  const dir = tmpRoot('calibrate-cmd')
  writeJsonl(join(dir, 'run-1', 'tickets', 'ABC-1', 'verdicts.jsonl'), [
    ...Array.from({ length: 12 }, (_, i) => vline('r1', i, 'implement', 'opus')), oline('r1', 'r1:implement:0'),
    ...Array.from({ length: 3 }, (_, i) => vline('r1', i, 'premise', 'sonnet')),
  ])
  const out = join(dir, 'measured.json')
  const r = harness(dir, 'calibrate', '--profile', PROFILE, '--root', dir, '--out', out)
  assert.equal(r.result.status, 'ok', r.stdout)
  assert.equal(r.result.runs, 1)
  assert.deepEqual(r.result.skipped, [{ model: 'sonnet', lane: 'premise', n: 3 }])
  const written = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(written.opus.implement.n, 12)
  assert.equal(written.opus.implement.score, 0.917)
  assert.match(written.opus.implement.evalRun, /^calibrate-\d{4}-\d{2}-\d{2}$/)
  const dry = harness(dir, 'calibrate', '--profile', PROFILE, '--root', dir, '--out', join(dir, 'dry.json'), '--dry-run')
  assert.equal(dry.result.status, 'ok', dry.stdout)
  assert.ok(!existsSync(join(dir, 'dry.json')))
})

test('args carry measured scores, recent mean tokens and cooldowns read from the run root and the measured file', () => {
  const root = tmpRoot('calibrate-state')
  const measured = join(root, 'measured.json')
  writeFileSync(measured, JSON.stringify({ sonnet: { premise: { score: 0.5, n: 20, evalRun: 'calibrate-2026-10-14' } } }))
  const now = Date.now()
  writeJsonl(journalPath(root, 'ABC-1'), [
    { runId: 'r0', phase: 'premise', label: 'premise:premise:T2', lane: 'premise', model: 'sonnet', outcome: 'ok', durationMs: 1, costUsd: 0.2, usage: { input: 1000, output: 100, cacheRead: 0, cacheCreate: 0 }, replayed: false, at: new Date(now - 60000).toISOString() },
    { runId: 'r0', phase: 'plan', label: 'plan:plan:T3', lane: 'plan', model: 'opus', outcome: 'rate-limit', durationMs: 1, costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, replayed: false, at: new Date(now - 30000).toISOString() },
  ])
  const prev = process.env.TILLER_MEASURED
  process.env.TILLER_MEASURED = measured
  let args
  try { args = buildArgs(root) } finally { if (prev === undefined) delete process.env.TILLER_MEASURED; else process.env.TILLER_MEASURED = prev }
  const s = args.router.state
  assert.equal(s.measured.sonnet.premise.score, 0.5)
  assert.deepEqual(s.recent['sonnet|premise'], { calls: 1, meanTokens: { in: 1000, out: 100 }, costUsd: 0.2 })
  assert.equal(s.cooldown.opus.failures, 1)
  assert.ok(Date.parse(s.cooldown.opus.until) > now)
  // A demoted model is dropped from the lane: the measured score sits below premise's floor.
  const c = context(args, { lane: async ({ model }) => ({ result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model }) })
  return c.lane('premise', 'p', null).then(() => {
    const line = readJournal(journalPath(root, 'ABC-1')).filter(l => l.lane === 'premise' && l.runId !== 'r0').pop()
    assert.equal(line.model, args.tiers.T3, JSON.stringify(line.route))
    assert.ok(line.route.rejected.some(x => x.model === 'sonnet' && x.why === 'below-min'), JSON.stringify(line.route.rejected))
  })
})

test('a rate limit cools the model down for the rest of the run: the next call on the lane skips it', async () => {
  const args = buildArgs(tmpRoot('calibrate-cooldown'))
  const f = failingWith('API Error: 429 rate_limit_error', 'rate_limit', 1)
  const c = context(args, { lane: f.run })
  assert.equal((await c.lane('premise', 'p', null)).ok, true)
  assert.equal((await c.lane('premise', 'p', null)).ok, true)
  assert.deepEqual(f.seen.map(s => s.model), [args.tiers.T2, args.tiers.T3, args.tiers.T3])
  const last = readJournal(journalPath(args.stateRoot, args.ticket)).filter(l => l.lane === 'premise').pop()
  assert.ok(last.route.rejected.some(x => x.model === args.tiers.T2 && x.why === 'cooldown'), JSON.stringify(last.route.rejected))
  assert.equal(args.caps.cooldownMinutes > 0, true)
})

test('a cooldown that every candidate shares is lifted rather than parking the lane', async () => {
  const args = buildArgs(tmpRoot('calibrate-lift'))
  const until = new Date(Date.now() + 3600000).toISOString()
  args.router.state.cooldown = { [args.tiers.T2]: { until, failures: 1 }, [args.tiers.T3]: { until, failures: 1 } }
  const f = failingWith('', 'ok', 0)
  const r = await context(args, { lane: f.run }).lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.deepEqual(f.seen.map(s => s.model), [args.tiers.T2])
})

test('a cooldown is read against the clock at the call, not the launch time', async () => {
  const args = buildArgs(tmpRoot('calibrate-clock'))
  args.router.state.cooldown = { [args.tiers.T2]: { until: new Date(Date.parse(args.router.state.asOf) + 1).toISOString(), failures: 1 } }
  const f = failingWith('', 'ok', 0)
  await new Promise(r => setTimeout(r, 5))
  const r = await context(args, { lane: f.run }).lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.deepEqual(f.seen.map(s => s.model), [args.tiers.T2])
})
