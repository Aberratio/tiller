#!/usr/bin/env node
// Validate a brainstorm session and render it into the places the harness already keeps decisions.
//
//   brainstorm.mjs check  <session.json> [--facts <facts.json>] [--profile <profile.md>]
//   brainstorm.mjs render <session.json> [--as table|question|awaiting|ledger|doubt] [--facts <f>]
//                         [--date YYYY-MM-DD] [--tag spec|standards|both] [--agreed-with "<role>, <where>"]
//   brainstorm.mjs record <session.json> --brain <dir> [--facts <f>] [--date YYYY-MM-DD] [--confirmed-by <who>]
//
// --facts checks inviolable titles, --profile checks `## section` names; both apply to every command.
// The session shape is in ../references/session.md. `check` exists so the model never grades its
// own format; render and record refuse anything check refuses.
// Exit: 0 done, 1 the session fails check, 2 usage, 3 refused (the destination is not a register).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const AREAS = ['scope', 'tech', 'budget', 'deadline', 'other']
const TAGS = ['spec', 'standards', 'both']
const FORMATS = ['table', 'question', 'awaiting', 'ledger', 'doubt']

function die(code, msg) { console.error(`brainstorm: ${msg}`); process.exit(code) }
const text = v => (typeof v === 'string' ? v.trim() : '')
const norm = v => text(v).toLowerCase().replace(/\s+/g, ' ')
const flat = v => text(v).replace(/\s*\n\s*/g, ' ')
const clip = v => (v.length > 160 ? `${v.slice(0, 160)}… (clipped; ${v.length} chars)` : v)
const cell = v => flat(v).replace(/\|/g, '\\|')

function readJson(path, what) {
  if (!path || !existsSync(path)) die(2, `${what}: no such file ${path ?? ''}`)
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (e) { die(2, `${what}: not JSON (${e.message})`) }
}

export function validate(s, facts, sections) {
  const out = []
  const parks = []
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { problems: ['session is not an object'], parks }
  if (!text(s.goal)) out.push('goal missing')
  if (s.area !== undefined && !AREAS.includes(s.area)) out.push(`area "${s.area}" not one of ${AREAS.join(', ')}`)

  const evidence = Array.isArray(s.evidence) ? s.evidence : []
  if (s.evidence !== undefined && !Array.isArray(s.evidence)) out.push('evidence is not a list')
  evidence.forEach((e, i) => {
    const at = `evidence ${i + 1}`
    if (!text(e?.claim)) out.push(`${at}: claim missing`)
    if (e?.measured) {
      if (!text(e.measured.command) || !text(e.measured.output)) out.push(`${at}: measured needs command and output`)
    } else if (e?.assumption === true) {
      if (!text(e.settle)) out.push(`${at}: assumption without settle`)
    } else out.push(`${at}: neither measured nor an assumption`)
  })

  const options = Array.isArray(s.options) ? s.options : []
  if (options.length < 3) out.push(`at least 3 options needed, got ${options.length}`)
  const ids = new Map()
  const names = new Set()
  const against = new Map()
  const declared = Array.isArray(facts?.inviolables) ? facts.inviolables : null
  for (const o of options) {
    const id = text(o?.id) || '?'
    if (ids.has(id)) out.push(`duplicate id ${id}`)
    ids.set(id, o)
    for (const f of ['name', 'summary', 'against', 'reversalCost']) if (!text(o?.[f])) out.push(`${id}: ${f} missing`)
    if (text(o?.name)) {
      if (names.has(norm(o.name))) out.push(`${id}: duplicate name "${flat(o.name)}"`)
      names.add(norm(o.name))
    }
    if (text(o?.against)) {
      const first = against.get(norm(o.against))
      if (first) out.push(`${id}: same strongest case against as ${first}; that is one option, not two`)
      else against.set(norm(o.against), id)
    }
    if (text(o?.reversalCost) && !/\d/.test(o.reversalCost)) out.push(`${id}: reversalCost "${flat(o.reversalCost)}" names no quantity (minutes, files, steps)`)
    const touches = Array.isArray(o?.touches) ? o.touches.map(text) : []
    if (touches.length === 0) out.push(`${id}: touches missing (a profile section, "inviolable: <title>", or "none")`)
    else if (touches.includes('none') && touches.length > 1) out.push(`${id}: "none" cannot be combined with other touches`)
    for (const t of touches) {
      if (t === 'none') continue
      if (/^## \S/.test(t)) {
        if (sections && !sections.includes(norm(t))) out.push(`${id}: "${t}" is not a section of the profile`)
        continue
      }
      const m = t.match(/^inviolable:\s*(\S.*)$/)
      if (!m) { out.push(`${id}: touches "${t}" is not "## <section>", "inviolable: <title>" or "none"`); continue }
      if (declared && !declared.includes(m[1])) out.push(`${id}: inviolable "${m[1]}" is not declared in the profile`)
    }
  }
  if (options.length && !options.some(o => o?.minimal === true)) out.push('no option is marked minimal (the smallest thing that meets the goal, doing nothing included)')

  const rec = text(s.recommendation)
  const beat = text(s.beat)
  if (!ids.has(rec)) out.push(`recommendation ${rec || '(missing)'} is not an option`)
  if (!ids.has(beat)) out.push(`beat ${beat || '(missing)'} is not an option`)
  else if (beat === rec) out.push('beat must differ from the recommendation')
  if (!text(s.why)) out.push('why missing')

  const r = ids.get(rec)
  for (const t of (Array.isArray(r?.touches) ? r.touches : [])) {
    const m = text(t).match(/^inviolable:\s*(\S.*)$/)
    if (m) parks.push(`park: recommendation ${rec} touches inviolable "${m[1]}"; the human decides`)
  }
  return { problems: out, parks }
}

function ordered(s) {
  const rec = s.options.find(o => o.id === s.recommendation)
  return [rec, ...s.options.filter(o => o !== rec)]
}
const label = (s, o) => `${flat(o.name)}${o.id === s.recommendation ? ' (Recommended)' : ''}${o.minimal ? ' (minimal)' : ''}`
const byId = (s, id) => s.options.find(o => o.id === id)

function table(s, parks) {
  const rows = ordered(s).map(o => `| ${o.id}. ${cell(label(s, o))} | ${cell(o.summary)} | ${cell(o.against)} | ${cell(o.reversalCost)} | ${cell(o.touches.join(', '))} |`)
  const rec = byId(s, s.recommendation)
  const beat = byId(s, s.beat)
  const ev = (s.evidence || []).map(e => (e.measured
    ? `- Measured: ${flat(e.claim)} — \`${flat(e.measured.command)}\` → ${clip(flat(e.measured.output))}`
    : `- Assumption: ${flat(e.claim)} — settle: ${flat(e.settle)}${e.flips ? ' (would flip the recommendation)' : ''}`))
  return [
    `Goal: ${flat(s.goal)}`,
    '',
    '| Option | What it is | Strongest case against | Reversal | Touches |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `Recommended: ${rec.id} — ${flat(rec.name)}. ${flat(s.why)}`,
    `Beat: ${beat.id} — ${flat(beat.name)}`,
    ...parks,
    ...(ev.length ? ['', ...ev] : []),
  ].join('\n') + '\n'
}

function question(s) {
  const q = text(s.question) || `Which option for: ${flat(s.goal)}?`
  const lines = ordered(s).map((o, i) => `${i + 1}. ${label(s, o)} — ${flat(o.summary)}. Against: ${flat(o.against)}. Reversal: ${flat(o.reversalCost)}.`)
  return [q.endsWith('?') ? q : `${q}?`, ...lines, '', 'Reply with a number.'].join('\n') + '\n'
}

function awaiting(s) {
  const rec = byId(s, s.recommendation)
  return JSON.stringify({
    kind: 'question',
    question: text(s.question) || `Which option for: ${flat(s.goal)}?`,
    options: ordered(s).map(o => `${o.id}: ${flat(o.name)}`),
    recommendation: `${rec.id}: ${flat(rec.name)} — ${flat(s.why)}`,
    reversalCost: flat(rec.reversalCost),
  }, null, 2) + '\n'
}

function ledger(s, { date, tag, agreedWith }) {
  const clean = v => flat(v).replace(/·/g, ',')
  const rec = byId(s, s.recommendation)
  const beat = byId(s, s.beat)
  const who = agreedWith ? `agreed with ${clean(agreedWith)}` : 'self'
  return `- ${date} · ${tag} · ${clean(rec.name)} — ${clean(s.why)}; beat ${clean(beat.name)}; reversal: ${clean(rec.reversalCost)} · ${who}\n`
}

function doubt(s, parks, { date }) {
  const rec = byId(s, s.recommendation)
  const beat = byId(s, s.beat)
  const settle = (s.evidence || []).filter(e => e.assumption).map(e => flat(e.settle))
  return [
    `## ${date} · brainstorm · ${flat(s.goal)}`,
    `- Decision: ${rec.id} — ${flat(rec.name)} — ${flat(s.why)}`,
    `- Beat: ${beat.id} — ${flat(beat.name)} — its case: ${flat(beat.against)}`,
    `- Reversal: ${flat(rec.reversalCost)}`,
    `- Settle: ${settle.join('; ') || '-'}`,
    ...parks.map(p => `- ${p}`),
    '',
    table(s, []),
  ].join('\n')
}

const slug = g => norm(g).replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '') || 'session'
function nextId(file, prefix) {
  if (!existsSync(file)) return `${prefix}-001`
  const nums = [...readFileSync(file, 'utf8').matchAll(new RegExp(`^### ${prefix}-(\\d{3,})`, 'gm'))].map(m => Number(m[1]))
  return `${prefix}-${String(Math.max(0, ...nums) + 1).padStart(3, '0')}`
}
function append(file, block) {
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : ''
  appendFileSync(file, (prior && !prior.endsWith('\n') ? '\n' : '') + '\n' + block)
}

function record(s, parks, { brain, date, confirmedBy }) {
  if (!brain) die(2, 'record needs --brain <dir>')
  const decisions = join(brain, 'decisions.md')
  const questions = join(brain, 'questions.md')
  if (!existsSync(decisions)) die(3, `no decisions.md in ${brain}: not a discovery register; nothing written`)
  if (confirmedBy && existsSync(join(brain, 'client.md'))) die(3, 'a client brain is confirmed by the client through flow-discovery, never here; nothing written')
  const base = `${date}-${slug(s.goal)}`
  let rel = `brainstorms/${base}.md`
  for (let n = 2; existsSync(join(brain, rel)); n++) rel = `brainstorms/${base}-${n}.md`
  const d = nextId(decisions, 'D')
  let q = Number(nextId(questions, 'Q').slice(2))
  const assumptions = (s.evidence || []).filter(e => e.assumption)
  const qIds = assumptions.map(() => `Q-${String(q++).padStart(3, '0')}`)
  const area = s.area || 'other'
  const rec = byId(s, s.recommendation)
  const beat = byId(s, s.beat)

  mkdirSync(join(brain, 'brainstorms'), { recursive: true })
  writeFileSync(join(brain, rel), `# ${flat(s.goal)}\n\nDate: ${date}\nRecorded as: ${d}; open: ${qIds.join(', ') || '-'}\n\n${table(s, parks)}`)
  append(decisions, [
    `### ${d} — ${flat(rec.name)}`,
    `- Area: ${area}`,
    `- Status: ${confirmedBy ? 'agreed' : 'proposed'}`,
    `- Proposed in: ${rel}`,
    `- Confirmed by: ${confirmedBy ? flat(confirmedBy) : '-'}`,
    `- Beat: ${flat(beat.name)}`,
    `- Reversal: ${flat(rec.reversalCost)}`,
  ].join('\n') + '\n')
  assumptions.forEach((e, i) => append(questions, [
    `### ${qIds[i]} — ${flat(e.claim)}`,
    `- Area: ${area}`,
    '- Owner: me',
    `- Blocks spec: ${e.flips ? 'yes' : 'no'}`,
    `- Opened in: ${rel}`,
    '- Closed in: -',
    `- Settle: ${flat(e.settle)}`,
  ].join('\n') + '\n'))
  console.log(`${d} ${rel}${qIds.length ? ' ' + qIds.join(' ') : ''}`)
  for (const p of parks) console.log(p)
}

function flag(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  if (v === undefined || v.startsWith('--')) die(2, `${name} needs a value`)
  return v
}

const [cmd, path, ...args] = process.argv.slice(2)
if (!['check', 'render', 'record'].includes(cmd)) die(2, 'usage: brainstorm.mjs check|render|record <session.json> [flags]; see the header')
const s = readJson(path, 'session')
const factsPath = flag(args, '--facts')
const facts = factsPath ? readJson(factsPath, 'facts') : null
const profilePath = flag(args, '--profile')
if (profilePath && !existsSync(profilePath)) die(2, `--profile: no such file ${profilePath}`)
const sections = profilePath ? [...readFileSync(profilePath, 'utf8').matchAll(/^## .+$/gm)].map(m => norm(m[0])) : null
const date = flag(args, '--date') || new Date().toISOString().slice(0, 10)
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(2, '--date is YYYY-MM-DD')
const as = flag(args, '--as') || 'table'
if (cmd === 'render' && !FORMATS.includes(as)) die(2, `--as is one of ${FORMATS.join(', ')}`)
const tag = flag(args, '--tag') || 'spec'
if (!TAGS.includes(tag)) die(2, `--tag is one of ${TAGS.join(', ')}`)
if (cmd === 'record' && !flag(args, '--brain')) die(2, 'record needs --brain <dir>')

const { problems, parks } = validate(s, facts, sections)
if (problems.length) {
  for (const p of problems) console.log(p)
  process.exit(1)
}
if (cmd === 'check') {
  console.log(`ok: ${s.options.length} options, ${s.recommendation} over ${s.beat}`)
  for (const p of parks) console.log(p)
} else if (cmd === 'render') {
  const opts = { date, tag, agreedWith: flag(args, '--agreed-with') }
  process.stdout.write({ table: () => table(s, parks), question: () => question(s), awaiting: () => awaiting(s), ledger: () => ledger(s, opts), doubt: () => doubt(s, parks, opts) }[as]())
} else {
  record(s, parks, { brain: flag(args, '--brain'), date, confirmedBy: flag(args, '--confirmed-by') })
}
