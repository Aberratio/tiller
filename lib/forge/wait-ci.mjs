#!/usr/bin/env node
// Blocking CI wait, replacing polling done as repeated model turns (03-transcript-mining.md
// §2/§6: 714 `gh pr view`/`gh pr checks` calls, 70 files polling >=3x as separate turns).
// Settles by commit SHA via the check-runs API, never by the PR's current head — a check on a
// later commit never counts as an answer for an earlier one.
//
//   wait-ci.mjs --repo <owner/repo> --sha <sha> [--timeout <seconds>] [--interval <seconds>]
//
// Exit 2 (`pending`) at timeout with nothing settled; exit 0 (`ok`) once every check run on that
// exact SHA is completed, with `state: green|red|blocked` in the payload.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs, emit, refuse, scriptError, ghJson } from './_util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const kinds = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'kinds.json'), 'utf8'))

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.sha) refuse('usage: --repo <owner/repo> --sha <sha> [--timeout N] [--interval N]')

const timeout = Number(args.timeout ?? kinds.caps.waitCiSeconds.default)
const interval = Number(args.interval ?? 15)
const deadline = Date.now() + timeout * 1000

const GREEN = new Set(['success', 'neutral', 'skipped'])
const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale'])

function poll() {
  const res = ghJson(['api', `repos/${args.repo}/commits/${args.sha}/check-runs`])
  if (!res.ok) return { settled: false, error: res.r.stderr || String(res.r.error || '') }
  const runs = res.data.check_runs || []
  if (!runs.length) return { settled: false, runs }
  const settled = runs.every(r => r.status === 'completed')
  if (!settled) return { settled: false, runs }
  const conclusions = runs.map(r => r.conclusion)
  // Checks that all skipped (or only came back neutral) prove nothing ran: blocked, never green.
  const state = conclusions.some(c => RED.has(c)) || !conclusions.every(c => GREEN.has(c)) ? 'red'
    : conclusions.includes('success') ? 'green' : 'blocked'
  return { settled: true, state, runs }
}

let last
for (;;) {
  last = poll()
  if (last.settled) {
    emit(0, {
      status: 'ok',
      sha: args.sha,
      state: last.state,
      checks: last.runs.map(r => ({ name: r.name, conclusion: r.conclusion })),
    })
  }
  const remaining = (deadline - Date.now()) / 1000
  if (remaining <= 0) break
  spawnSync('sleep', [String(Math.min(interval, remaining))])
}

if (last && last.error) scriptError('gh api check-runs failed', { stderr: last.error })
emit(2, { status: 'pending', sha: args.sha, reason: 'checks not settled within timeout' })
