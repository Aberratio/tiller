// route() against the 18-r2 test table (rows 1-20, 31). Fixture: strong (gate-pinned), mid, cheap,
// and a trial self-hosted model; lanes implement (gate), premise, log-prose.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { route, REJECT_REASONS } from '../route.mjs'
import { resolveRouting } from '../resolve.mjs'

const UP = { asOf: '2026-10-07T09:00:00Z', runtimes: { claude: { available: true }, 'openai-compat': { available: true } } }

export function checks(repoRoot, fixDir) {
  const load = p => JSON.parse(readFileSync(p, 'utf8'))
  const CAT = load(join(fixDir, 'route-catalogue.json'))
  const LANES = load(join(fixDir, 'route-lanes.json'))
  const out = []
  const t = (label, errs) => out.push({ label, errs })
  const why = (r, m) => (r.rejected.find(x => x.model === m) || {}).why
  const names = r => r.candidates.map(c => c.model)
  const edit = (fn, base = CAT) => { const c = structuredClone(base); fn(c.models); return c }
  const editLanes = fn => { const l = structuredClone(LANES); fn(l.lanes); return l }
  const expect = (label, got, want) => t(label, JSON.stringify(got) === JSON.stringify(want) ? [] : [`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`])

  // 1 determinism, shuffled key order
  const shuffled = { schema: 1, models: Object.fromEntries(Object.entries(CAT.models).reverse()) }
  const a = route('premise', CAT, LANES, UP), b = route('premise', shuffled, LANES, structuredClone(UP))
  expect('1 determinism: same candidates and decisionId under shuffled key order', [names(b), b.decisionId, b.rejected], [names(a), a.decisionId, a.rejected])
  t('1 decisionId changes when an input changes', route('premise', CAT, LANES, { ...UP, asOf: '2026-10-07T09:00:01Z' }).decisionId !== a.decisionId ? [] : ['same id'])
  // 2 unknown lane
  t('2 unknown lane throws', (() => { try { route('nope', CAT, LANES, UP); return ['no throw'] } catch { return [] } })())
  // 3 disabled
  expect('3 disabled model rejected "disabled"', why(route('premise', edit(m => { m.mid.status = 'disabled' }), LANES, UP), 'mid'), 'disabled')
  // 4 trial
  expect('4 trial excluded without allowTrial', why(route('log-prose', CAT, LANES, UP), 'local'), 'trial')
  t('4 trial included with allowTrial', names(route('log-prose', CAT, LANES, UP, { allowTrial: true })).includes('local') ? [] : ['local missing'])
  // 5 runtime down / unknown
  const down = { ...UP, runtimes: { claude: { available: true }, 'openai-compat': { available: false, reason: 'no-binary' } } }
  expect('5 runtime unavailable: its models rejected "runtime-down"', why(route('log-prose', CAT, LANES, down, { allowTrial: true }), 'local'), 'runtime-down')
  expect('5 runtime absent from the snapshot counts as down', why(route('log-prose', CAT, LANES, { asOf: UP.asOf, runtimes: { claude: { available: true } } }, { allowTrial: true }), 'local'), 'runtime-down')
  // 6 cooldown, inclusive expiry
  const cool = until => ({ ...UP, cooldown: { mid: { until, failures: 3 } } })
  expect('6 cooldown active (until > asOf) rejected "cooldown"', why(route('premise', CAT, LANES, cool('2026-10-07T09:05:00Z')), 'mid'), 'cooldown')
  t('6 cooldown expired at asOf (until == asOf) is eligible', names(route('premise', CAT, LANES, cool(UP.asOf))).includes('mid') ? [] : ['mid missing'])
  // 7 tools
  expect('7 lane needs tools, model toolUse false -> "no-tools"', why(route('premise', edit(m => { m.cheap.features.toolUse = false }), LANES, UP), 'cheap'), 'no-tools')
  // 8 structured output
  expect('8 lane needs schema, model json-mode -> "structured-output"', why(route('premise', edit(m => { m.cheap.features.structuredOutput = 'json-mode' }), LANES, UP), 'cheap'), 'structured-output')
  // 9 context
  expect('9 minContext above window -> "context"', why(route('premise', CAT, editLanes(l => { l.premise.minContext = 500000 }), UP), 'cheap'), 'context')
  // data policy (C5 step 4)
  expect('data policy outside the allowed list -> "data-policy"', why(route('log-prose', CAT, LANES, UP, { allowTrial: true, dataPolicies: ['no-train'] }), 'local'), 'data-policy')
  // 10 unmeasured
  expect('10 capability null for the lane -> "unmeasured"', why(route('premise', edit(m => { m.cheap.capability.premise = null }), LANES, UP), 'cheap'), 'unmeasured')
  // 11 threshold boundary
  expect('11 score 0.69 under min 0.70 -> "below-min"', why(route('premise', edit(m => { m.cheap.capability.premise.score = 0.69 }), LANES, UP), 'cheap'), 'below-min')
  t('11 score 0.70 at min 0.70 accepted', names(route('premise', edit(m => { m.cheap.capability.premise.score = 0.7 }), LANES, UP)).includes('cheap') ? [] : ['cheap missing'])
  // 12 lane beats class
  expect('12 lane-level score 0.5 beats class-level 0.9 -> "below-min"', why(route('log-prose', edit(m => { m.strong.capability['log-prose'] = { score: 0.5, evalRun: 'ev-2', n: 30 } }), LANES, UP), 'strong'), 'below-min')
  // 13 gate pinned
  expect('13 gate lane, model not pinned but score 0.99 -> "not-pinned"', why(route('implement', CAT, LANES, UP), 'mid'), 'not-pinned')
  // 14 gate floor
  expect('14 gate lane, pinned model under gateFloor -> "gate-floor"', why(route('implement', edit(m => { m.strong.capability.judgment.score = 0.8 }), LANES, UP), 'strong'), 'gate-floor')
  t('14 gate lane, pinned and unmeasured is admitted by the pin', names(route('implement', edit(m => { m.strong.capability = {} }), LANES, UP)).includes('strong') ? [] : ['strong missing'])
  expect('gate lane never admits a trial model, even with allowTrial', why(route('implement', edit(m => { m.strong.status = 'trial' }), LANES, UP, { allowTrial: true }), 'strong'), 'trial')
  // 15 cost cap
  expect('15 estimated cost above maxCostUsdPerCall -> "cost"', why(route('log-prose', CAT, editLanes(l => { l['log-prose'].maxCostUsdPerCall = 0.5 }), UP), 'strong'), 'cost')
  const recent = { ...UP, recent: { 'strong|log-prose': { calls: 10, meanTokens: { in: 10000, out: 1000 } } } }
  t('15 recent mean tokens replace the reference estimate', (route('log-prose', CAT, editLanes(l => { l['log-prose'].maxCostUsdPerCall = 0.5 }), recent).candidates.find(c => c.model === 'strong') || {}).estCostUsd === 0.06 ? [] : ['strong not at $0.06'])
  // 16 budget
  expect('16 run budget below the estimate -> "budget"', why(route('premise', CAT, LANES, { ...UP, budget: { runUsdLeft: 0.5, dayUsdLeft: 60 } }), 'strong'), 'budget')
  expect('16 day budget below the estimate -> "budget"', why(route('premise', CAT, LANES, { ...UP, budget: { runUsdLeft: 50, dayUsdLeft: 0.5 } }), 'strong'), 'budget')
  // 17 cost order
  expect('17 sort by cost: cheaper first', names(route('premise', CAT, LANES, UP)), ['cheap', 'mid', 'strong'])
  expect('17 prefer quality: higher score first', names(route('premise', CAT, LANES, UP, { prefer: 'quality' })), ['strong', 'mid', 'cheap'])
  // 18 tie-break
  const tie = edit(m => { m.cheap.priceUsdPerMtok = { ...m.mid.priceUsdPerMtok }; m.cheap.contextWindow = 1000000; m.cheap.capability.premise.score = 0.8 })
  expect('18 equal cost and score: alphabetical key first', names(route('premise', tie, LANES, UP)).slice(0, 2), ['cheap', 'mid'])
  // 19 gate sorts by score
  const twoPinned = edit(m => { m.mid.pinnedLanes = ['implement']; m.mid.capability.judgment.score = 0.9 })
  expect('19 gate lane: higher score first even when dearer', names(route('implement', twoPinned, LANES, UP)), ['strong', 'mid'])
  // 20 empty
  const none = route('implement', edit(m => { m.strong.status = 'disabled' }), LANES, UP)
  expect('20 all rejected: no candidates, park no-eligible-model', [none.candidates, none.park], [[], 'no-eligible-model'])
  // closed reason set
  const all = ['implement', 'premise', 'log-prose'].flatMap(l => route(l, edit(m => { m.mid.status = 'disabled' }), LANES, down).rejected)
  t('every rejection reason is from the closed set', all.filter(r => !REJECT_REASONS.includes(r.why)).map(r => r.why))
  t('every rejected model appears once, sorted', ['implement', 'premise', 'log-prose'].flatMap(l => { const r = route(l, CAT, LANES, UP).rejected.map(x => x.model); return JSON.stringify(r) === JSON.stringify([...new Set(r)].sort()) ? [] : [`${l}: ${r}`] }))

  // second opinion: `avoid` is the model that produced the contested output. Another admitted model at
  // the same or a higher tier goes first; without one the same model leads and sameModel is recorded.
  const tiers = { T1: 'cheap', T2: 'mid', T3: 'strong' }
  const peers = edit(m => { m.mid.pinnedLanes = ['implement']; m.mid.capability.judgment.score = 0.9 })
  expect('candidates carry the tier of the model when opts.tiers is given', route('premise', CAT, LANES, UP, { tiers }).candidates.map(c => [c.model, c.tier]), [['cheap', 'T1'], ['mid', 'T2'], ['strong', 'T3']])
  expect('a tier given as a model list is read like a string tier', route('premise', CAT, LANES, UP, { tiers: { T2: ['mid'], T3: ['strong', 'cheap'] } }).candidates.map(c => c.tier), ['T3', 'T2', 'T3'])
  t('no avoid: the result carries no sameModel flag', 'sameModel' in route('implement', peers, LANES, UP, { tiers }) ? ['sameModel present'] : [])
  const same = route('implement', peers, LANES, UP, { avoid: 'strong', tiers })
  expect('avoid strong, only a lower-tier peer admitted: same model first, sameModel true', [names(same), same.sameModel], [['strong', 'mid'], true])
  const up = route('implement', peers, LANES, UP, { avoid: 'mid', tiers })
  expect('avoid mid, a higher-tier peer admitted: the peer first, sameModel false', [names(up), up.sameModel], [['strong', 'mid'], false])
  const twin = structuredClone(peers); twin.models.twin = structuredClone(peers.models.strong); twin.models.twin.capability.judgment.score = 0.9
  const side = route('implement', twin, LANES, UP, { avoid: 'strong', tiers: { ...tiers, T3: ['strong', 'twin'] } })
  expect('avoid strong with a same-tier peer: the peer first, then strong, then lower tiers; sameModel false', [names(side), side.sameModel], [['twin', 'strong', 'mid'], false])
  const blind = route('implement', peers, LANES, UP, { avoid: 'strong' })
  expect('avoid without tiers: an admitted peer of unknown tier counts as the same tier', [names(blind), blind.sameModel], [['mid', 'strong'], false])
  expect('avoid a model that is not a candidate: order unchanged, sameModel false', [names(route('implement', peers, LANES, UP, { avoid: 'cheap', tiers })), route('implement', peers, LANES, UP, { avoid: 'cheap', tiers }).sameModel], [['strong', 'mid'], false])
  t('avoid changes the decisionId', route('implement', peers, LANES, UP, { avoid: 'strong', tiers }).decisionId !== route('implement', peers, LANES, UP, { tiers }).decisionId ? [] : ['same id'])

  // measured scores (config/measured.json, state.measured) only demote: a lower measured score
  // replaces the hand score, a higher one is ignored, an unmeasured pin gains a score only when it fails.
  const measured = (model, lane, score, n = 12) => ({ ...UP, measured: { [model]: { [lane]: { score, n, evalRun: 'calibrate-2026-10-14' } } } })
  const scoreIn = (r, m) => (r.candidates.find(c => c.model === m) || {}).score
  expect('measured below the hand score replaces it', scoreIn(route('premise', CAT, LANES, measured('strong', 'premise', 0.75)), 'strong'), 0.75)
  t('a demoted candidate says so in why', (route('premise', CAT, LANES, measured('strong', 'premise', 0.75)).candidates.find(c => c.model === 'strong') || { why: [] }).why.includes('measured:calibrate-2026-10-14') ? [] : ['no measured why'])
  expect('measured above the hand score is ignored', scoreIn(route('premise', CAT, LANES, measured('strong', 'premise', 0.99)), 'strong'), 0.9)
  expect('measured below minCapability rejects "below-min"', why(route('premise', CAT, LANES, measured('strong', 'premise', 0.6)), 'strong'), 'below-min')
  expect('measured without an evalRun is ignored', scoreIn(route('premise', CAT, LANES, { ...UP, measured: { strong: { premise: { score: 0.1, n: 50 } } } }), 'strong'), 0.9)
  const unpinnedCat = edit(m => { m.strong.capability = {} })
  expect('an unmeasured pin keeps its pin admission when the measured score passes the lane', (route('implement', unpinnedCat, LANES, measured('strong', 'implement', 0.9)).candidates.find(c => c.model === 'strong') || {}).why, ['pinned', 'unmeasured-admitted-by-pin'])
  const errs = []
  const origErr = console.error
  console.error = (...a) => errs.push(a.join(' '))
  let dropped
  try {
    dropped = route('implement', CAT, LANES, measured('strong', 'implement', 0.8))
    route('implement', CAT, LANES, measured('strong', 'implement', 0.8))
    route('implement', unpinnedCat, LANES, measured('strong', 'implement', 0.8))
  } finally { console.error = origErr }
  expect('measured below the gate floor drops a pinned model from the gate lane', [why(dropped, 'strong'), dropped.park], ['gate-floor', 'no-eligible-model'])
  t('the drop is said once on stderr, naming model, lane, score and eval run', errs.length === 1 && /strong measured 0\.8 on implement .*calibrate-2026-10-14/.test(errs[0]) ? [] : errs.length ? errs : ['no stderr line'])
  t('measured changes the decisionId', route('premise', CAT, LANES, measured('strong', 'premise', 0.75)).decisionId !== route('premise', CAT, LANES, UP).decisionId ? [] : ['same id'])

  // 31 day-one golden: real catalogue, real lanes, Claude runtime up.
  const cfg = n => load(join(repoRoot, 'config', n))
  const routing = cfg('routing.json')
  const { routing: today } = resolveRouting(routing, undefined)
  const order = ['T1', 'T2', 'T3']
  const diffs = []
  for (const [lane, r] of Object.entries(today)) {
    const i = order.indexOf(r.tier)
    const want = [r.model, ...(i < 2 ? [routing.tiers[order[i + 1]]] : [])]
    const got = route(lane, cfg('models.json'), cfg('lanes.json'), { asOf: UP.asOf, runtimes: { claude: { available: true } } })
    if (JSON.stringify(names(got)) !== JSON.stringify(want)) diffs.push(`${lane}: ${names(got)} vs today ${want} (rejected ${JSON.stringify(got.rejected)})`)
  }
  t('31 day-one golden: route() returns today\'s model, then today\'s escalation target, for every lane', diffs)
  return out
}
