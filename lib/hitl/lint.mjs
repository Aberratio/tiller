// Deterministic linter for anything put to a person: lint(request, opts) -> { ok, violations: [{ rule, path, text }] }.
// No network, no model, no clock. L13 (do the links resolve) lives in check-links.mjs.
//
// opts: target  'chat' (default) | 'pr' | 'pr-comment' | 'forge-comment' | 'ledger' | 'tracker'
//       banned  extra regex sources from the profile (extends config/hitl-banned.json)
//       names   person names that must not reach a repo-facing target
//       language 'en' | 'pl' when the profile states one
//       redact  literal strings that must never appear (access codes, tokens)
//       stateWords extra regex sources for L15 (extends config/hitl-words.json)
//       stopwords  { lang: [words] } that extend or add a language for L19

import { readFileSync } from 'node:fs'
import { check, kinds } from '../contract/validate.mjs'
import { hasLiteral, hasSecret } from './secrets.mjs'

const BANNED = JSON.parse(readFileSync(new URL('../../config/hitl-banned.json', import.meta.url), 'utf8')).patterns
const WORDS = JSON.parse(readFileSync(new URL('../../config/hitl-words.json', import.meta.url), 'utf8'))
const STEP_KEY = `(?:${kinds.phases.join('|')}):\\d+`
const REPO_FACING = new Set(['pr', 'pr-comment', 'forge-comment', 'ledger', 'tracker'])
const LEVELS = ['none', 'low', 'medium', 'high', 'irreversible']
const MAX = { title: 80, situation: 300, ask: 160, label: 80, gain: 140, loss: 140, how: 140, happens: 160, glossary: 140 }

const PLACEHOLDER = /\b(not stated|no (second )?option offered|n\/a|tbd|todo)\b/i
const PATH = /(\/Users\/|~\/|\b[A-Za-z][\w.-]*\/[\w.*-]+\/|\b[\w-]+(?:\/[\w.-]+)*\.(?:md|jsonl?|mjs|js|sh)\b)/
const LONG_SHA = /\b[0-9a-f]{40}\b/
// At least one digit and one letter, so English words made of a-f ("defaced") and plain numbers pass.
const SHORT_SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,8}\b/
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/g
const stateWord = (extra = []) => new RegExp(`\\b(?:${[...WORDS.stateWords, ...extra].join('|')})\\b`, 'i')
const FIRST_PERSON = /\b(I|[Ww]e|[Mm]y|[Oo]ur|me)\b/
const ATTRIBUTION = /(Generated with|Co-Authored-By)/i

// Every human-readable string with its path. Ids, urls, kinds and glossary keys are machine fields.
function humanText(r) {
  const out = []
  const add = (path, v) => { if (typeof v === 'string') out.push({ path, text: v }) }
  add('$.title', r.title)
  add('$.situation', r.situation)
  add('$.ask', r.ask)
  ;(Array.isArray(r.options) ? r.options : []).forEach((o, i) => {
    if (!o || typeof o !== 'object') return
    for (const f of ['label', 'gain', 'loss']) add(`$.options[${i}].${f}`, o[f])
    if (o.reversalCost && typeof o.reversalCost === 'object') add(`$.options[${i}].reversalCost.how`, o.reversalCost.how)
  })
  if (r.ifNoAnswer && typeof r.ifNoAnswer === 'object') add('$.ifNoAnswer.happens', r.ifNoAnswer.happens)
  ;(Array.isArray(r.links) ? r.links : []).forEach((l, i) => l && add(`$.links[${i}].text`, l.text))
  return out
}

function allStrings(v, path = '$', out = []) {
  if (typeof v === 'string') out.push({ path, text: v })
  else if (Array.isArray(v)) v.forEach((x, i) => allStrings(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) allStrings(x, `${path}.${k}`, out)
  return out
}

// A semicolon between two clauses ends a sentence; three or more semicolon parts are one list sentence.
const sentences = s => s.split(/[.!?]\s/).flatMap(x => {
  const parts = x.split(/;\s/)
  return parts.length < 3 ? parts : [x]
}).map(x => x.trim()).filter(Boolean)
const words = s => s.split(/\s+/).filter(w => /\w/.test(w))
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const mentions = (text, term) => new RegExp(`(^|[^\\w-])${escape(term)}($|[^\\w-])`, 'i').test(text)

function stopSets(extra = {}) {
  const langs = new Set([...Object.keys(WORDS.stopwords), ...Object.keys(extra)])
  return [...langs].map(l => [l, new Set([...(WORDS.stopwords[l] || []), ...(extra[l] || [])])])
}

function languageOf(text, stops) {
  const ws = words(text.toLowerCase()).map(w => w.replace(/[^\p{L}]/gu, ''))
  if (ws.length < 4) return null
  const counts = stops.map(([l, set]) => [l, ws.filter(w => set.has(w)).length]).sort((a, b) => b[1] - a[1])
  return !counts.length || counts[0][1] === 0 || counts[0][1] === counts[1]?.[1] ? null : counts[0][0]
}

export function lint(r, opts = {}) {
  const v = []
  const add = (rule, path, text) => v.push({ rule, path, text: String(text).slice(0, 200) })
  const req = r && typeof r === 'object' ? r : {}
  const options = Array.isArray(req.options) ? req.options.filter(o => o && typeof o === 'object') : []
  const texts = humanText(req)
  const strings = allStrings(req)
  const glossary = req.glossary && typeof req.glossary === 'object' ? req.glossary : {}
  const glossed = term => Object.keys(glossary).some(k => k.toLowerCase() === term.toLowerCase())

  for (const e of check('hitl-request', r)) add('L01', e.split(':')[0], e)

  const rec = options.filter(o => o.recommended === true)
  if (rec.length !== 1) add('L02', '$.options', `${rec.length} options are recommended; exactly one must be`)

  options.forEach((o, i) => {
    const rc = o.reversalCost
    if (!rc || typeof rc !== 'object') add('L03', `$.options[${i}].reversalCost`, `needs { level, how }, got ${JSON.stringify(rc)}`)
    else {
      if (!LEVELS.includes(rc.level)) add('L03', `$.options[${i}].reversalCost.level`, `"${rc.level}" is not one of ${LEVELS.join(', ')}`)
      if (typeof rc.how !== 'string' || !rc.how.trim() || PLACEHOLDER.test(rc.how)) add('L03', `$.options[${i}].reversalCost.how`, `says nothing about how to undo it: "${rc.how ?? ''}"`)
    }
  })

  for (const s of strings) if (PLACEHOLDER.test(s.text)) add('L04', s.path, s.text)

  const labels = options.map(o => (typeof o.label === 'string' ? o.label.toLowerCase().trim() : ''))
  labels.forEach((a, i) => labels.forEach((b, j) => {
    if (j <= i) return
    if (a === b) add('L05', `$.options[${j}].label`, `same label as option ${i}: "${b}"`)
    else if (a && b && (a.includes(b) || b.includes(a))) add('L05', `$.options[${j}].label`, `"${b}" and "${a}" are not distinct choices`)
  }))
  options.forEach((o, i) => {
    if (typeof o.gain === 'string' && o.gain.trim() && o.gain.trim().toLowerCase() === String(o.loss || '').trim().toLowerCase())
      add('L05', `$.options[${i}].loss`, 'gain and loss say the same thing')
  })

  for (const t of texts) {
    if (!/\.(situation|ask|gain|loss)$/.test(t.path)) continue
    for (const s of sentences(t.text)) if (words(s).length > 25) add('L06', t.path, `${words(s).length}-word sentence: "${s}"`)
  }

  for (const t of [...texts, ...Object.entries(glossary).map(([k, x]) => ({ path: `$.glossary.${k}`, text: x }))]) {
    if (typeof t.text !== 'string') continue
    const field = t.path.startsWith('$.glossary') ? 'glossary' : t.path.split('.').pop()
    if (MAX[field] && t.text.length > MAX[field]) add('L07', t.path, `${t.text.length} chars, max ${MAX[field]}`)
  }

  if (typeof req.ask === 'string') {
    const q = (req.ask.match(/\?/g) || []).length
    if (!req.ask.trim().endsWith('?') || q !== 1) add('L08', '$.ask', `not one question: "${req.ask}"`)
    else if (options.length > 2 && /\sor\s/i.test(req.ask)) add('L08', '$.ask', `"or" joins choices that the ${options.length} options already make: "${req.ask}"`)
  }

  const banned = new RegExp(`\\b(?:${[...BANNED, STEP_KEY, ...(opts.banned || [])].join('|')})\\b`, 'gi')
  for (const t of texts) for (const m of t.text.matchAll(banned)) if (!glossed(m[0])) add('L09', t.path, `"${m[0]}" means nothing to someone who did not watch the run; say it plainly or gloss it`)

  const all = texts.map(t => t.text).join('\n')
  for (const k of Object.keys(glossary)) if (!mentions(all, k)) add('L10', `$.glossary.${k}`, `"${k}" is explained but never used`)

  for (const t of texts) {
    for (const m of t.text.matchAll(TICKET)) {
      const id = m[0]
      const own = req.title && req.run && id === req.run.ticket
      const near = req.title && t.text.slice(Math.max(0, m.index - 60), m.index + id.length + 60).includes(req.title)
      if (!own && !near && !glossed(id)) add('L11', t.path, `${id} is shown without saying what it is`)
    }
  }

  for (const t of texts) if (PATH.test(t.text)) add('L12', t.path, `a file path is not a link: "${t.text.match(PATH)[0]}"`)
  ;(Array.isArray(req.links) ? req.links : []).forEach((l, i) => { if (!/^https?:\/\//.test((l && l.url) || '')) add('L12', `$.links[${i}].url`, `not a URL: "${l && l.url}"`) })
  for (const f of ['runUrl', 'prUrl']) {
    const u = req.run && req.run[f]
    if (u !== undefined && !/^https?:\/\//.test(String(u))) add('L12', `$.run.${f}`, `not a URL: "${u}"`)
  }

  for (const t of texts) {
    if (LONG_SHA.test(t.text)) add('L14', t.path, `full commit hash; show 7 characters inside a link: "${t.text.match(LONG_SHA)[0]}"`)
    else if (!/^\$\.links\[/.test(t.path) && SHORT_SHA.test(t.text)) add('L14', t.path, `commit "${t.text.match(SHORT_SHA)[0]}" is not linked; put it in a link's text`)
  }

  const ina = req.ifNoAnswer && typeof req.ifNoAnswer === 'object' ? req.ifNoAnswer : {}
  if (!(ina.by === 'never' || (typeof ina.by === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(ina.by) && !Number.isNaN(Date.parse(ina.by)))))
    add('L15', '$.ifNoAnswer.by', `not a deadline or "never": ${JSON.stringify(ina.by)}`)
  if (typeof ina.happens !== 'string' || !ina.happens.trim() || !stateWord(opts.stateWords).test(ina.happens))
    add('L15', '$.ifNoAnswer.happens', `does not say what state things stay in: ${JSON.stringify(ina.happens)}`)

  if (typeof req.situation === 'string') {
    const s = req.situation.trim().toLowerCase()
    const kindKey = Object.keys(kinds.kinds).find(k => s === k || s.startsWith(`${k}:`) || s.startsWith(`${k} `))
    if (kindKey || /^(ci-fix cap|gate:|checkpoint)/i.test(s)) add('L16', '$.situation', `a state-machine key, not a situation: "${req.situation}"`)
  }

  for (const s of strings) if (ATTRIBUTION.test(s.text)) add('L18', s.path, `tool attribution: "${s.text}"`)
  if (REPO_FACING.has(opts.target)) {
    for (const t of texts) if (FIRST_PERSON.test(t.text)) add('L18', t.path, `first person in a repo-facing text: "${t.text.match(FIRST_PERSON)[0]}"`)
    for (const n of opts.names || []) for (const s of strings) if (mentions(s.text, n)) add('L18', s.path, `a person's name in a repo-facing text: "${n}"`)
  }

  const stops = stopSets(opts.stopwords)
  const langs = texts.map(t => ({ ...t, lang: languageOf(t.text, stops) })).filter(t => t.lang)
  const seen = [...new Set(langs.map(t => t.lang))]
  if (opts.language) for (const t of langs) { if (t.lang !== opts.language) add('L19', t.path, `written in ${t.lang}, the profile says ${opts.language}`) }
  else if (seen.length > 1) for (const t of langs.filter(x => x.lang !== langs[0].lang)) add('L19', t.path, `written in ${t.lang}, the rest in ${langs[0].lang}`)

  for (const s of strings) {
    if (hasSecret(s.text)) add('L20', s.path, 'a secret in clear; write <REDACTED>')
    if (hasLiteral(s.text, opts.redact)) add('L20', s.path, 'a value on the redaction list; write <REDACTED>')
  }

  return { ok: v.length === 0, violations: v }
}

// L17, for informational reports: items numbered 1..N in execution order, blocked ones last, each with the
// condition for its return.
export function lintReport(report) {
  const v = []
  const items = Array.isArray(report && report.items) ? report.items : []
  items.forEach((it, i) => {
    if (it.n !== i + 1) v.push({ rule: 'L17', path: `$.items[${i}].n`, text: `numbered ${it.n}, position ${i + 1}` })
    if (i > 0 && items[i - 1].blocked && !it.blocked) v.push({ rule: 'L17', path: `$.items[${i}]`, text: 'an actionable item after a blocked one; blocked items go last' })
    if (it.blocked && !(typeof it.returnsWhen === 'string' && it.returnsWhen.trim())) v.push({ rule: 'L17', path: `$.items[${i}].returnsWhen`, text: 'a blocked item names when it comes back' })
  })
  return { ok: v.length === 0, violations: v }
}
