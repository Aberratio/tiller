// nextCandidate(routeResult, failure): pure escalation ladder over route()'s ordered candidates.
// The caller carries `ladder` from one call to the next; it is returned updated, never mutated.
//
// failure.kind:
//   schema           output failed its schema: retry the same model with the error appended, then climb
//   verifier         the result failed verification: climb a limited number of times, then park
//   transport        429 / 5xx / network: cool the model down, move sideways without a ladder step
//   harness-blocked, blocked, died   not the model's fault: one identical retry, then park

import { PARK_NO_ELIGIBLE } from './route.mjs'

export const FAILURE_KINDS = ['schema', 'verifier', 'transport', 'harness-blocked', 'blocked', 'died']
export const PARK_REASONS = ['schema', 'verifier', 'ladder-exhausted', 'gate-floor', 'harness-blocked', 'blocked', 'died', PARK_NO_ELIGIBLE]
const DEFAULTS = { sameModelRetries: 1, verifierSteps: 1, identicalRetries: 1 }

export function nextCandidate(routeResult, failure) {
  const { kind, model } = failure
  if (!FAILURE_KINDS.includes(kind)) throw new Error(`nextCandidate: unknown failure kind ${kind}`)
  const prev = failure.ladder || {}
  const ladder = {
    steps: prev.steps ?? 0, verifierSteps: prev.verifierSteps ?? 0, sameModel: prev.sameModel ?? 0,
    identical: prev.identical ?? 0, tried: [...(prev.tried ?? [])], attempt: (prev.attempt ?? 1) + 1,
  }
  const lane = routeResult.lane
  const esc = { ...DEFAULTS, ...(lane.escalation || {}) }
  const park = reason => ({ action: 'park', park: reason, ladder })
  if (routeResult.candidates.length === 0) return park(PARK_NO_ELIGIBLE)

  if (['harness-blocked', 'blocked', 'died'].includes(kind)) {
    if (ladder.identical < esc.identicalRetries) { ladder.identical++; return { action: 'retry-identical', model, ladder } }
    return park(kind)
  }

  if (model && !ladder.tried.includes(model)) ladder.tried.push(model)
  const next = routeResult.candidates.find(c => !ladder.tried.includes(c.model))
  // A gate lane only ever moves to a model measured at or above the gate floor.
  const nextOk = next && (!lane.gate || (typeof next.score === 'number' && next.score >= lane.gateFloor))

  if (kind === 'transport') {
    if (nextOk) return { action: 'next', model: next.model, escalatedFrom: model, cooldown: model, ladder }
    ladder.tried = ladder.tried.filter(m => m !== model)
    return { action: 'backoff', model, cooldown: model, ladder }
  }

  if (kind === 'schema' && ladder.sameModel < esc.sameModelRetries) {
    ladder.sameModel++
    ladder.tried = ladder.tried.filter(m => m !== model)
    return { action: 'retry-same', model, appendError: failure.error, ladder }
  }
  if (kind === 'verifier' && ladder.verifierSteps >= esc.verifierSteps) return park('verifier')
  if (ladder.steps >= lane.maxLadderSteps) return park('ladder-exhausted')
  if (!next) return park(kind === 'schema' ? 'schema' : 'ladder-exhausted')
  if (!nextOk) return park('gate-floor')
  ladder.steps++
  ladder.sameModel = 0
  if (kind === 'verifier') ladder.verifierSteps++
  return { action: 'next', model: next.model, escalatedFrom: model, ladder }
}
