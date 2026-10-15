// Launch validator (18-r2 rows 21-23 plus the non-Claude rules) and its wiring into resolve.mjs.

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchWarnings, validateLaunch } from '../validate-launch.mjs'
import { route } from '../route.mjs'
import { withPrices } from '../../driver/adapters/budget.mjs'

export function checks(repoRoot) {
  const out = []
  const t = (label, errs) => out.push({ label, errs })
  const cfg = n => JSON.parse(readFileSync(join(repoRoot, 'config', n), 'utf8'))
  const base = { catalogue: cfg('models.json'), lanes: cfg('lanes.json'), routing: cfg('routing.json'), prices: cfg('prices.json') }
  const run = (fn, facts) => { const b = structuredClone(base); fn(b); return validateLaunch(b.catalogue, b.lanes, b.routing, facts, b.prices).map(e => e.rule) }
  const refuses = (label, rule, fn, facts) => { const rules = run(fn, facts); t(label, rules.includes(rule) ? [] : [`rules: ${JSON.stringify(rules)}`]) }
  const other = extra => ({ runtime: 'openai-compat', modelId: 'x', status: 'trial', contextWindow: 1000000,
    features: { structuredOutput: 'schema', toolUse: true }, dataPolicy: 'no-train', pinnedLanes: [], capability: {}, ...extra })

  t('launch: shipped catalogue, lanes and routing pass', run(() => {}))
  refuses('21 gate lane minCapability lowered below gateFloor', 'gate-below-floor', b => { b.lanes.lanes.plan.minCapability = 0.8 })
  refuses('21 gateFloor itself lowered below the built-in floor', 'gate-below-floor', b => { b.lanes.gateFloor = 0.5 })
  refuses('22 gate lane with no pinned model and no evalRun', 'gate-no-eligible-model', b => { b.catalogue.models.opus.pinnedLanes = b.catalogue.models.opus.pinnedLanes.filter(l => l !== 'plan') })
  refuses('trial model pinned to a gate lane', 'gate-trial-pinned', b => { b.catalogue.models.opus.status = 'trial' })
  refuses('non-Claude model pinned to a gate lane', 'gate-non-claude-pinned', b => { b.catalogue.models.local = other({ pinnedLanes: ['plan'] }) })
  refuses('non-Claude model with status active', 'non-claude-not-trial', b => { b.catalogue.models.local = other({ status: 'active' }) })
  t('non-Claude model with status trial or disabled, unpinned from gates, passes', run(b => { b.catalogue.models.local = other({ pinnedLanes: ['log-prose'] }); b.catalogue.models.off = other({ status: 'disabled' }) }))
  refuses('23 review lane best score below implement best score', 'review-below-implement', b => {
    b.catalogue.models.opus.capability = { implement: { score: 0.95, evalRun: 'ev', n: 100 }, 'review-axis': { score: 0.9, evalRun: 'ev', n: 100 } } })
  t('23 review at or above implement passes', run(b => {
    b.catalogue.models.opus.capability = { implement: { score: 0.9, evalRun: 'ev', n: 100 }, 'review-axis': { score: 0.9, evalRun: 'ev', n: 100 } } }))
  refuses('active model with no entry in prices.json', 'no-price', b => { delete b.prices.models['claude/haiku'] })
  t('an unverified price only warns: launch passes and names the entry', (() => {
    const b = structuredClone(base)
    const errs = validateLaunch(b.catalogue, b.lanes, b.routing, undefined, b.prices).map(e => e.rule)
    const w = launchWarnings(b.catalogue, b.prices)
    return [...errs, ...(w.some(x => x.includes('claude/opus')) ? [] : [`warnings: ${JSON.stringify(w)}`])]
  })())
  t('a verified price raises no warning', launchWarnings(base.catalogue, { models: { 'claude/*': { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } } }))
  t('a model with no price is routed around (no-price), never costed as zero', (() => {
    const cat = withPrices({ models: { solo: { runtime: 'codex', modelId: 'x', status: 'active', contextWindow: 1000000,
      features: { structuredOutput: 'schema', toolUse: true }, dataPolicy: 'no-train', pinnedLanes: ['log-prose'], capability: {} } } }, { models: {} })
    const r = route('log-prose', cat, base.lanes, { asOf: '1970-01-01T00:00:00Z', runtimes: { codex: { available: true } } })
    return r.rejected.some(x => x.model === 'solo' && x.why === 'no-price') ? [] : [`rejected: ${JSON.stringify(r.rejected)}`]
  })())
  refuses('lanes.json missing a routing lane', 'lanes-mismatch', b => { delete b.lanes.lanes.premise })
  refuses('lanes.json gate flag disagrees with routing.json', 'lanes-mismatch', b => { b.lanes.lanes.premise.gate = true })
  refuses('facts override moves a gate lane off T3', 'gate-override', () => {}, { modelRouting: { plan: 'T2' } })
  refuses('facts override routes a lane to a tier with no model', 'empty-tier', () => {}, { modelRouting: { 'pr-description': 'T4' } })
  t('a lane routed to a tier that lists a model passes', run(b => { b.routing.tiers.T4 = ['opus']; b.routing.budgetsUsd.T4 = 15 }, { modelRouting: { 'pr-description': 'T4' } }))

  // resolve.mjs refuses through its existing exit-4 path when the catalogue beside routing.json is unsafe.
  const dir = mkdtempSync(join(tmpdir(), 'route-launch-'))
  try {
    const bad = structuredClone(base.catalogue); bad.models.opus.status = 'trial'
    writeFileSync(join(dir, 'routing.json'), JSON.stringify(base.routing))
    writeFileSync(join(dir, 'lanes.json'), JSON.stringify(base.lanes))
    writeFileSync(join(dir, 'models.json'), JSON.stringify(bad))
    const r = spawnSync(process.execPath, [join(repoRoot, 'lib', 'routing', 'resolve.mjs'), join(dir, 'routing.json')], { encoding: 'utf8' })
    let d = {}; try { d = JSON.parse(r.stdout.trim()) } catch {}
    t('resolve CLI exits 4 kind policy when the sibling catalogue pins a trial model to a gate lane', r.status === 4 && d.status === 'refused' && d.kind === 'policy' ? [] : [`exit ${r.status}: ${r.stdout}${r.stderr}`])
    const v = spawnSync(process.execPath, [join(repoRoot, 'lib', 'routing', 'validate-launch.mjs'), dir], { encoding: 'utf8' })
    t('validate-launch CLI exits 4 on the same directory', v.status === 4 ? [] : [`exit ${v.status}: ${v.stdout}${v.stderr}`])
    const ok = spawnSync(process.execPath, [join(repoRoot, 'lib', 'routing', 'validate-launch.mjs'), join(repoRoot, 'config')], { encoding: 'utf8' })
    t('validate-launch CLI exits 0 on config/', ok.status === 0 ? [] : [`exit ${ok.status}: ${ok.stdout}${ok.stderr}`])
    t('validate-launch CLI warns on stderr about unverified prices', /warning: price for claude\/\w+ is marked unverified/.test(ok.stderr) ? [] : [`stderr: ${ok.stderr}`])
  } finally { rmSync(dir, { recursive: true, force: true }) }
  return out
}
