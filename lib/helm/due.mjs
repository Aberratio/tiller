// Derived state -> what to say. Pure: the clock, time zone and thresholds come in as arguments.
const DAY = 86400000

function tzOffsetMs(utcMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs))
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second) - utcMs
}

// A date-only due means the end of that day where the owner lives, not in UTC.
export function dueMs(due, tz) {
  if (due.includes('T')) return Date.parse(due)
  const [y, m, d] = due.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, 23, 59, 59)
  return wall - tzOffsetMs(wall, tz)
}

export function report(state, machines, { now, tz, staleDays, project = null, self, unpushed = 0, offline = false, limit = 5 }) {
  const t = now.getTime()
  const groups = [[], [], [], [], []]
  for (const [name, p] of Object.entries(state)) {
    if (project && name !== project) continue
    for (const o of p.open) {
      const d = dueMs(o.due, tz)
      if (d < t) groups[0].push([d, `overdue: ${name} - ${o.summary} (due ${o.due})`])
      else if (d - t <= 2 * DAY) groups[1].push([d, `due ${o.due}: ${name} - ${o.summary}`])
    }
    if (p.parked) groups[2].push([0, `parked: ${name} - ${p.parked.summary}`])
    if (p.last && t - p.last >= staleDays * DAY) groups[3].push([p.last, `stale: ${name} - no activity for ${Math.floor((t - p.last) / DAY)} days`])
  }
  if (!project) {
    for (const m of machines) {
      const seen = Date.parse(`${m.last_seen}T00:00:00Z`)
      if (m.machine !== self && t - seen >= staleDays * DAY) groups[4].push([seen, `machine ${m.machine}: last synced ${m.last_seen}, its events may be missing`])
    }
  }
  if (unpushed > 0) groups[4].push([Infinity, `this machine: ${unpushed} local commit(s) not pushed`])
  const lines = groups.flatMap(g => g.sort((a, b) => a[0] - b[0]).map(x => x[1])).slice(0, limit)
  if (lines.length && offline) lines.unshift('helm: offline, showing local state')
  return lines
}

export function statusOrder(state, tz) {
  const rows = Object.entries(state).map(([name, p]) => ({ name, p, due: Math.min(Infinity, ...p.open.map(o => dueMs(o.due, tz))) }))
  const group = r => (r.p.parked ? 2 : r.due < Infinity ? 0 : 1)
  return rows
    .sort((a, b) => group(a) - group(b) || (group(a) === 0 ? a.due - b.due : (a.p.last ?? 0) - (b.p.last ?? 0)) || a.name.localeCompare(b.name))
    .map(r => r.name)
}

export function statusText(state, machines, { tz, self }) {
  const out = []
  for (const name of statusOrder(state, tz)) {
    const p = state[name]
    const where = machines.filter(m => m.clones?.[name]).map(m => `${m.machine}${m.machine === self ? ' (this machine)' : ''}: ${m.clones[name]}`)
    out.push(`## ${name}`, `- stage: ${p.stage?.summary ?? 'none recorded'}`, `- next: ${p.next?.summary ?? 'none recorded'}`)
    for (const o of [...p.open].sort((a, b) => dueMs(a.due, tz) - dueMs(b.due, tz))) out.push(`- ${o.kind} ${o.due}: ${o.summary} (${o.id})`)
    if (p.parked) out.push(`- parked: ${p.parked.summary}`)
    out.push(`- last activity: ${p.last ? new Date(p.last).toISOString().slice(0, 10) : 'never'}`, `- clones: ${where.length ? where.join('; ') : 'none known'}`, '')
  }
  return out.join('\n')
}
