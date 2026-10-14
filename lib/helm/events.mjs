// One event per file: flat `key: value` frontmatter, optional body. A file is never edited after
// it is written, so two machines never touch the same file.
export const KINDS = ['registered', 'milestone', 'next', 'deadline', 'promise', 'parked', 'done', 'note']
const KEYS = ['id', 'project', 'kind', 'summary', 'due', 'supersedes', 'calendar_for', 'source', 'link']

export function newId(now, machine, hex) {
  return `${now.toISOString().slice(0, 19).replace(/:/g, '-')}Z-${machine}-${hex}`
}

export function idTime(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(id ?? '')
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN
}

// The pattern alone lets 2026-02-30 through, and such a due never reminds anyone.
function realDate(due) {
  const [y, m, d] = due.slice(0, 10).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d && !Number.isNaN(Date.parse(due))
}

const flat = v => String(v).replace(/\s*\n\s*/g, ' ')

export function formatEvent(e) {
  const lines = KEYS.filter(k => e[k] != null && e[k] !== '').map(k => `${k}: ${flat(e[k])}`)
  return `---\n${lines.join('\n')}\n---\n${e.body ? `${e.body.trim()}\n` : ''}`
}

export function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) throw new Error('no frontmatter')
  const fields = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return { fields, body: m[2].trim() }
}

export function validate(e) {
  for (const k of ['id', 'project', 'kind', 'summary', 'source']) if (!e[k]) return `missing ${k}`
  if (!KINDS.includes(e.kind)) return `unknown kind ${e.kind}`
  if ((e.kind === 'deadline' || e.kind === 'promise') && !e.due) return `${e.kind} needs due`
  if (e.due && (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?Z)?$/.test(e.due) || !realDate(e.due))) return `bad due ${e.due}`
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(e.project)) return `bad project ${e.project}`
  return null
}
