#!/usr/bin/env node
// Routing resolver tests. Hermetic: fixtures only.
//
//   node lib/routing/tests/run.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { resolveRouting, tierModel } from '../resolve.mjs'
import { checks as catalogueChecks } from './catalogue.checks.mjs'
import { checks as routeChecks } from './route.checks.mjs'
import { checks as launchChecks } from './launch.checks.mjs'
import { checks as ladderChecks } from './ladder.checks.mjs'
import { checks as recordChecks } from './record.checks.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, 'fixtures')
const REPO_ROOT = join(HERE, '..', '..', '..')
const CONFIG = join(REPO_ROOT, 'config', 'routing.json')
const RESOLVE = join(REPO_ROOT, 'lib', 'routing', 'resolve.mjs')

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const results = []
const t = (label, errs) => results.push({ label, errs })

// Defaults, no facts override.
const { routing: defaults, error: defaultsErr } = resolveRouting(config, undefined)
t('no facts: every default lane resolves', defaultsErr ? [defaultsErr.reason] : [])
// 2026-09-29: T3 inheriting the session model ran every gate lane on Sonnet when Sonnet launched.
const gateLanes = ['plan', 'implement', 'fix', 'review-axis', 'confidence-dim', 'reverify', 'qa-judge', 'resolver', 'owner-proxy', 'second-opinion']
t('no facts: every gate/judgment lane is pinned to opus, never inherited', gateLanes.filter(l => !(defaults[l].tier === 'T3' && defaults[l].model === 'opus')))
t('no facts: bookkeeping lanes stay on sonnet', ['premise', 'pr-description', 'log-prose', 'sweep-summary'].filter(l => defaults[l].model !== 'sonnet'))
t('no facts: T2 lanes resolve to sonnet', defaults['pr-description'].model === 'sonnet' ? [] : [JSON.stringify(defaults['pr-description'])])

// Judgment lanes run through `claude -p --max-budget-usd`; every tier needs a cap and fan-out needs a limit.
t('config: every tier has a positive USD budget cap', Object.keys(config.tiers).filter(k => !(config.budgetsUsd && config.budgetsUsd[k] > 0)))
t('config: concurrency is a positive integer', Number.isInteger(config.concurrency) && config.concurrency > 0 ? [] : [String(config.concurrency)])
t('config: a per-lane budgetUsd override, when present, is positive', Object.entries(config.lanes).filter(([, d]) => 'budgetUsd' in d && !(d.budgetUsd > 0)).map(([l]) => l))

// Lowering a gate:true lane below T3 is refused.
const lowerGate = JSON.parse(readFileSync(join(FIX, 'facts-lower-gate-lane.json'), 'utf8'))
const { routing: r1, error: e1 } = resolveRouting(config, lowerGate)
t('lowering a gate:true lane is refused', !r1 && e1 && e1.kind === 'policy' ? [] : [JSON.stringify({ r1, e1 })])

// Lowering a non-gate lane is accepted.
const lowerNonGate = JSON.parse(readFileSync(join(FIX, 'facts-lower-nongate-lane.json'), 'utf8'))
const { routing: r2, error: e2 } = resolveRouting(config, lowerNonGate)
t('lowering a non-gate lane is accepted', !e2 && r2['pr-description'].tier === 'T1' && r2['pr-description'].model === 'haiku' ? [] : [JSON.stringify({ r2, e2 })])

// Raising a non-gate lane is accepted too.
const raiseNonGate = { modelRouting: { premise: 'T3' } }
const { routing: r3, error: e3 } = resolveRouting(config, raiseNonGate)
t('raising a non-gate lane above its default is accepted', !e3 && r3.premise.tier === 'T3' && r3.premise.model === 'opus' ? [] : [JSON.stringify({ r3, e3 })])

// A gate:true lane overridden to T3 (a no-op) is accepted, not refused.
const noopGate = { modelRouting: { plan: 'T3' } }
const { routing: r4, error: e4 } = resolveRouting(config, noopGate)
t('a gate:true lane explicitly pinned to T3 is accepted', !e4 && r4.plan.tier === 'T3' ? [] : [JSON.stringify({ r4, e4 })])

// A tier may be a model list; empty or not configured at all, it resolves nobody and is refused.
t('config: every shipped tier names a model', Object.keys(config.tiers).filter(k => !tierModel(config.tiers, k)))
const { routing: r5, error: e5 } = resolveRouting({ ...config, tiers: { ...config.tiers, T4: [] } }, { modelRouting: { premise: 'T4' } })
t('routing a lane to an empty tier is refused', !r5 && e5 && e5.kind === 'policy' && /T4/.test(e5.reason) ? [] : [JSON.stringify({ r5, e5 })])
const { routing: r5b, error: e5b } = resolveRouting(config, { modelRouting: { premise: 'T4' } })
t('routing a lane to a tier that is not configured is refused, never resolved to no model', !r5b && e5b && e5b.kind === 'policy' && /T4/.test(e5b.reason) ? [] : [JSON.stringify({ r5b, e5b })])
const { routing: r6, error: e6 } = resolveRouting({ ...config, tiers: { ...config.tiers, T4: ['opus'] } }, { modelRouting: { premise: 'T4' } })
t('a tier given as a model list resolves to its first model', !e6 && r6.premise.model === 'opus' && r6.premise.tier === 'T4' ? [] : [JSON.stringify({ r6, e6 })])
t('no facts: second-opinion is a T3 gate lane on opus', defaults['second-opinion'] && defaults['second-opinion'].tier === 'T3' && defaults['second-opinion'].model === 'opus' ? [] : [JSON.stringify(defaults['second-opinion'])])

// CLI end to end: exit 0 on defaults, exit 4 on a gate-lane refusal.
const cliOk = spawnSync(process.execPath, [RESOLVE, CONFIG], { encoding: 'utf8' })
t('CLI exits 0 on defaults', cliOk.status === 0 ? [] : [`exit ${cliOk.status}: ${cliOk.stdout}${cliOk.stderr}`])
t('CLI prints one JSON line with status ok', (() => { try { return JSON.parse(cliOk.stdout.trim()).status === 'ok' ? [] : ['status not ok'] } catch (e) { return [e.message] } })())

const cliRefused = spawnSync(process.execPath, [RESOLVE, CONFIG, join(FIX, 'facts-lower-gate-lane.json')], { encoding: 'utf8' })
t('CLI exits 4 refusing a lowered gate lane', cliRefused.status === 4 ? [] : [`exit ${cliRefused.status}: ${cliRefused.stdout}${cliRefused.stderr}`])
t('CLI refusal line has status refused, kind policy', (() => {
  try { const d = JSON.parse(cliRefused.stdout.trim()); return d.status === 'refused' && d.kind === 'policy' ? [] : [JSON.stringify(d)] }
  catch (e) { return [e.message] }
})())

for (const r of catalogueChecks(REPO_ROOT)) results.push(r)
for (const r of routeChecks(REPO_ROOT, FIX)) results.push(r)
for (const r of launchChecks(REPO_ROOT)) results.push(r)
for (const r of ladderChecks(REPO_ROOT, FIX)) results.push(r)
for (const r of recordChecks(REPO_ROOT, FIX)) results.push(r)

const failed = results.filter(r => r.errs.length)
for (const r of results) {
  console.log(`${r.errs.length ? 'FAIL' : 'ok  '} ${r.label}`)
  for (const e of r.errs) console.log(`       ${e}`)
}
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length} checks`)
process.exit(failed.length ? 1 : 0)
