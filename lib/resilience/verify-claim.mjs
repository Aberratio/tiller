#!/usr/bin/env node
// Re-run the profile's own test command before any gate trusts a "green" claim (09-16 flow-notes
// §2.5: an agent reported "Full suite green: 2601 tests", the real run was 2604 tests with 11
// failing — caught only because someone re-ran it). This script IS the re-run: a claim that feeds
// a gate is never taken on the claimant's word.
//
//   verify-claim.mjs <profile.md> <match> <claim> [--cwd <dir>] [--section <heading>] [--expect-sha <sha>]
//
// `match` selects one row of the profile's `## test toolchain` table by an exact, case-insensitive
// key: any whitespace-separated word of any cell (lane, repo, level — the table's columns are not
// fixed). An `org/repo` slug also matches its short name. `claim` is "pass" or "fail". The row's
// `Command` column (matched by header name, not position, since profiles disagree on column order)
// must be one code span; prose, `n/a` and TODO cells are not commands, and the first matching row
// whose cell is a command wins. It runs under `sh -c` in `--cwd` (default: the current directory);
// exit 0 is "pass", anything else is "fail" — except 126/127, which mean the command itself could
// not run. Measured: status `ok`, whether or not the claim held. Not measurable (no row, no
// command, exit 126/127): status `blocked`, kind `toolchain`, with no `mismatch` — a toolchain the profile cannot
// run says nothing about the code, so the caller must never turn it into a fix round.
// `--section` reads another table of the same shape, e.g. `## static checks`.
// `--expect-sha`: the worktree must be clean and at that commit, or the claim is `blocked`, unrun.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const STDOUT_CAP = 4096
const lastLine = s => String(s || '').trim().split('\n').pop().slice(0, 300)

// Body of one `## heading`, up to the next `## `.
function section(text, heading) {
  const lines = text.split('\n')
  const want = `## ${heading}`.toLowerCase()
  const out = []
  let inSection = false
  for (const line of lines) {
    if (line.trim().toLowerCase() === want) { inSection = true; continue }
    if (inSection && /^##\s/.test(line)) break
    if (inSection) out.push(line)
  }
  return out
}

function tableRows(lines) {
  return lines
    .filter(l => l.trim().startsWith('|'))
    .filter(l => !/^\|[\s:|-]*-[\s:|-]*\|$/.test(l.trim())) // drop the header separator row
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
}

const unticked = c => c.replace(/`/g, '')

// A command cell is exactly one code span; anything else is prose about a toolchain, not a command.
export function isRunnableCell(raw) {
  const m = /^`([^`]+)`$/.exec(String(raw || '').trim())
  return Boolean(m) && !/TODO/i.test(m[1])
}

// Returns [{ cells, command, runnable }] for the data rows (row 0 of `raw` is the header).
export function testToolchainRows(profileText, heading = 'test toolchain') {
  const raw = tableRows(section(profileText, heading))
  if (raw.length < 2) return { header: [], rows: [] }
  const header = raw[0].map(unticked)
  const commandIdx = header.findIndex(h => /^command$/i.test(h))
  const rows = raw.slice(1)
    .filter(r => r.some(c => c !== ''))
    .map(r => {
      const cell = commandIdx >= 0 ? (r[commandIdx] || '') : ''
      return { cells: r.map(unticked), command: unticked(cell), runnable: isRunnableCell(cell) }
    })
  return { header, rows }
}

const keys = cell => cell.toLowerCase().split(/\s+/).filter(Boolean)

export function findCommand(profileText, match, heading = 'test toolchain') {
  const { header, rows } = testToolchainRows(profileText, heading)
  if (header.length === 0) return { error: `profile has no "## ${heading}" table` }
  const wanted = [...new Set([match, String(match).split('/').pop()].map(s => String(s).toLowerCase()).filter(Boolean))]
  const hits = rows.filter(r => r.cells.some(c => keys(c).some(k => wanted.includes(k))))
  if (hits.length === 0) return { error: `no ${heading} row matches "${match}"` }
  const hit = hits.find(r => r.runnable)
  if (!hit) return { error: `matched ${heading} row's command cell is not a runnable command (one code span): ${hits[0].cells.join(' | ')}` }
  return { command: hit.command }
}

export function runCommand(command, cwd) {
  const proc = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' })
  return { exitCode: proc.status, stdout: proc.stdout || '', stderr: proc.stderr || '', spawnError: proc.error }
}

const NOT_RUNNABLE = { 126: 'found but not executable', 127: 'not found' }

// A re-run proves something about a commit only when the tree is that commit and nothing else.
function headCheck(cwd, expectSha) {
  const g = (...a) => spawnSync('git', ['-C', cwd || process.cwd(), ...a], { encoding: 'utf8' })
  const rev = g('rev-parse', 'HEAD')
  if (rev.status !== 0) return `HEAD unreadable in ${cwd}: ${lastLine(rev.stderr)}`
  const head = rev.stdout.trim()
  const want = String(expectSha).toLowerCase()
  if (want.length < 7 || !head.startsWith(want)) return `worktree HEAD is ${head}, not the expected ${expectSha}`
  const st = g('status', '--porcelain', '--untracked-files=all')
  if (st.status !== 0) return `git status failed in ${cwd}: ${lastLine(st.stderr)}`
  const dirty = st.stdout.split('\n').filter(Boolean).map(l => l.slice(3))
  return dirty.length ? `worktree at ${head} has uncommitted changes: ${dirty.slice(0, 10).join(', ')}` : null
}

export function verify({ profileText, match, claim, cwd, section: heading, expectSha }) {
  const found = findCommand(profileText, match, heading)
  if (found.error) return { status: 'blocked', kind: 'toolchain', reason: found.error }
  if (expectSha) {
    const off = headCheck(cwd, expectSha)
    if (off) return { status: 'blocked', kind: 'toolchain', command: found.command, reason: off }
  }

  const run = runCommand(found.command, cwd)
  if (run.spawnError) return { status: 'error', kind: 'script-error', reason: `could not run "${found.command}": ${run.spawnError.message}` }
  if (NOT_RUNNABLE[run.exitCode]) {
    const why = lastLine(run.stderr) || NOT_RUNNABLE[run.exitCode]
    return { status: 'blocked', kind: 'toolchain', command: found.command, exitCode: run.exitCode, reason: `test command "${found.command}" could not run (exit ${run.exitCode}: ${why})` }
  }

  const actual = run.exitCode === 0 ? 'pass' : 'fail'
  const result = {
    status: 'ok',
    match,
    command: found.command,
    claim,
    actual,
    exitCode: run.exitCode,
    mismatch: claim !== actual,
  }

  const output = (run.stdout + (run.stderr ? '\n' + run.stderr : '')).trim()
  const blob = JSON.stringify({ ...result, output })
  if (blob.length > STDOUT_CAP) {
    const dir = mkdtempSync(join(tmpdir(), 'verify-claim-'))
    const path = join(dir, 'output.txt')
    writeFileSync(path, output)
    result.artifact = path
  } else {
    result.output = output
  }
  return result
}

function main() {
  const args = process.argv.slice(2)
  const opts = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' || args[i] === '--section' || args[i] === '--expect-sha') opts[args[i].slice(2)] = args[++i]
    else positional.push(args[i])
  }
  const cwd = opts.cwd || process.cwd()
  const [profilePath, match, claim] = positional
  if (!profilePath || !match || !claim) {
    process.stderr.write('usage: verify-claim.mjs <profile.md> <match> <pass|fail> [--cwd <dir>] [--section <heading>] [--expect-sha <sha>]\n')
    process.exit(1)
  }
  const profileText = readFileSync(profilePath, 'utf8')
  const result = verify({ profileText, match, claim, cwd, section: opts.section, expectSha: opts['expect-sha'] })
  process.stdout.write(JSON.stringify(result) + '\n')
  const kinds = JSON.parse(readFileSync(new URL('../contract/kinds.json', import.meta.url)))
  process.exit(kinds.statuses[result.status])
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
