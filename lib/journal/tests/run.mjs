#!/usr/bin/env node
// Journal join + report tests. Hermetic: fixtures only, no network, no real claude/transcripts.
//
//   node lib/journal/tests/run.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkMeasured, cooldownFrom, journalsUnder, measuredFrom, recentFrom } from '../calibrate.mjs'
import { buildSpendRecords, buildSpendRecordsFromDriverJournal } from '../spend.mjs'
import { aggregate } from '../report.mjs'
import { calibration, overturnLine, verdictLine } from '../verdicts.mjs'
import { spawnSync } from 'node:child_process'
import { check } from '../../contract/validate.mjs'
import { report as driverReport } from '../../driver/journal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const readJsonl = p => readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(JSON.parse)

const results = []
const t = (label, errs) => results.push({ label, errs })

const journal = readJsonl(join(FIX, 'journal.jsonl'))
const expected = readJsonl(join(FIX, 'expected-spend.jsonl'))
const got = buildSpendRecords(journal, join(FIX, 'transcripts'), 'run1', 'ABC-1')

t('spend.mjs produces the expected number of records', got.length === expected.length ? [] : [`got ${got.length}, want ${expected.length}`])
t('spend.mjs output matches expected records exactly', JSON.stringify(got) === JSON.stringify(expected) ? [] : [JSON.stringify(got)])
for (const [i, r] of got.entries()) t(`record[${i}] validates against phase-spend`, check('phase-spend', r))

// A spawn with no result line and no api-error turn is outcome "ok" from the transcript alone.
const a2 = got.find(r => r.lane === 'pr-description')
t('outcome with no journal result line is derived from the transcript', a2 && a2.outcome === 'ok' ? [] : [`got ${a2 && a2.outcome}`])

// A spawn whose transcript file is missing is "blocked", not a crash.
const missingTranscriptJournal = [{ type: 'spawn', agentId: 'x1', key: 'k', label: 'plan:plan:T3', phase: 'plan', transcript: 'does-not-exist.jsonl' }]
const missing = buildSpendRecords(missingTranscriptJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('a spawn with no transcript file is outcome "blocked", zeroed counters', missing.length === 1 && missing[0].outcome === 'blocked' && missing[0].turns === 0 ? [] : [JSON.stringify(missing)])

// An explicit result line overrides the transcript-derived outcome.
const escalatedJournal = [
  { type: 'spawn', agentId: 'y1', key: 'k', label: 'review:review-axis:T3', phase: 'review', transcript: 'a1.jsonl' },
  { type: 'result', agentId: 'y1', outcome: 'invalid', escalatedFrom: 'sonnet' },
]
const escalated = buildSpendRecords(escalatedJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('an explicit result line overrides the derived outcome and carries escalatedFrom', escalated[0].outcome === 'invalid' && escalated[0].escalatedFrom === 'sonnet' ? [] : [JSON.stringify(escalated)])

// Result lines from a runner's calls[] carry a label, not an agentId, and join in order per label.
const labelJournal = [
  { type: 'spawn', agentId: 'z1', key: 'k', label: 'ci:exec:T1:wait-ci', phase: 'ci', transcript: 'a1.jsonl' },
  { type: 'spawn', agentId: 'z2', key: 'k', label: 'ci:exec:T1:wait-ci', phase: 'ci', transcript: 'a1.jsonl' },
  { type: 'spawn', agentId: 'z3', key: 'k', label: 'ci:exec:T2:wait-ci', phase: 'ci', transcript: 'a1.jsonl' },
  { type: 'result', label: 'ci:exec:T1:wait-ci', outcome: 'schema', escalatedFrom: null },
  { type: 'result', label: 'ci:exec:T1:wait-ci', outcome: 'schema', escalatedFrom: null },
  { type: 'result', label: 'ci:exec:T2:wait-ci', outcome: 'ok', escalatedFrom: 'T1' },
]
const byLbl = buildSpendRecords(labelJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('result lines without agentId join spawns by label, in order',
  byLbl.map(r => `${r.tier}:${r.outcome}:${r.escalatedFrom}`).join(',') === 'T1:schema:null,T1:schema:null,T2:ok:T1' ? [] : [JSON.stringify(byLbl.map(r => [r.tier, r.outcome, r.escalatedFrom]))])

// Legacy journal shape from the retired Workflow runner: "started" (not "spawn") with no
// "transcript" field; the transcript file is "agent-<agentId>.jsonl" in the run's own transcript dir.
const realJournal = [
  { type: 'launched' },
  { type: 'started', key: 'k1', agentId: 'r1', label: 'start:exec:T1:resume', phase: 'start' },
  { type: 'result', key: 'k1', agentId: 'r1', result: { command: 'harness.mjs resume', ran: true, exitCode: 0, stdout: '{}' } },
]
const real = buildSpendRecords(realJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('a legacy "started" entry (no transcript field) is picked up, not silently dropped',
  real.length === 1 ? [] : [`got ${real.length} records from a real-shaped journal`])
t('its transcript is found via the agent-<agentId>.jsonl convention', real[0] && real[0].turns === 1 ? [] : [JSON.stringify(real)])

// A node-driver run has no transcripts, no runId/out args: spend.mjs reads driver-journal.jsonl
// directly (the runner's own per-call usage/cost), the control-run gap (defect 9, doc 14).
const driverJournal = readJsonl(join(FIX, 'driver-journal.jsonl'))
const driverRecords = buildSpendRecordsFromDriverJournal(driverJournal, 'ABC-8367')

t('driver-journal mode yields one record per journal line (lane calls and exec calls alike)',
  driverRecords.length === driverJournal.length ? [] : [`got ${driverRecords.length}, want ${driverJournal.length}`])
for (const [i, r] of driverRecords.entries()) t(`driver record[${i}] validates against phase-spend`, check('phase-spend', r))
t('a driver-journal warning line is not a spend record',
  buildSpendRecordsFromDriverJournal([...driverJournal, { kind: 'warning', phase: 'plan', label: 'plan:premise:T2', message: 'lane input not captured' }], 'ABC-8367').length === driverJournal.length ? [] : ['warning counted as spend'])

// Non-ok outcomes (harness-blocked) must survive the join, not collapse to "ok" (13 finding 7 /
// 14 defect 9's sibling bug): 3 of the 7 lane calls in the fixture are harness-blocked.
const driverOutcomes = driverRecords.filter(r => r.tier !== 'T0').map(r => r.outcome)
t('driver-journal outcomes are not flattened to ok',
  driverOutcomes.filter(o => o === 'harness-blocked').length === 3 && driverOutcomes.filter(o => o === 'ok').length === 4
    ? [] : [JSON.stringify(driverOutcomes)])

const byDriverPhase = aggregate(driverRecords, 'phase')
t('driver-journal per-phase output/cache-read reproduce the control-run report',
  byDriverPhase.premise.out === 22414 && byDriverPhase.premise.cacheRead === 4891953 &&
    byDriverPhase.plan.out === 20282 && byDriverPhase.plan.cacheRead === 2479973 &&
    byDriverPhase.implement.out === 93214 && byDriverPhase.implement.cacheRead === 14811856 &&
    byDriverPhase.logs.out === 964 && byDriverPhase.logs.cacheRead === 209914
    ? [] : [JSON.stringify(byDriverPhase)])

// The same totals journal.mjs --report already derives straight from the raw journal (the only
// per-phase source available for a node run until this fix) must equal what spend.mjs now emits.
const rawReport = driverReport(driverJournal).summary
const totalOut = driverRecords.reduce((n, r) => n + r.out, 0)
const totalCacheRead = driverRecords.reduce((n, r) => n + r.cacheRead, 0)
const totalCost = driverRecords.reduce((n, r) => n + (r.costUsd || 0), 0)
t('spend.mjs driver-journal totals match journal.mjs --report exactly',
  totalOut === rawReport.output && totalCacheRead === rawReport.cacheRead && Math.abs(totalCost - rawReport.costUsd) < 1e-9
    ? [] : [JSON.stringify({ totalOut, totalCacheRead, totalCost, rawReport })])
t('control-run totals match the evidence (136.9k out / 22.39M cache-read / $17.36)',
  totalOut === 136874 && totalCacheRead === 22393696 && Math.abs(totalCost - 17.3581494) < 1e-6
    ? [] : [JSON.stringify({ totalOut, totalCacheRead, totalCost })])

// The legacy outcome join: a spawn from the retired Workflow runner can carry both an agentId-keyed
// completion record (no "outcome" field, just {command, ran, exitCode, stdout}) AND a label-keyed
// calls[] result with the lane's real outcome. The agentId record must not win by being merely
// truthy (13 finding 7).
const bothKindsJournal = [
  { type: 'started', key: 'k9', agentId: 'w1', label: 'implement:implement:T3', phase: 'implement', transcript: 'a1.jsonl' },
  { type: 'result', key: 'k9', agentId: 'w1', result: { command: 'harness.mjs implement', ran: true, exitCode: 0, stdout: '{}' } },
  { type: 'result', label: 'implement:implement:T3', outcome: 'harness-blocked', escalatedFrom: null },
]
const bothKinds = buildSpendRecords(bothKindsJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('a label-keyed calls[] outcome wins over a bare agentId completion record',
  bothKinds[0] && bothKinds[0].outcome === 'harness-blocked' ? [] : [JSON.stringify(bothKinds)])

// report.mjs aggregation
const byLane = aggregate(expected, 'lane')
t('report aggregates turns per lane', byLane.plan.turns === 2 && byLane.exec.turns === 1 && byLane['pr-description'].turns === 1 ? [] : [JSON.stringify(byLane)])
t('report sums input tokens per lane', byLane.plan.in === 180 ? [] : [`got ${byLane.plan.in}`])
t('report counts one call per lane in this fixture', byLane.plan.calls === 1 && byLane.exec.calls === 1 ? [] : [JSON.stringify(byLane)])

const byPhase = aggregate(expected, 'phase')
t('report can also aggregate per phase', byPhase.plan.turns === 2 && byPhase.start.turns === 1 ? [] : [JSON.stringify(byPhase)])

// Verdict ledger: per lane x model, how often a later script or human contradicted a lane.
const verdicts = readJsonl(join(FIX, 'verdicts.jsonl'))
const cal = calibration(verdicts)
t('calibration counts verdicts per lane and model', cal['implement|opus'].verdicts === 2 && cal['premise|sonnet'].verdicts === 2 && cal['confidence-dim|opus'].verdicts === 1 ? [] : [JSON.stringify(cal)])
t('an overturn counts once per verdict, however often it is recorded', cal['confidence-dim|opus'].overturns === 1 && cal['confidence-dim|opus'].rate === 1 ? [] : [JSON.stringify(cal['confidence-dim|opus'])])
t('the overturn rate is overturned verdicts over verdicts', cal['implement|opus'].rate === 0.5 && cal['premise|sonnet'].rate === 0.5 ? [] : [JSON.stringify(cal)])
t('an overturn of an unknown verdict is ignored', calibration([...verdicts, { kind: 'overturned', verdictId: 'nope' }])['implement|opus'].overturns === 1 ? [] : ['counted'])
const v = verdictLine({ runId: 'r9', phase: 'premise', lane: 'premise', model: 'sonnet', tier: 'T2', field: 'verdict', value: 'holds', detail: 'ticket' })
t('a verdict line has a deterministic id and is claimed by default', v.kind === 'verdict' && v.id === 'r9:premise:premise:ticket:verdict' && v.evidenceStatus === 'claimed' && !Number.isNaN(Date.parse(v.at)) ? [] : [JSON.stringify(v)])
const o = overturnLine({ runId: 'r9', verdictId: v.id, by: 'script', source: 'verify-claim', evidence: 'x'.repeat(900) })
t('an overturn line names its verdict and clips its evidence', o.kind === 'overturned' && o.verdictId === v.id && o.evidence.length <= 500 ? [] : [JSON.stringify(o).slice(0, 200)])
const cli = spawnSync(process.execPath, [join(HERE, '..', 'report.mjs'), '--calibration', join(FIX, 'verdicts.jsonl')], { encoding: 'utf8' })
const out = cli.status === 0 ? JSON.parse(cli.stdout) : null
t('report --calibration prints the per-lane overturn rate', out && out.status === 'ok' && out.calibration['implement|opus'].rate === 0.5 ? [] : [cli.stdout + cli.stderr])

// Calibration: every run under a run-state root, folded into measured scores (1 - overturn rate),
// recent mean tokens and cooldowns for the router. Synthetic journals in a temporary root.
const ROOT = mkdtempSync(join(tmpdir(), 'calibrate-'))
const AS_OF = '2026-10-14T12:00:00.000Z'
const minutesBefore = m => new Date(Date.parse(AS_OF) - m * 60000).toISOString()
const writeJsonl = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n') }
const vline = (runId, i, lane, model) => ({ kind: 'verdict', id: `${runId}:${lane}:${i}`, runId, phase: lane, lane, model, tier: null, field: `f${i}`, value: 'x', evidenceStatus: 'claimed', at: AS_OF })
const oline = (runId, id) => ({ kind: 'overturned', verdictId: id, runId, by: 'script', source: 'verify-claim', evidence: 'e', at: AS_OF })
const lline = (runId, lane, model, outcome, usage, extra = {}) => ({ runId, phase: 'x', label: `x:${lane}:T2`, lane, model, outcome, durationMs: 1, costUsd: 0.5, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...usage }, replayed: false, ...extra })
// Run 1: implement|opus 8 verdicts, 2 overturned; premise|sonnet 10, none overturned; a modelless verdict.
writeJsonl(join(ROOT, 'run-1', 'tickets', 'ABC-1', 'verdicts.jsonl'), [
  ...Array.from({ length: 8 }, (_, i) => vline('r1', i, 'implement', 'opus')), oline('r1', 'r1:implement:0'), oline('r1', 'r1:implement:1'), oline('r1', 'r1:implement:1'),
  ...Array.from({ length: 10 }, (_, i) => vline('r1', i, 'premise', 'sonnet')), vline('r1', 99, 'premise', null),
])
// Run 2: implement|opus 4 more, 1 overturned; review-axis|opus 4 (under the minimum).
writeJsonl(join(ROOT, 'run-2', 'tickets', 'ABC-2', 'verdicts.jsonl'), [
  ...Array.from({ length: 4 }, (_, i) => vline('r2', i, 'implement', 'opus')), oline('r2', 'r2:implement:0'),
  ...Array.from({ length: 4 }, (_, i) => vline('r2', i, 'review-axis', 'opus')),
])
writeJsonl(join(ROOT, 'run-1', 'tickets', 'ABC-1', 'driver-journal.jsonl'), [
  { runId: 'r1', phase: 'start', label: 'start:exec:resume', kind: 'exec', script: 'resume', exitCode: 0, durationMs: 1, replayed: false },
  lline('r1', 'premise', 'sonnet', 'ok', { input: 1000, cacheCreate: 200, cacheRead: 5000, output: 100 }, { at: minutesBefore(30) }),
  lline('r1', 'premise', 'sonnet', 'ok', { input: 3000, cacheCreate: 0, cacheRead: 0, output: 300 }, { at: minutesBefore(20) }),
  lline('r1', 'premise', 'sonnet', 'ok', { input: 9999, output: 9999 }, { at: minutesBefore(20), replayed: true }),
  lline('r1', 'implement', 'opus', 'rate-limit', {}, { at: minutesBefore(60) }),
])
writeJsonl(join(ROOT, 'run-2', 'tickets', 'ABC-2', 'driver-journal.jsonl'), [
  lline('r2', 'implement', 'opus', 'rate-limit', {}, { at: minutesBefore(5) }),
  lline('r2', 'implement', 'opus', 'rate-limit', {}, { at: minutesBefore(4) }),
  lline('r2', 'implement', 'opus', 'ok', { input: 10, output: 1 }, { at: minutesBefore(3) }),
  lline('r2', 'review-axis', 'sonnet', 'rate-limit', {}),
])
writeFileSync(join(ROOT, 'run-2', 'tickets', 'ABC-2', 'notes.jsonl'), '{"kind":"verdict","id":"not-a-ledger"}\n')
const found = journalsUnder(ROOT)
t('journalsUnder finds every verdict ledger and driver journal under the root, nothing else', found.verdicts.length === 2 && found.journals.length === 2 && found.runs === 2 ? [] : [JSON.stringify(found)])
const { measured, skipped } = measuredFrom(found.verdicts.flatMap(readJsonl), { minN: 10, evalRun: 'calibrate-2026-10-14' })
t('measured score is 1 - overturn rate over every run, with n and the eval run', JSON.stringify(measured.opus?.implement) === JSON.stringify({ score: 0.75, n: 12, evalRun: 'calibrate-2026-10-14' }) ? [] : [JSON.stringify(measured)])
t('a pair with no overturn scores 1', measured.sonnet?.premise?.score === 1 && measured.sonnet.premise.n === 10 ? [] : [JSON.stringify(measured.sonnet)])
t('a pair under the minimum n is skipped and named', !measured.opus?.['review-axis'] && skipped.some(s => s.lane === 'review-axis' && s.model === 'opus' && s.n === 4) ? [] : [JSON.stringify({ measured, skipped })])
t('a verdict without a model is not measured', Object.keys(measured).every(m => m !== 'null') ? [] : [JSON.stringify(Object.keys(measured))])
const journalLines = found.journals.flatMap(readJsonl)
const recent = recentFrom(journalLines)
t('recent mean tokens per model|lane: input plus cache writes in, output out, replayed and exec lines ignored', JSON.stringify(recent['sonnet|premise']) === JSON.stringify({ calls: 2, meanTokens: { in: 2100, out: 200 }, costUsd: 1 }) ? [] : [JSON.stringify(recent)])
t('recent counts only finished calls', recent['opus|implement']?.calls === 1 ? [] : [JSON.stringify(recent['opus|implement'])])
const cool = cooldownFrom(journalLines, AS_OF, 15)
t('a rate limit inside the window cools the model down until window minutes after the last one', cool.opus && cool.opus.failures === 2 && cool.opus.until === minutesBefore(4 - 15) ? [] : [JSON.stringify(cool)])
t('a rate limit outside the window, or without a timestamp, cools nothing', !cool.sonnet && !cooldownFrom(journalLines, minutesBefore(-120), 15).opus ? [] : [JSON.stringify(cool)])
const OUT = join(ROOT, 'measured.json')
const run = (...a) => { const p = spawnSync(process.execPath, [join(HERE, '..', 'calibrate.mjs'), ...a], { encoding: 'utf8' }); let r = null; try { r = JSON.parse(p.stdout.trim().split('\n').pop()) } catch {} ; return { p, r } }
const dry = run('--root', ROOT, '--out', OUT, '--dry-run', '--as-of', AS_OF)
t('calibrate --dry-run reports without writing', dry.p.status === 0 && dry.r?.status === 'ok' && dry.r.measured?.opus?.implement?.score === 0.75 && !existsSync(OUT) ? [] : [dry.p.stdout + dry.p.stderr])
const wet = run('--root', ROOT, '--out', OUT, '--min-n', '4', '--as-of', AS_OF)
const written = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null
t('calibrate writes measured.json in the model -> lane shape, honouring --min-n', wet.p.status === 0 && written?.opus?.['review-axis']?.n === 4 && written.opus.implement.evalRun === 'calibrate-2026-10-14' && checkMeasured(written).length === 0 ? [] : [wet.p.stdout + wet.p.stderr, JSON.stringify(written), ...checkMeasured(written || {})])
const none = run('--root', join(ROOT, 'nowhere'), '--out', OUT)
t('calibrate on a missing root is a script error', none.p.status === 1 && none.r?.status === 'error' ? [] : [none.p.stdout + none.p.stderr])

const failed = results.filter(r => r.errs.length)
for (const r of results) {
  console.log(`${r.errs.length ? 'FAIL' : 'ok  '} ${r.label}`)
  for (const e of r.errs) console.log(`       ${e}`)
}
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length} checks`)
process.exit(failed.length ? 1 : 0)
