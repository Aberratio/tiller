// Parse and check a discovery brain's register: decisions.md (D-nnn) and questions.md (Q-nnn).
// The files are written by an agent; this module is what keeps their statuses and cross-references
// honest after many meetings.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const HEAD = /^### ([DQ]-\d{3,})\s+[—-]\s+(.+?)\s*$/
const ANY_ENTRY_HEAD = /^#+\s*[DQ]-/
const FIELD = /^- ([A-Za-z][A-Za-z ]*?):\s*(.*?)\s*$/
const ID = /\bD-\d{3,}\b/g
const AREAS = ['scope', 'tech', 'budget', 'deadline', 'other']
const STATUSES = ['proposed', 'agreed', 'superseded']
const OWNERS = ['client', 'me']
const empty = v => v === undefined || v === '' || v === '-'
const ids = v => (empty(v) ? [] : v.split(/[,\s]+/).filter(Boolean))

// A heading the format rejects must not leave the previous entry current, or its field lines
// would silently overwrite that entry; such headings are returned in `unparsed` for check().
export function parseRegister(text) {
  const entries = []
  const unparsed = []
  let cur = null
  text.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(HEAD)
    if (h) { cur = { id: h[1], title: h[2], line: i + 1, fields: {} }; entries.push(cur); return }
    if (line.startsWith('#')) {
      cur = null
      if (ANY_ENTRY_HEAD.test(line)) unparsed.push(i + 1)
      return
    }
    const f = cur && line.match(FIELD)
    if (f) cur.fields[f[1]] = f[2]
  })
  return { entries, unparsed }
}

export const parseEntries = text => parseRegister(text).entries

const load = (dir, file) => (existsSync(join(dir, file)) ? parseRegister(readFileSync(join(dir, file), 'utf8')) : { entries: [], unparsed: [] })
const read = (dir, file) => load(dir, file).entries

function enumIssue(file, e, field, allowed) {
  const v = e.fields[field]
  return allowed.includes(v) ? null : `${file}:${e.line}: ${e.id} ${field} "${v ?? ''}" not one of ${allowed.join(', ')}`
}

export function check(brainDir, { specDir } = {}) {
  const out = []
  const dec = load(brainDir, 'decisions.md')
  const que = load(brainDir, 'questions.md')
  const decisions = dec.entries
  const questions = que.entries
  for (const [file, list, unparsed] of [['decisions.md', decisions, dec.unparsed], ['questions.md', questions, que.unparsed]]) {
    for (const n of unparsed) out.push(`${file}:${n}: unparsed heading`)
    const seen = new Set()
    for (const e of list) {
      if (seen.has(e.id)) out.push(`${file}:${e.line}: ${e.id} duplicate`)
      seen.add(e.id)
      const area = enumIssue(file, e, 'Area', AREAS)
      if (area) out.push(area)
    }
  }
  const byId = new Map(decisions.map(d => [d.id, d]))
  for (const d of decisions) {
    const at = `decisions.md:${d.line}: ${d.id}`
    const st = enumIssue('decisions.md', d, 'Status', STATUSES)
    if (st) { out.push(st); continue }
    const s = d.fields.Status
    if (s === 'agreed' && empty(d.fields['Confirmed by'])) out.push(`${at} agreed without Confirmed by`)
    const by = ids(d.fields['Superseded by'])
    if (s === 'superseded' && by.length === 0) out.push(`${at} superseded without Superseded by`)
    for (const n of by) {
      const next = byId.get(n)
      if (!next) out.push(`${at} Superseded by ${n}, which does not exist`)
      else if (!ids(next.fields.Supersedes).includes(d.id)) out.push(`${at} Superseded by ${n}, but ${n} does not list it in Supersedes`)
    }
    for (const o of ids(d.fields.Supersedes)) {
      const old = byId.get(o)
      if (!old) out.push(`${at} Supersedes ${o}, which does not exist`)
      else if (!ids(old.fields['Superseded by']).includes(d.id)) out.push(`${at} Supersedes ${o}, but ${o} is not superseded by ${d.id}`)
    }
  }
  for (const q of questions) {
    for (const [field, allowed] of [['Owner', OWNERS], ['Blocks spec', ['yes', 'no']]]) {
      const issue = enumIssue('questions.md', q, field, allowed)
      if (issue) out.push(issue)
    }
  }
  if (specDir) {
    for (const f of readdirSync(specDir).filter(f => f.endsWith('.md')).sort()) {
      readFileSync(join(specDir, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const id of line.match(ID) || []) {
          const d = byId.get(id)
          if (!d) out.push(`${f}:${i + 1}: cites ${id}, which does not exist`)
          else if (d.fields.Status === 'superseded') out.push(`${f}:${i + 1}: cites ${id}, which is superseded`)
        }
      })
    }
  }
  return out
}

export function status(brainDir) {
  const awaiting = read(brainDir, 'decisions.md').filter(d => d.fields.Status === 'proposed').map(d => d.id)
  const open = {}
  const blocking = []
  for (const q of read(brainDir, 'questions.md')) {
    if (!empty(q.fields['Closed in'])) continue
    ;(open[q.fields.Area] ||= []).push(q.id)
    if (q.fields['Blocks spec'] === 'yes') blocking.push(q.id)
  }
  return { awaiting, open, blocking, ready: blocking.length === 0 }
}
