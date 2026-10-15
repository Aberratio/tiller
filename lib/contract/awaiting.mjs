// Triage of a lane result's awaiting[]: which items are decisions, which are refused tool calls
// and which are notes that only travel to the PR body.
//
// `harness-blocked` is reserved for a refused tool call quoted literally. An agent also uses it for
// environment observations (a missing env file, a sandboxed spawn); those never park or retry a run.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))

// The refusal patterns are the classifier's, plus the contract's own for a refusal quoted as
// "Permission denied: Tool(...)"; the classifier keeps its narrower list because a plain file
// permission error on stderr is not a harness block.
export function awaitingRules() {
  const kinds = readJson(join(HERE, 'kinds.json'))
  const patterns = readJson(join(HERE, '..', 'resilience', 'patterns.json'))
  return {
    refusals: [...patterns.kinds['harness-blocked'], ...kinds.awaiting.refusals],
    prose: [...kinds.awaiting.prose],
  }
}

function isQuotedRefusal(text, rules) {
  const s = String(text || '')
  return ((rules && rules.refusals) || []).some(p => new RegExp(p, 'i').test(s))
}

function triageAwaiting(lane, result, rules) {
  const out = { decisions: [], refusals: [], notes: [] }
  const prose = ((rules && rules.prose) || []).includes(lane)
  for (const a of (result && result.awaiting) || []) {
    if (prose) out.notes.push(a)
    else if (a.kind !== 'harness-blocked') out.decisions.push(a)
    else if (isQuotedRefusal(a.why, rules)) out.refusals.push(a)
    else out.notes.push(a)
  }
  return out
}

export { isQuotedRefusal, triageAwaiting }

// A runtime that records refused tool calls (an adapter's `denials`) decides which harness-blocked items
// are refusals; the model's wording no longer does. `denials` undefined keeps the regex triage.
export function triageWithDenials(lane, result, rules, denials) {
  const t = triageAwaiting(lane, result, rules)
  if (!Array.isArray(denials) || ((rules && rules.prose) || []).includes(lane)) return t
  const claimed = [...t.refusals, ...t.notes]
  if (!denials.length) return { ...t, refusals: [], notes: claimed }
  const why = denials.map(d => d.text).join('; ')
  return { ...t, refusals: claimed.map(a => ({ ...a, why })), notes: [] }
}
