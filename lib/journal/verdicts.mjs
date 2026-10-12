// Verdict ledger: one append-only line per lane verdict, and an `overturned` line when a later
// script, lane or human contradicts it. calibration() turns it into a per lane x model overturn rate.
import { join } from 'node:path'
import { appendJournal } from '../driver/journal.mjs'

export const verdictsPath = (root, ticket) => join(root, 'tickets', ticket, 'verdicts.jsonl')

export const verdictId = ({ runId, phase, lane, detail, field }) => [runId, phase, lane, detail, field].filter(x => x !== null && x !== undefined && x !== '').join(':')

export function verdictLine({ runId, phase, lane, model, tier, field, value, detail, evidenceStatus = 'claimed' }) {
  return { kind: 'verdict', id: verdictId({ runId, phase, lane, detail, field }), runId, phase, lane, model: model ?? null, tier: tier ?? null,
    field, value: value ?? null, evidenceStatus, at: new Date().toISOString() }
}

export function overturnLine({ runId, verdictId: id, by, source, evidence }) {
  return { kind: 'overturned', verdictId: id, runId, by, source, evidence: String(evidence ?? '').slice(0, 500), at: new Date().toISOString() }
}

export const appendVerdict = (path, line) => appendJournal(path, line)

export function calibration(lines) {
  const byId = new Map()
  for (const l of lines) if (l.kind === 'verdict') byId.set(l.id, l)
  const overturned = new Set(lines.filter(l => l.kind === 'overturned' && byId.has(l.verdictId)).map(l => l.verdictId))
  const out = {}
  for (const v of byId.values()) {
    const key = `${v.lane}|${v.model}`
    const row = out[key] ??= { lane: v.lane, model: v.model, verdicts: 0, overturns: 0, rate: 0 }
    row.verdicts += 1
    if (overturned.has(v.id)) row.overturns += 1
  }
  for (const row of Object.values(out)) row.rate = Math.round((row.overturns / row.verdicts) * 1000) / 1000
  return out
}
