#!/usr/bin/env node
// The retro over every run under a run-state root: run outcomes, park causes, open decisions,
// spend, overturn rates and what calibration would write, folded into one dated note that proposes
// edits with evidence. It proposes and never applies, and no proposal targets a merge-authority,
// inviolables or owner-proxy section: TARGETS is the closed list.
//
//   node skills/flow-retro/bin/retro.mjs --profile <file> [--root <run-state dir>] [--date YYYY-MM-DD]
//                                        [--out <file>] [--min-n N] [--dry-run]
//
// Reads tickets/<ticket>/driver-result.json, day-result.json, decisions.jsonl, driver-journal.jsonl
// and verdicts.jsonl at any depth below the root. The note goes to --out, else to
// retros/<date>.md beside the profile (git-ignored with the profile). Output: one script-result
// line (docs/harness.md, "Script I/O"); --dry-run prints the note instead of writing it.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJournal } from '../../../lib/driver/journal.mjs'
import { MIN_N, journalsUnder, measuredFrom, spendFrom } from '../../../lib/journal/calibrate.mjs'
import { calibration } from '../../../lib/journal/verdicts.mjs'

const OVERTURN_RATE = 0.15
const SPEND_SHARE = 0.4
const REPEAT = 2

// Where a recurring park cause points. Anything not listed falls to the run-ticket skill.
const CAUSE_TARGETS = {
  'harness-blocked': ['## run policy', 'name the blocking rule in the run policy, or drop the step that hits it'],
  'rate-limit': ['## model routing', 'route the rate-limited lane to another tier, or raise caps.cooldownMinutes'],
  'usage-limit': ['caps.usageWaitMinutes', 'lengthen the usage wait, or run fewer tickets per wave'],
  'no-progress': ['caps.noProgressSpawns', 'raise the cap, or tighten the brief of the phase that stalls'],
  'ci-red': ['## gates', 'name the check that fails and whether a fix round may address it'],
  'ci-infra': ['caps.backoffAttempts', 'allow more transport retries, or name the flaky job in the gates section'],
  'ci-timeout': ['caps.waitCiRecalls', 'allow more CI waits, or shorten the CI the gate waits on'],
  'conflict': ['caps.rebase', 'allow one more rebase, or serialise the tickets that touch the same files'],
  'premise': ['## ticket conventions', 'state what a ticket must carry before a run starts'],
  'question': ['## escalation', 'answer the recurring question in the profile so no run asks it again'],
  'schema': ['lib/contract/schemas', 'loosen or document the field the lane keeps getting wrong'],
  'no model can run lane': ['## model routing', 'pin a model that passes the lane, or widen the tier list'],
  'resume failed': ['caps.resumes', 'raise the resume cap, or fix what the checkpoint refuses'],
}
const DEFAULT_TARGET = ['skills/flow-run-ticket/SKILL.md', 'add the cause to the step that produced it']

export const TARGETS = new Set([...Object.values(CAUSE_TARGETS).map(t => t[0]), DEFAULT_TARGET[0], '## model routing', '## escalation', 'lib/contract/schemas'])
const FORBIDDEN = /merge authority|inviolables|owner proxy/i
const allowedTarget = t => (TARGETS.has(t) || /^lib\/contract\/schemas\/lane-[a-z-]+\.json$/.test(t)) && !FORBIDDEN.test(t)

const round = (n, d = 2) => n.toFixed(d)
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const readJson = p => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const uniq = xs => [...new Set(xs)]

// Every result, decision, journal and ledger file below the root, any depth.
export function filesUnder(root) {
  const found = { results: [], days: [], decisions: [] }
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (name === 'driver-result.json' && basename(dirname(dirname(p))) === 'tickets') found.results.push(p)
      else if (name === 'day-result.json') found.days.push(p)
      else if (name === 'decisions.jsonl') found.decisions.push(p)
    }
  }
  walk(root)
  return { ...found, ...journalsUnder(root) }
}

// The cause of a park or a death: the known kind at the head of the reason, else its first words.
export function causeOf(reason) {
  const r = String(reason || '').trim()
  for (const k of Object.keys(CAUSE_TARGETS)) if (r.startsWith(k)) return k
  if (/^checkpoint .* refused/.test(r)) return 'checkpoint refused'
  return clip(r.split(/[:(]/)[0], 40) || 'unknown'
}

export function gather(root, { minN = MIN_N } = {}) {
  const found = filesUnder(root)
  const runs = found.results.map(p => ({ ...(readJson(p) || {}), run: basename(dirname(dirname(dirname(p)))) })).filter(r => r.ticket)
  const stopped = runs.filter(r => ['parked', 'died', 'paused-usage'].includes(r.status))
  const causes = {}
  for (const r of stopped) (causes[causeOf(r.reason)] ??= []).push(r)
  const decisions = {}
  for (const d of found.decisions.flatMap(readJournal)) if (d.id) decisions[d.id] = d
  const open = {}
  for (const d of Object.values(decisions).filter(d => d.status === 'open')) (open[d.kind] ??= []).push(d)
  const journalLines = found.journals.flatMap(readJournal)
  const spend = spendFrom(journalLines)
  const total = Object.values(spend).reduce((n, s) => n + s.costUsd, 0)
  const verdictLines = found.verdicts.flatMap(readJournal)
  const rates = Object.values(calibration(verdictLines)).filter(r => r.model && r.model !== 'null')
  const { measured, skipped } = measuredFrom(verdictLines, { minN, evalRun: 'retro' })
  return { runs, stopped, causes, open, spend, total, rates, measured, skipped, minN, days: found.days.map(readJson).filter(Boolean), runCount: found.runs }
}

// Each proposal: one target from TARGETS, one sentence, and the evidence lines it rests on.
export function propose(g) {
  const out = []
  const add = (target, text, evidence) => {
    if (!allowedTarget(target)) throw new Error(`retro: "${target}" is not a target this retro may propose`)
    out.push({ target, text, evidence })
  }
  for (const [cause, rs] of Object.entries(g.causes)) {
    if (rs.length < REPEAT) continue
    const [target, text] = CAUSE_TARGETS[cause] || DEFAULT_TARGET
    add(target, `${cause} stopped ${rs.length} runs: ${text}.`, rs.map(r => `${r.ticket}: ${clip(r.reason, 160)}`))
  }
  for (const r of g.rates) {
    if (r.verdicts < g.minN || r.rate < OVERTURN_RATE) continue
    add('## model routing', `${r.lane} on ${r.model} is overturned at ${round(r.rate)}: route the lane to another tier, or run calibrate so measured.json demotes it.`,
      [`${r.overturns} of ${r.verdicts} verdicts overturned (score ${round(1 - r.rate, 3)}, threshold ${OVERTURN_RATE})`])
  }
  const byLane = {}
  for (const [key, s] of Object.entries(g.spend)) {
    const [model, lane] = key.split('|')
    const b = byLane[lane] ??= { calls: 0, costUsd: 0, outcomes: {}, models: new Set() }
    b.calls += s.calls; b.costUsd += s.costUsd; b.models.add(model)
    for (const [o, n] of Object.entries(s.outcomes)) b.outcomes[o] = (b.outcomes[o] || 0) + n
  }
  for (const [lane, b] of Object.entries(byLane)) {
    if (g.total > 0 && b.costUsd / g.total >= SPEND_SHARE) {
      add('## model routing', `${lane} took ${Math.round(100 * b.costUsd / g.total)}% of the spend: a lower tier for a non-gate lane, or a tighter brief, pays back first.`,
        [`${lane}: $${round(b.costUsd)} of $${round(g.total)} over ${b.calls} calls on ${[...b.models].join(', ')}`])
    }
    const bad = (b.outcomes.schema || 0) + (b.outcomes.invalid || 0)
    if (bad >= REPEAT) {
      add(`lib/contract/schemas/lane-${lane}.json`, `${lane} output failed its schema ${bad} times: name the field in the brief, or loosen the schema where the field is free text.`,
        [`${bad} of ${b.calls} ${lane} calls ended schema or invalid`])
    }
  }
  for (const [kind, ds] of Object.entries(g.open)) {
    if (ds.length < REPEAT) continue
    add('## escalation', `${ds.length} ${kind} decisions are still open: settle the recurring one in the profile, or name who answers it.`,
      ds.map(d => `${d.ticket}: ${clip(d.question, 160)}`))
  }
  return out
}
export function render(g, proposals, { date, root }) {
  const counts = {}
  for (const r of g.runs) counts[r.status] = (counts[r.status] || 0) + 1
  const tickets = uniq(g.runs.map(r => r.ticket))
  const row = (...cells) => `| ${cells.join(' | ')} |`
  const lines = [
    `# Retro ${date}`, '',
    `Runs: ${g.runCount} under \`${root}\`. Tickets: ${tickets.length}. ${Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(', ') || 'no results'}.`,
    g.days.length ? `Day results: ${g.days.map(d => `${d.date || '?'} ${d.status}${d.reason ? ` (${clip(d.reason, 80)})` : ''}`).join('; ')}.` : null,
    '', '## Runs', '', row('ticket', 'status', 'reason'), row('---', '---', '---'),
    ...g.runs.map(r => row(r.ticket, r.status, clip(r.reason, 120))),
    '', '## Park causes', '', row('cause', 'count', 'tickets'), row('---', '---', '---'),
    ...Object.entries(g.causes).sort((a, b) => b[1].length - a[1].length).map(([c, rs]) => row(c, rs.length, uniq(rs.map(r => r.ticket)).join(', '))),
    '', '## Open decisions', '', row('kind', 'open', 'tickets'), row('---', '---', '---'),
    ...Object.entries(g.open).map(([k, ds]) => row(k, ds.length, uniq(ds.map(d => d.ticket)).join(', '))),
    '', '## Spend', '', row('model', 'lane', 'calls', 'USD', 'outcomes'), row('---', '---', '---', '---', '---'),
    ...Object.entries(g.spend).sort((a, b) => b[1].costUsd - a[1].costUsd).map(([k, s]) => row(...k.split('|'), s.calls, round(s.costUsd), Object.entries(s.outcomes).map(([o, n]) => `${o} ${n}`).join(', '))),
    `Total: $${round(g.total)}.`,
    '', '## Calibration', '', row('model', 'lane', 'n', 'overturn rate', 'score'), row('---', '---', '---', '---', '---'),
    ...g.rates.map(r => row(r.model, r.lane, r.verdicts, round(r.rate, 2), round(1 - r.rate, 2))),
    `Measured (n >= ${g.minN}): ${Object.entries(g.measured).flatMap(([m, ls]) => Object.entries(ls).map(([l, e]) => `${m} ${l} ${e.score}`)).join(', ') || 'nothing'}.` +
      ` Skipped: ${g.skipped.map(s => `${s.model} ${s.lane} (n=${s.n})`).join(', ') || 'nothing'}.`,
    '', '## Proposals', '',
    ...(proposals.length ? proposals.flatMap(p => [`- \`${p.target}\`: ${p.text}`, ...p.evidence.map(e => `  - evidence: ${e}`)]) : ['Nothing recurred often enough to propose an edit.']),
    '', '## Not proposed', '',
    'Merge authority, inviolables and the owner-proxy mandate are not targets of a retro; a change there is a decision for the owner. Nothing above has been applied.',
    '',
  ]
  return lines.filter(l => l !== null).join('\n')
}

const profileName = text => (text.match(/^profile:\s*(.+?)\s*$/m) || [])[1] || null

function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const emit = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code) }
  const profile = opt('--profile')
  if (!profile || !existsSync(profile)) emit(4, { status: 'refused', kind: 'policy', reason: 'usage: retro.mjs --profile <file> [--root <run-state dir>] [--date YYYY-MM-DD] [--out <file>] [--min-n N] [--dry-run]' })
  const name = profileName(readFileSync(profile, 'utf8'))
  const root = resolve(opt('--root') || process.env.TILLER_RUN_STATE || join(homedir(), '.claude', 'run-state', name || basename(dirname(resolve(profile)))))
  if (!existsSync(root)) emit(1, { status: 'error', kind: 'script-error', reason: `no run-state directory at ${root}` })
  const date = opt('--date') || new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) emit(4, { status: 'refused', kind: 'policy', reason: '--date must be YYYY-MM-DD' })
  const minN = opt('--min-n') !== undefined ? Number(opt('--min-n')) : MIN_N
  if (!(Number.isInteger(minN) && minN >= 1)) emit(4, { status: 'refused', kind: 'policy', reason: '--min-n must be a positive integer' })
  const g = gather(root, { minN })
  const proposals = propose(g)
  const note = render(g, proposals, { date, root })
  const dry = argv.includes('--dry-run')
  const out = dry ? null : resolve(opt('--out') || join(dirname(resolve(profile)), 'retros', `${date}.md`))
  if (dry) process.stdout.write(note)
  else { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, note) }
  emit(0, { status: 'ok', out, runs: g.runCount, tickets: uniq(g.runs.map(r => r.ticket)).length, stopped: g.stopped.length, proposals: proposals.length })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
