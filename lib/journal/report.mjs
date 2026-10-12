#!/usr/bin/env node
// Aggregate a phase-spend.jsonl into per-lane or per-phase totals, for the Friday routing review.
//
//   node lib/journal/report.mjs <phase-spend.jsonl> [--by lane|phase]   (default: lane)
//   node lib/journal/report.mjs --calibration <verdicts.jsonl>          (overturn rate per lane x model)

import { readFileSync } from 'node:fs'
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

function main() {
  const argv = process.argv.slice(2)
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
