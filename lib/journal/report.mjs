#!/usr/bin/env node
// Aggregate a phase-spend.jsonl into per-lane or per-phase totals, for the Friday routing review.
//
//   node lib/journal/report.mjs <phase-spend.jsonl> [--by lane|phase]   (default: lane)
//   node lib/journal/report.mjs --calibration <verdicts.jsonl>          (overturn rate per lane x model)
//   node lib/journal/report.mjs --outcomes <run-state-root> [--since YYYY-MM-DD]  (run outcomes, park causes)

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calibration } from './verdicts.mjs'

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

export function aggregate(records, by = 'lane') {
  const totals = {}
  for (const r of records) {
    const key = r[by]
    totals[key] ??= { calls: 0, turns: 0, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, wallClockMinutes: 0, escalations: 0 }
    const t = totals[key]
    t.calls += 1
    t.turns += r.turns
    t.in += r.in
    t.out += r.out
    t.cacheRead += r.cacheRead
    t.cacheCreate += r.cacheCreate
    t.wallClockMinutes += (new Date(r.endedAt) - new Date(r.startedAt)) / 60000
    if (r.escalatedFrom) t.escalations += 1
  }
  return totals
}

const FINISHED = new Set(['merged', 'ready-to-sign', 'open-pr'])
const STALE_MS = 24 * 3600 * 1000

function findRunFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) findRunFiles(p, out)
    else if (e.name === 'run.json') out.push(p)
  }
  return out
}

// "gate: ci red, review-bot blocked" -> [{name, state}]. A blocked gate was never measured, so a park
// without a red one says nothing about the code.
export function parseGates(reason) {
  if (!/^gate: /.test(reason || '')) return []
  return reason.slice(6).split(', ').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*) (red|blocked)$/)
    return m ? { name: m[1], state: m[2] } : { name: s, state: 'unknown' }
  })
}

export function parkCause(reason) {
  const r = reason || ''
  if (/^(premise|duplicate)/.test(r)) return 'ticket'
  const gates = parseGates(r)
  if (!gates.length) return 'harness'
  if (gates.some(g => g.state === 'red' && !g.name.startsWith('precondition'))) return 'gate-red'
  if (gates.some(g => g.name.startsWith('precondition'))) return 'human'
  return 'gate-unmeasured'
}

export function outcomes(root, { since, now } = {}) {
  const nowMs = new Date(now || Date.now()).getTime()
  const runs = []
  const unreadable = []
  for (const f of findRunFiles(root)) {
    let r
    try { r = JSON.parse(readFileSync(f, 'utf8')) } catch { unreadable.push(f); continue }
    if (since && !(r.updatedAt >= since)) continue
    let status = r.status || 'unknown'
    if (status === 'running' && nowMs - new Date(r.updatedAt).getTime() > STALE_MS) status = 'stale'
    runs.push({ runId: r.runId || null, ticket: r.ticket || null, status, cause: status === 'parked' ? parkCause(r.reason) : null,
      reason: String(r.reason || '').slice(0, 200), updatedAt: r.updatedAt || null, prUrl: r.prUrl || null })
  }
  runs.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))

  const count = (xs, key) => xs.reduce((acc, x) => { if (x[key]) acc[x[key]] = (acc[x[key]] || 0) + 1; return acc }, {})
  const gates = {}
  for (const r of runs.filter(x => x.status === 'parked')) {
    for (const g of parseGates(r.reason)) {
      if (g.name.startsWith('precondition')) continue
      const row = gates[g.name] ??= { red: 0, blocked: 0 }
      if (g.state in row) row[g.state] += 1
    }
  }
  const latest = new Map()
  for (const r of runs) latest.set(r.ticket, r)
  const last = [...latest.values()]
  return {
    since: since || null, runs, unreadable,
    byStatus: count(runs, 'status'), parkedBy: count(runs, 'cause'), gates,
    tickets: { total: last.length, finished: last.filter(r => FINISHED.has(r.status)).length, byStatus: count(last, 'status') },
    prUrls: [...new Set(runs.map(r => r.prUrl).filter(Boolean))],
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--outcomes') {
    if (!argv[1]) { console.error('usage: report.mjs --outcomes <run-state-root> [--since YYYY-MM-DD] [--now ISO]'); process.exit(1) }
    const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
    console.log(JSON.stringify({ status: 'ok', ...outcomes(argv[1], { since: opt('--since'), now: opt('--now') }) }))
    return
  }
  if (argv[0] === '--calibration') {
    if (!argv[1]) { console.error('usage: report.mjs --calibration <verdicts.jsonl>'); process.exit(1) }
    console.log(JSON.stringify({ status: 'ok', calibration: calibration(readJsonl(argv[1])) }))
    return
  }
  const [path, ...rest] = argv
  if (!path) { console.error('usage: report.mjs <phase-spend.jsonl> [--by lane|phase]'); process.exit(1) }
  const byIdx = rest.indexOf('--by')
  const by = byIdx >= 0 ? rest[byIdx + 1] : 'lane'
  if (!['lane', 'phase'].includes(by)) { console.error('--by must be "lane" or "phase"'); process.exit(1) }

  const records = readJsonl(path)
  const totals = aggregate(records, by)
  console.log(JSON.stringify({ status: 'ok', by, totals }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
