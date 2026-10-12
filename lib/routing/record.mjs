// routeRecord(routeResult, step?): the route-decision journal record for one dispatch. Without a
// step it is the first call on the top candidate; with a nextCandidate() step it is that retry.

export function routeRecord(routeResult, step) {
  if (step && !['retry-same', 'retry-identical', 'next', 'backoff'].includes(step.action)) throw new Error(`routeRecord: ${step.action} is not a dispatch`)
  const model = step ? step.model : routeResult.candidates[0]?.model
  const cand = routeResult.candidates.find(c => c.model === model)
  if (!cand) throw new Error(`routeRecord: ${model} is not a candidate of ${routeResult.lane.name}`)
  return {
    lane: routeResult.lane.name, model, runtime: cand.runtime, decisionId: routeResult.decisionId,
    rejectedCount: routeResult.rejected.length, escalatedFrom: step?.escalatedFrom ?? null,
    attempt: step?.ladder?.attempt ?? 1, rejected: routeResult.rejected,
  }
}
