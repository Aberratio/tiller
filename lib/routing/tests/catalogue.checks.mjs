// Day-one equivalence of config/models.json + config/lanes.json against config/routing.json.
// Every lane must land on today's model, today's per-call budget, and today's one-tier-up
// escalation target, before anything else in the catalogue is allowed to matter.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRouting } from '../resolve.mjs'
import { priceFor } from '../../driver/adapters/budget.mjs'

const RUNTIMES = ['claude', 'codex', 'copilot', 'openai-compat']
const STATUSES = ['active', 'trial', 'disabled']
const STRUCTURED = ['none', 'json-mode', 'schema']
const TIER_ORDER = ['T1', 'T2', 'T3']

export function checks(repoRoot) {
  const cfg = n => JSON.parse(readFileSync(join(repoRoot, 'config', n), 'utf8'))
  const routing = cfg('routing.json')
  const { models } = cfg('models.json')
  const lanes = cfg('lanes.json')
  const prices = cfg('prices.json')
  const price = (k, m) => priceFor(prices, m.runtime, k)
  const out = []
  const t = (label, errs) => out.push({ label, errs })

  t('models.json: every model has a known runtime, status and structured-output level', Object.entries(models).flatMap(([k, m]) => [
    !RUNTIMES.includes(m.runtime) && `${k}: runtime ${m.runtime}`,
    !STATUSES.includes(m.status) && `${k}: status ${m.status}`,
    !STRUCTURED.includes(m.features?.structuredOutput) && `${k}: structuredOutput ${m.features?.structuredOutput}`,
    typeof m.features?.toolUse !== 'boolean' && `${k}: toolUse`,
    !(m.contextWindow > 0) && `${k}: contextWindow`,
    !m.dataPolicy && `${k}: dataPolicy`,
    !Array.isArray(m.pinnedLanes) && `${k}: pinnedLanes`,
  ].filter(Boolean)))
  t('models.json: carries no prices; config/prices.json is the only price table', Object.entries(models).filter(([, m]) => 'priceUsdPerMtok' in m).map(([k]) => k))
  t('prices.json: every model has in, out, cacheRead and cacheCreate', Object.entries(models).flatMap(([k, m]) => {
    const p = price(k, m)
    return ['in', 'out', 'cacheRead', 'cacheCreate'].filter(f => !(p?.[f] >= 0)).map(f => `${m.runtime}/${k}: ${f}`)
  }))
  t('models.json: holds Claude models only today', Object.entries(models).filter(([, m]) => m.runtime !== 'claude').map(([k]) => k))
  t('models.json: every capability score is unmeasured (null) until an eval run exists', Object.entries(models)
    .flatMap(([k, m]) => Object.entries(m.capability || {}).filter(([, v]) => v !== null && !v.evalRun).map(([l]) => `${k}.${l}`)))
  t('lanes.json: covers exactly the lanes of routing.json', JSON.stringify(Object.keys(lanes.lanes).sort()) === JSON.stringify(Object.keys(routing.lanes).sort())
    ? [] : [`lanes.json ${Object.keys(lanes.lanes).sort()} vs routing.json ${Object.keys(routing.lanes).sort()}`])
  t('lanes.json: gate flag agrees with routing.json', Object.keys(routing.lanes).filter(l => !!routing.lanes[l].gate !== !!lanes.lanes[l]?.gate))
  t('lanes.json: every lane carries class, minCapability, needs, maxCostUsdPerCall, maxLadderSteps', Object.entries(lanes.lanes).flatMap(([l, d]) => [
    !d.class && `${l}: class`, typeof d.minCapability !== 'number' && `${l}: minCapability`, !d.needs && `${l}: needs`,
    !(d.maxCostUsdPerCall > 0) && `${l}: maxCostUsdPerCall`, !Number.isInteger(d.maxLadderSteps) && `${l}: maxLadderSteps`,
  ].filter(Boolean)))

  // Old vs new, lane by lane: the cheapest pinned model is today's model, the next is today's
  // escalation target, and the per-call cap is today's tier budget.
  const { routing: today } = resolveRouting(routing, undefined)
  const pinned = l => Object.entries(models).filter(([, m]) => m.pinnedLanes.includes(l))
    .sort(([ka, a], [kb, b]) => price(ka, a).out - price(kb, b).out || (ka < kb ? -1 : 1)).map(([k]) => k)
  const mismatch = []
  for (const [lane, r] of Object.entries(today)) {
    const i = TIER_ORDER.indexOf(r.tier)
    const want = [r.model, ...(i < 2 ? [routing.tiers[TIER_ORDER[i + 1]]] : [])]
    const got = pinned(lane)
    if (JSON.stringify(got) !== JSON.stringify(want)) mismatch.push(`${lane}: pinned ladder ${got} vs today ${want}`)
    const budget = routing.lanes[lane].budgetUsd ?? routing.budgetsUsd[r.tier]
    if (lanes.lanes[lane]?.maxCostUsdPerCall !== budget) mismatch.push(`${lane}: maxCostUsdPerCall ${lanes.lanes[lane]?.maxCostUsdPerCall} vs today ${budget}`)
    // A gate lane may step sideways or up once (to a peer at its tier or above); a non-gate lane climbs to the next tier.
    const steps = routing.lanes[lane].gate ? 1 : want.length - 1
    if (lanes.lanes[lane]?.maxLadderSteps !== steps) mismatch.push(`${lane}: maxLadderSteps ${lanes.lanes[lane]?.maxLadderSteps} vs today ${steps}`)
  }
  t('day-one equivalence: every lane keeps its model, escalation target and budget', mismatch)
  return out
}
