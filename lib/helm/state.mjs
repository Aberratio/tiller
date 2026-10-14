import { idTime } from './events.mjs'

// Order is the id, whose first part is the UTC second; ties fall back to the whole id string.
export function deriveState(events) {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const dead = new Set(sorted.map(e => e.supersedes).filter(Boolean))
  const calendared = new Set(sorted.map(e => e.calendar_for).filter(Boolean))
  const state = {}
  for (const e of sorted) {
    const p = (state[e.project] ??= { stage: null, next: null, parked: null, open: [], last: null })
    p.last = idTime(e.id)
    if (e.kind === 'milestone') p.stage = e
    else if (e.kind === 'next') p.next = e
    else if (e.kind === 'parked') p.parked = e
    else if ((e.kind === 'deadline' || e.kind === 'promise') && !dead.has(e.id)) p.open.push({ ...e, calendared: calendared.has(e.id) })
  }
  // The newest of a kind wins even when superseded, so a closed step never brings back an older one.
  for (const p of Object.values(state)) for (const k of ['stage', 'next', 'parked']) if (p[k] && dead.has(p[k].id)) p[k] = null
  return state
}
