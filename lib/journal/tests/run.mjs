#!/usr/bin/env node
// Journal join + report tests. Hermetic: fixtures only, no network, no real claude/transcripts.
//
//   node lib/journal/tests/run.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// The real Workflow tool writes "started" (not "spawn") with no "transcript" field; the
// transcript file is "agent-<agentId>.jsonl" in the run's own transcript dir.
const realJournal = [
  { type: 'launched' },
  { type: 'started', key: 'k1', agentId: 'r1', label: 'start:exec:T1:resume', phase: 'start' },
  { type: 'result', key: 'k1', agentId: 'r1', result: { command: 'harness.mjs resume', ran: true, exitCode: 0, stdout: '{}' } },
]
const real = buildSpendRecords(realJournal, join(FIX, 'transcripts'), 'run1', 'ABC-1')
t('a real Workflow "started" entry (no transcript field) is picked up, not silently dropped',
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

// The workflow-mode outcome join: a spawn can carry both the harness's own agentId-keyed
// completion record (no "outcome" field, just {command, ran, exitCode, stdout} like the real
// Workflow tool writes) AND a label-keyed calls[] result with the lane's real outcome. The
// agentId record must not win by being merely truthy (13 finding 7).
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

const failed = results.filter(r => r.errs.length)
for (const r of results) {
  console.log(`${r.errs.length ? 'FAIL' : 'ok  '} ${r.label}`)
  for (const e of r.errs) console.log(`       ${e}`)
}
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length} checks`)
process.exit(failed.length ? 1 : 0)
