#!/usr/bin/env node
// Exponential backoff around a script that can come back rate-limited, so a rate limit burns a
// sleep instead of a model turn deciding "got rate limited, try again" (03-transcript-mining.md
// §3: 166 rate-limit hits in one 30-day window, several retried inline instead of backing off).
//
//   with-backoff.mjs <absolute-script-path> [args...]
//
// Runs the script (a script-result-contract script: one JSON line, exit names the row). If it
// comes back `blocked`/`rate-limit`, sleeps and retries with exponential backoff and jitter, up
// to `caps.backoffAttempts`. Any other result, or an unrecognised kind, is passed through
// unchanged on the first try. `withBackoff` itself is time-free: it takes a `call` and a `sleep`
// function, so tests inject an instant fake clock instead of waiting minutes for real.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const kinds = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'kinds.json'), 'utf8'))

const FIRST_MS = kinds.caps.backoffFirstSeconds.default * 1000
const MAX_MS = kinds.caps.backoffMaxSeconds.default * 1000
const ATTEMPTS = kinds.caps.backoffAttempts.default

export const defaultJitter = ms => ms * (0.9 + Math.random() * 0.2)
export const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// `call(attemptNumber)` returns `{ result, exitCode }` where `result` is a parsed script-result
// object. Retries only while `result.status === 'blocked' && result.kind === 'rate-limit'`.
// Returns `{ result, exitCode, attempts, sleeps }` — `sleeps` is the list of ms actually slept,
// for tests to assert against without a real clock.
export async function withBackoff(call, { attempts = ATTEMPTS, firstMs = FIRST_MS, maxMs = MAX_MS, sleep = realSleep, jitter = defaultJitter } = {}) {
  const sleeps = []
  let delay = firstMs
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const outcome = await call(attempt)
    const isRateLimited = outcome.result?.status === 'blocked' && outcome.result?.kind === 'rate-limit'
    if (!isRateLimited || attempt === attempts) return { ...outcome, attempts: attempt, sleeps }
    const ms = jitter(delay)
    sleeps.push(ms)
    await sleep(ms)
    delay = Math.min(delay * 2, maxMs)
  }
}

function runScript(scriptPath, args) {
  const proc = spawnSync(scriptPath, args, { encoding: 'utf8' })
  const line = (proc.stdout || '').trim().split('\n').pop() || ''
  let result
  try { result = JSON.parse(line) } catch { result = null }
  return { result, exitCode: proc.status, stderr: proc.stderr }
}

async function main() {
  const [scriptPath, ...args] = process.argv.slice(2)
  if (!scriptPath) {
    process.stderr.write('usage: with-backoff.mjs <absolute-script-path> [args...]\n')
    process.exit(1)
  }
  const outcome = await withBackoff(() => runScript(scriptPath, args))
  if (outcome.result) process.stdout.write(JSON.stringify(outcome.result) + '\n')
  else process.stderr.write(outcome.stderr || 'with-backoff: script produced no parseable result\n')
  process.exit(outcome.exitCode ?? 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
