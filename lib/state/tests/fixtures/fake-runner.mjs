#!/usr/bin/env node
// Stand-in for a ticket runner: resumes from state, then runs each phase and checkpoints it through
// the CLI, the way the exec lane would. Every executed phase is appended to $EXECUTED_LOG.
//   fake-runner.mjs <ticket>
// Env: PHASE_DELAY_MS (default 0), DIE_AFTER=<phase> sends itself SIGKILL right after that checkpoint.
import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'state.mjs')
const PHASES = ['start', 'premise', 'plan', 'implement', 'review', 'pr', 'ci', 'review-bot', 'confidence', 'gate', 'merge', 'qa', 'cleanup', 'logs']
const ticket = process.argv[2]
const delay = Number(process.env.PHASE_DELAY_MS || 0)

const state = (...args) => {
  const r = spawnSync('node', [STATE, ...args], { encoding: 'utf8' })
  if (r.status !== 0) { process.stderr.write(r.stdout + r.stderr); process.exit(r.status || 1) }
  return JSON.parse(r.stdout)
}

state('init', ticket)
const res = state('resume', ticket)
if (res.capReached) { process.stdout.write(JSON.stringify({ parked: 'run-died' }) + '\n'); process.exit(0) }
const prior = res.artifact ? JSON.parse(readFileSync(res.artifact, 'utf8')).outputs : {}
appendFileSync(process.env.EXECUTED_LOG, `# start ${res.startPhase ?? 'finished'} plan=${prior.plan?.steps ?? '-'}\n`)
if (res.startPhase === null) process.exit(0)

for (const phase of PHASES.slice(PHASES.indexOf(res.startPhase))) {
  appendFileSync(process.env.EXECUTED_LOG, `${phase}\n`)
  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  const output = phase === 'plan' ? { steps: 3 } : { ok: true }
  state('phase-done', ticket, phase, JSON.stringify(output), '--head', 'abc1234')
  if (process.env.DIE_AFTER === phase) process.kill(process.pid, 'SIGKILL')
}
state('set-status', ticket, 'merged')
