#!/usr/bin/env node
// The single test entry point: every suite the repo has, one summary table, non-zero on any failure.
//
//   node lib/testing/run-all.mjs [--only <substring>] [--list]
//
// Node test files are discovered by directory (no shell globs). The per-directory run-tests.sh
// wrappers only repeat those globs plus the contract validator, so they are not run again here.

import { readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const ROOT = join(import.meta.dirname, '..', '..')
const { values } = parseArgs({ options: { only: { type: 'string' }, list: { type: 'boolean' } } })

const dirs = parent => {
  const base = join(ROOT, parent)
  return existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(parent, e.name)) : []
}
const testFiles = dir => {
  const abs = join(ROOT, dir)
  return existsSync(abs) ? readdirSync(abs).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(dir, f)) : []
}

const suites = []
for (const dir of [...dirs('lib').map(d => join(d, 'tests')), 'lib/tests', ...dirs('skills').map(d => join(d, 'tests'))].sort()) {
  const files = testFiles(dir)
  if (files.length) suites.push({ name: `node:${dir === 'lib/tests' ? dir : dir.replace(/\/tests$/, '')}`, cmd: ['node', '--test', '--test-reporter=tap', ...files] })
}
const scripts = [
  ['node', 'lib/journal/tests/run.mjs'],
  ['node', 'lib/routing/tests/run.mjs'],
  ['node', 'lib/contract/validate.mjs'],
  ['bash', 'skills/flow-brainstorm/scripts/run-tests.sh'],
  ['bash', 'skills/flow-pm/tests/run-tests.sh'],
  ['bash', 'skills/flow-confidence-check/scripts/tests/run_tests.sh'],
]
for (const cmd of scripts) suites.push({ name: cmd[1].replace(/\/(tests\/run\.mjs|run-tests\.sh|tests\/run-tests\.sh|scripts\/tests\/run_tests\.sh|scripts\/run-tests\.sh)$/, '').replace(/\/validate\.mjs$/, '/validate'), cmd })

const selected = suites.filter(s => !values.only || s.name.includes(values.only))
if (values.list) {
  for (const s of selected) console.log(`${s.name}\t${s.cmd.join(' ')}`)
  process.exit(0)
}
if (!selected.length) {
  console.error(`no suite matches --only ${values.only}`)
  process.exit(2)
}

// Sums every pass/fail counter a suite prints, in whichever of the repo's formats it uses.
const ANSI = /\x1b\[[0-9;]*m/g
const count = (text, ok) => {
  const clean = text.replace(ANSI, '')
  const patterns = ok
    ? [/^# pass (\d+)/gm, /^PASS: (\d+) checks/gm, /\bpassed: (\d+)/gm, /: (\d+) passed/gm]
    : [/^# fail (\d+)/gm, /^FAIL: (\d+) checks/gm, /\bfailed: (\d+)/gm, /passed, (\d+) failed/gm]
  return patterns.reduce((n, re) => n + [...clean.matchAll(re)].reduce((m, x) => m + Number(x[1]), 0), 0)
}

const rows = []
for (const s of selected) {
  const t0 = Date.now()
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  let pass = count(out, true)
  let fail = count(out, false)
  const exited = r.status === 0
  if (!exited && fail === 0) fail = 1
  if (exited && pass === 0 && fail === 0) pass = 1
  rows.push({ name: s.name, pass, fail, secs: (Date.now() - t0) / 1000, ok: exited && fail === 0, out })
  console.log(`${rows.at(-1).ok ? 'ok  ' : 'FAIL'} ${s.name}`)
}

const failed = rows.filter(r => !r.ok)
for (const r of failed) {
  const lines = r.out.replace(ANSI, '').split('\n')
  const bad = lines.filter(l => /^\s*not ok\b|^FAIL\b|^\s*FAIL:/.test(l))
  console.log(`\n--- ${r.name} ---`)
  console.log((bad.length ? bad : lines.filter(Boolean).slice(-30)).slice(0, 60).join('\n'))
}

const w = Math.max(5, ...rows.map(r => r.name.length))
console.log(`\n${'suite'.padEnd(w)}  ${'pass'.padStart(5)}  ${'fail'.padStart(5)}  ${'secs'.padStart(6)}`)
for (const r of rows) console.log(`${r.name.padEnd(w)}  ${String(r.pass).padStart(5)}  ${String(r.fail).padStart(5)}  ${r.secs.toFixed(1).padStart(6)}`)
const tp = rows.reduce((n, r) => n + r.pass, 0)
const tf = rows.reduce((n, r) => n + r.fail, 0)
console.log(`${'total'.padEnd(w)}  ${String(tp).padStart(5)}  ${String(tf).padStart(5)}  ${rows.reduce((n, r) => n + r.secs, 0).toFixed(1).padStart(6)}`)
process.exit(failed.length ? 1 : 0)
