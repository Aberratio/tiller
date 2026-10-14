#!/usr/bin/env node
// Launch-time policy check of the model catalogue against the lane requirements.
//
//   node lib/routing/validate-launch.mjs <config-dir> [facts.json]
//
// <config-dir> holds routing.json, models.json and lanes.json. Prints one script-result line and
// exits 4 (refused, kind policy) on any violation, 0 otherwise.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../contract/validate.mjs'
import { route } from './route.mjs'
import { emptyTier } from './resolve.mjs'

// Config may raise the gate floor, never lower it.
export const GATE_FLOOR_MIN = 0.85
const REVIEW_LANE = 'review-axis'
const IMPLEMENT_LANE = 'implement'

// Static eligibility: every runtime assumed up, no cooldown, no budget spent, trial never allowed.
function staticRoute(lane, catalogue, lanes) {
  const runtimes = Object.fromEntries(Object.values(catalogue.models).map(m => [m.runtime, { available: true }]))
  return route(lane, catalogue, lanes, { asOf: '1970-01-01T00:00:00Z', runtimes })
}

export function validateLaunch(catalogue, lanes, routing, facts) {
  const errors = []
  const err = (rule, reason) => errors.push({ rule, reason })
  const laneDefs = lanes.lanes || {}

  const want = Object.keys(routing.lanes).sort(), have = Object.keys(laneDefs).sort()
  if (JSON.stringify(want) !== JSON.stringify(have)) err('lanes-mismatch', `lanes.json lanes ${have} differ from routing.json lanes ${want}`)
  for (const [lane, def] of Object.entries(routing.lanes)) {
    if (laneDefs[lane] && (laneDefs[lane].gate === true) !== (def.gate === true)) err('lanes-mismatch', `lane "${lane}" gate flag differs from routing.json`)
  }

  if (!(lanes.gateFloor >= GATE_FLOOR_MIN)) err('gate-below-floor', `gateFloor ${lanes.gateFloor} is below ${GATE_FLOOR_MIN}`)
  const gateLanes = Object.keys(laneDefs).filter(l => laneDefs[l].gate === true || routing.lanes[l]?.gate === true).sort()
  for (const lane of gateLanes) {
    if (!(laneDefs[lane].minCapability >= Math.max(lanes.gateFloor, GATE_FLOOR_MIN))) err('gate-below-floor', `gate lane "${lane}" minCapability ${laneDefs[lane].minCapability} is below the gate floor`)
  }

  for (const name of Object.keys(catalogue.models).sort()) {
    const m = catalogue.models[name]
    const gatePins = (m.pinnedLanes || []).filter(l => gateLanes.includes(l))
    if (m.runtime !== 'claude' && !['trial', 'disabled'].includes(m.status)) err('non-claude-not-trial', `model "${name}" on runtime ${m.runtime} has status ${m.status}; only trial or disabled is allowed`)
    if (gatePins.length && m.runtime !== 'claude') err('gate-non-claude-pinned', `model "${name}" on runtime ${m.runtime} is pinned to gate lanes ${gatePins}`)
    if (gatePins.length && m.status === 'trial') err('gate-trial-pinned', `trial model "${name}" is pinned to gate lanes ${gatePins}`)
  }

  const best = {}
  for (const lane of gateLanes) {
    const r = staticRoute(lane, catalogue, lanes)
    if (r.candidates.length === 0) err('gate-no-eligible-model', `gate lane "${lane}" has no eligible model: ${JSON.stringify(r.rejected)}`)
    else best[lane] = r.candidates[0].score
  }
  if (typeof best[REVIEW_LANE] === 'number' && typeof best[IMPLEMENT_LANE] === 'number' && best[REVIEW_LANE] < best[IMPLEMENT_LANE]) {
    err('review-below-implement', `best ${REVIEW_LANE} score ${best[REVIEW_LANE]} is below best ${IMPLEMENT_LANE} score ${best[IMPLEMENT_LANE]}`)
  }

  const overrides = (facts && facts.modelRouting) || {}
  for (const [lane, wanted] of Object.entries(overrides)) {
    if (gateLanes.includes(lane) && wanted !== 'T3') err('gate-override', `gate lane "${lane}" override "${wanted}" is below the T3 floor`)
  }
  for (const [lane, def] of Object.entries(routing.lanes)) {
    const tier = overrides[lane] ?? def.tier
    if (emptyTier(routing.tiers, tier)) err('empty-tier', `lane "${lane}" is routed to tier "${tier}", which lists no model`)
  }
  return errors
}

function emit(doc, code) {
  console.log(JSON.stringify(doc))
  const errs = check('script-result', doc)
  if (errs.length) { console.error(errs.join('\n')); process.exit(1) }
  process.exit(code)
}

function main() {
  const [dir, factsPath] = process.argv.slice(2)
  if (!dir) emit({ status: 'error', kind: 'script-error', reason: 'usage: validate-launch.mjs <config-dir> [facts.json]' }, 1)
  let catalogue, lanes, routing, facts
  try {
    const load = p => JSON.parse(readFileSync(p, 'utf8'))
    catalogue = load(join(dir, 'models.json')); lanes = load(join(dir, 'lanes.json')); routing = load(join(dir, 'routing.json'))
    if (factsPath) facts = load(factsPath)
  } catch (e) { emit({ status: 'error', kind: 'script-error', reason: `cannot read config: ${e.message}` }, 1) }
  const errors = validateLaunch(catalogue, lanes, routing, facts)
  if (errors.length) emit({ status: 'refused', kind: 'policy', reason: errors.map(e => `${e.rule}: ${e.reason}`).join('; ') }, 4)
  emit({ status: 'ok' }, 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
