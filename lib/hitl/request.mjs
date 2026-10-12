// Bridges the decision record and the hitl-request. fromDecision only moves what a caller already said into
// request shape; it never fills a missing field, so the linter sees exactly what a person would have read.
const KEYS = ['A', 'B', 'C', 'D']

export function fromDecision(d) {
  const r = { schema: 'hitl-request/1', id: d.id || d.key }
  if (d.why !== undefined) r.situation = d.why
  if (d.question !== undefined) r.ask = d.question
  r.options = (d.options || []).map((label, i) => {
    const o = { key: KEYS[i] || String(i + 1), label, recommended: d.recommendation !== undefined && label === d.recommendation }
    if (d.reversalCost !== undefined) o.reversalCost = d.reversalCost
    return o
  })
  if (d.kind) r.kind = d.kind
  if (d.ticket) r.run = { ticket: d.ticket }
  return r
}

export function decisionFields(r) {
  const rec = r.options.find(o => o.recommended)
  return {
    question: r.ask,
    why: r.situation,
    options: r.options.map(o => o.label),
    recommendation: rec.label,
    reversalCost: `${rec.reversalCost.level}: ${rec.reversalCost.how}`,
  }
}

export const violationLines = violations => violations.map(v => `${v.rule} ${v.path}: ${v.text}`)
