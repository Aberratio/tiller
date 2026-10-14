#!/usr/bin/env node
// Per-call journal of a driver run: one line per lane call and per exec call, appended to
// <ROOT>/tickets/<TICKET>/driver-journal.jsonl.
//
//   node lib/driver/journal.mjs --report <driver-journal.jsonl>
//
// prints totals and per-phase output / cache-read (k / M), then a script-result line.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ZERO_USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })

export const journalPath = (root, ticket) => join(root, 'tickets', ticket, 'driver-journal.jsonl')

export function laneLine({ runId, phase, label, lane, model, outcome, durationMs = 0, costUsd = 0, usage = ZERO_USAGE, replayed = false }) {
  const u = usage || ZERO_USAGE
  return { runId, phase, label, lane, model: model ?? null, outcome, durationMs, costUsd,
    usage: { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheCreate: u.cacheCreate || 0 }, replayed, at: new Date().toISOString() }
}

export function execLine({ runId, phase, label, script, exitCode, durationMs = 0, replayed = false }) {
  return { runId, phase, label, kind: 'exec', script, exitCode: exitCode ?? null, durationMs, replayed }
}

export function appendJournal(path, line) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(line) + '\n')
}

export function readJournal(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}

const k = n => `${(n / 1000).toFixed(1)}k`
const M = n => `${(n / 1e6).toFixed(2)}M`

export function summarize(lines) {
  const lanes = lines.filter(l => !l.kind)
  const execs = lines.filter(l => l.kind === 'exec')
  const sum = (xs, f) => xs.reduce((n, x) => n + (f(x) || 0), 0)
  const phases = {}
  for (const l of lanes) {
    const p = phases[l.phase] || (phases[l.phase] = { calls: 0, output: 0, cacheRead: 0, costUsd: 0 })
    p.calls += 1
    p.output += l.usage?.output || 0
    p.cacheRead += l.usage?.cacheRead || 0
    p.costUsd += l.costUsd || 0
  }
  return {
    laneCalls: lanes.length,
    replayed: lanes.filter(l => l.replayed).length + execs.filter(l => l.replayed).length,
    output: sum(lanes, l => l.usage?.output),
    cacheRead: sum(lanes, l => l.usage?.cacheRead),
    costUsd: sum(lanes, l => l.costUsd),
    execCalls: execs.length,
    execMinutes: sum(execs, l => l.durationMs) / 60000,
    phases,
  }
}

export function report(lines) {
  const s = summarize(lines)
  const rows = [
    `lane calls: ${s.laneCalls} (replayed ${s.replayed})`,
    `total output: ${k(s.output)}`,
    `total cache-read: ${M(s.cacheRead)}`,
    `cost: $${s.costUsd.toFixed(2)}`,
    `exec calls: ${s.execCalls}`,
    `exec minutes: ${s.execMinutes.toFixed(1)}`,
    '',
    '| phase | output / cache-read |',
    '|---|---|',
    ...Object.entries(s.phases).map(([p, v]) => `| ${p} | ${k(v.output)} / ${M(v.cacheRead)} |`),
  ]
  return { text: rows.join('\n'), summary: s }
}

function main(argv) {
  const i = argv.indexOf('--report')
  const file = i >= 0 ? argv[i + 1] : null
  if (!file) {
    process.stdout.write(JSON.stringify({ status: 'refused', kind: 'refused', reason: 'usage: journal.mjs --report <driver-journal.jsonl>' }) + '\n')
    process.exit(4)
  }
  if (!existsSync(file)) {
    process.stdout.write(JSON.stringify({ status: 'error', kind: 'script-error', reason: `no journal at ${file}` }) + '\n')
    process.exit(1)
  }
  const { text, summary } = report(readJournal(file))
  process.stdout.write(text + '\n')
  process.stdout.write(JSON.stringify({ status: 'ok', ...summary, phases: undefined }) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
