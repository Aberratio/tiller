#!/usr/bin/env node
// Calibration feedback: every verdict ledger and driver journal under a run-state root, folded into
// what the router can use. Measured scores go to config/measured.json as
// { "<model>": { "<lane>": { score, n, evalRun } } } with score = 1 - overturn rate, only for pairs
// with at least minN verdicts; route() reads them to demote, never to admit. Recent mean tokens and
// cooldowns are computed the same way and handed to the router state at launch.
//
//   node lib/journal/calibrate.mjs --root <run-state dir> [--out <measured.json>] [--min-n N] [--as-of ISO] [--dry-run]
//
// Output: one script-result line (docs/harness.md, "Script I/O"). Exit 1 when the root is missing.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJournal } from '../driver/journal.mjs'
import { calibration } from './verdicts.mjs'

export const MIN_N = 10
export const COOLDOWN_MINUTES = 15
const round3 = n => Math.round(n * 1000) / 1000

// Every tickets/<ticket>/verdicts.jsonl and driver-journal.jsonl below the root, any depth.
export function journalsUnder(root) {
  const verdicts = [], journals = [], runs = new Set()
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p); continue }
      if (name !== 'verdicts.jsonl' && name !== 'driver-journal.jsonl') continue
      if (basename(dirname(dirname(p))) !== 'tickets') continue
      ;(name === 'verdicts.jsonl' ? verdicts : journals).push(p)
      runs.add(dirname(dirname(dirname(p))))
    }
  }
  walk(root)
  return { verdicts, journals, runs: runs.size }
}

export function measuredFrom(verdictLines, { minN = MIN_N, evalRun } = {}) {
  const measured = {}, skipped = []
  for (const row of Object.values(calibration(verdictLines))) {
    if (row.model === null || row.model === undefined || row.model === 'null') continue
    if (row.verdicts < minN) { skipped.push({ model: row.model, lane: row.lane, n: row.verdicts }); continue }
    ;(measured[row.model] ??= {})[row.lane] = { score: round3(1 - row.rate), n: row.verdicts, evalRun }
  }
  return { measured, skipped }
}

const finished = lines => lines.filter(l => !l.kind && l.model && l.lane && !l.replayed)

// Per model|lane: calls, mean tokens (input plus cache writes in, output out; cache reads are
// priced apart and left out) and spend, over finished calls.
export function recentFrom(journalLines) {
  const acc = {}
  for (const l of finished(journalLines).filter(l => l.outcome === 'ok')) {
    const a = acc[`${l.model}|${l.lane}`] ??= { calls: 0, in: 0, out: 0, costUsd: 0 }
    const u = l.usage || {}
    a.calls += 1; a.in += (u.input || 0) + (u.cacheCreate || 0); a.out += u.output || 0; a.costUsd += l.costUsd || 0
  }
  return Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, { calls: a.calls, meanTokens: { in: Math.round(a.in / a.calls), out: Math.round(a.out / a.calls) }, costUsd: round3(a.costUsd) }]))
}

// Spend per model|lane over every finished call, with the outcome tally the retro reads.
export function spendFrom(journalLines) {
  const acc = {}
  for (const l of finished(journalLines)) {
    const a = acc[`${l.model}|${l.lane}`] ??= { calls: 0, costUsd: 0, outcomes: {} }
    a.calls += 1; a.costUsd += l.costUsd || 0; a.outcomes[l.outcome] = (a.outcomes[l.outcome] || 0) + 1
  }
  for (const a of Object.values(acc)) a.costUsd = round3(a.costUsd)
  return acc
}

// A model rate-limited inside the window is cooled down until `minutes` after its last rate limit.
export function cooldownFrom(journalLines, asOf, minutes = COOLDOWN_MINUTES) {
  const since = Date.parse(asOf) - minutes * 60000
  const out = {}
  for (const l of finished(journalLines)) {
    if (l.outcome !== 'rate-limit' || !l.at) continue
    const t = Date.parse(l.at)
    if (!(t >= since && t <= Date.parse(asOf))) continue
    const c = out[l.model] ??= { until: null, failures: 0 }
    c.failures += 1
    const until = new Date(t + minutes * 60000).toISOString()
    if (!c.until || until > c.until) c.until = until
  }
  return out
}

// The shape route() reads; anything else in the file is a hand edit gone wrong.
export function checkMeasured(doc) {
  const errs = []
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['$: expected an object of models']
  for (const [model, lanes] of Object.entries(doc)) {
    if (!lanes || typeof lanes !== 'object' || Array.isArray(lanes)) { errs.push(`$.${model}: expected an object of lanes`); continue }
    for (const [lane, e] of Object.entries(lanes)) {
      const at = `$.${model}.${lane}`
      if (!e || typeof e !== 'object') { errs.push(`${at}: expected an object`); continue }
      if (!(typeof e.score === 'number' && e.score >= 0 && e.score <= 1)) errs.push(`${at}.score: expected a number in [0, 1]`)
      if (!(Number.isInteger(e.n) && e.n >= 1)) errs.push(`${at}.n: expected a positive integer`)
      if (!(typeof e.evalRun === 'string' && e.evalRun)) errs.push(`${at}.evalRun: expected a non-empty string`)
      for (const k of Object.keys(e)) if (!['score', 'n', 'evalRun'].includes(k)) errs.push(`${at}: unexpected "${k}"`)
    }
  }
  return errs
}

export function calibrate(root, { minN = MIN_N, asOf = new Date().toISOString() } = {}) {
  const found = journalsUnder(root)
  const evalRun = `calibrate-${asOf.slice(0, 10)}`
  const verdictLines = found.verdicts.flatMap(readJournal)
  const journalLines = found.journals.flatMap(readJournal)
  const { measured, skipped } = measuredFrom(verdictLines, { minN, evalRun })
  return { evalRun, runs: found.runs, verdicts: verdictLines.filter(l => l.kind === 'verdict').length, measured, skipped,
    recent: recentFrom(journalLines), spend: spendFrom(journalLines), cooldown: cooldownFrom(journalLines, asOf) }
}

function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
  const emit = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code) }
  const root = opt('--root')
  if (!root) emit(4, { status: 'refused', kind: 'policy', reason: 'usage: calibrate.mjs --root <run-state dir> [--out <measured.json>] [--min-n N] [--as-of ISO] [--dry-run]' })
  if (!existsSync(root)) emit(1, { status: 'error', kind: 'script-error', reason: `no run-state directory at ${root}` })
  const minN = opt('--min-n') !== undefined ? Number(opt('--min-n')) : MIN_N
  if (!(Number.isInteger(minN) && minN >= 1)) emit(4, { status: 'refused', kind: 'policy', reason: '--min-n must be a positive integer' })
  const r = calibrate(root, { minN, asOf: opt('--as-of') })
  const out = opt('--out')
  const errs = checkMeasured(r.measured)
  if (errs.length) emit(1, { status: 'error', kind: 'script-error', reason: errs.join('; ') })
  if (out && !argv.includes('--dry-run')) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(r.measured, null, 2) + '\n') }
  emit(0, { status: 'ok', out: out && !argv.includes('--dry-run') ? out : null, minN, ...r })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
