// route(lane, catalogue, lanes, state, opts): pure model selection for one lane call.
// Returns ordered candidates, every rejected model with one closed reason, and a decisionId
// that is a hash of the inputs, so the same inputs always give the same id and the same order.

import { createHash } from 'node:crypto'

export const REJECT_REASONS = [
  'disabled', 'trial', 'runtime-down', 'cooldown', 'no-tools', 'structured-output', 'context',
  'data-policy', 'not-pinned', 'gate-floor', 'unmeasured', 'below-min', 'cost', 'budget',
]
export const PARK_NO_ELIGIBLE = 'no-eligible-model'

const OUTPUT_RANK = { none: 0, 'json-mode': 1, schema: 2 }
const round6 = n => Math.round(n * 1e6) / 1e6

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]))
  return v
}

export function decisionIdOf(inputs) {
  return createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex').slice(0, 16)
}

// A score counts only when it names the eval run that produced it.
function scoreOf(model, laneName, laneClass) {
  const cap = model.capability || {}
  const entry = Object.hasOwn(cap, laneName) ? cap[laneName] : cap[laneClass]
  return entry && typeof entry.score === 'number' && entry.evalRun ? entry.score : null
}

function estimate(model, key, lanes, state) {
  const tokens = state.recent?.[key]?.meanTokens ?? lanes.estTokens
  const p = model.priceUsdPerMtok
  return round6((tokens.in * p.in + tokens.out * p.out) / 1e6)
}

function rejectWhy(name, m, lane, laneName, lanes, state, opts) {
  if (m.status === 'disabled') return 'disabled'
  if (m.status === 'trial' && (lane.gate || !opts.allowTrial)) return 'trial'
  if (state.runtimes?.[m.runtime]?.available !== true) return 'runtime-down'
  const cool = state.cooldown?.[name]
  if (cool && Date.parse(cool.until) > Date.parse(state.asOf)) return 'cooldown'
  if (lane.needs?.tools && !m.features?.toolUse) return 'no-tools'
  if ((OUTPUT_RANK[m.features?.structuredOutput] ?? -1) < OUTPUT_RANK[lane.needs?.structuredOutput ?? 'none']) return 'structured-output'
  if (!(m.contextWindow >= lane.minContext)) return 'context'
  if (!(opts.dataPolicies ?? lanes.dataPolicies ?? []).includes(m.dataPolicy)) return 'data-policy'
  const pinned = (m.pinnedLanes || []).includes(laneName)
  const score = scoreOf(m, laneName, lane.class)
  if (lane.gate) {
    if (!pinned) return 'not-pinned'
    if (score !== null && score < lanes.gateFloor) return 'gate-floor'
  }
  if (score === null && !pinned) return 'unmeasured'
  if (score !== null && score < lane.minCapability) return 'below-min'
  const est = estimate(m, `${name}|${laneName}`, lanes, state)
  if (est > lane.maxCostUsdPerCall) return 'cost'
  const b = state.budget
  if (b && ((b.runUsdLeft ?? Infinity) < est || (b.dayUsdLeft ?? Infinity) < est)) return 'budget'
  return null
}

export function route(laneName, catalogue, lanes, state = {}, opts = {}) {
  const lane = lanes.lanes?.[laneName]
  if (!lane) throw new Error(`route: unknown lane ${laneName}`)
  const candidates = []
  const rejected = []
  for (const name of Object.keys(catalogue.models).sort()) {
    const m = catalogue.models[name]
    const why = rejectWhy(name, m, lane, laneName, lanes, state, opts)
    if (why) { rejected.push({ model: name, why }); continue }
    const score = scoreOf(m, laneName, lane.class)
    const pinned = (m.pinnedLanes || []).includes(laneName)
    candidates.push({
      model: name, runtime: m.runtime, estCostUsd: estimate(m, `${name}|${laneName}`, lanes, state), score,
      why: [pinned ? 'pinned' : 'measured', score === null ? 'unmeasured-admitted-by-pin' : `score>=${lane.minCapability}`],
    })
  }
  const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1)
  const byCost = (a, b) => a.estCostUsd - b.estCostUsd
  const keys = lane.gate || opts.prefer === 'quality' ? [byScore, byCost] : [byCost, byScore]
  candidates.sort((a, b) => keys[0](a, b) || keys[1](a, b) || (a.model < b.model ? -1 : 1))
  const out = {
    lane: { name: laneName, gate: lane.gate === true, maxLadderSteps: lane.maxLadderSteps, gateFloor: lanes.gateFloor, escalation: lanes.escalation },
    candidates, rejected,
    decisionId: decisionIdOf({ lane: laneName, catalogue, lanes, state, opts }),
  }
  if (candidates.length === 0) out.park = PARK_NO_ELIGIBLE
  return out
}
