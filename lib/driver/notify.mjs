// TILLER_NOTIFY_CMD: a shell command run once per event with one JSON object on stdin,
//   { kind, runId | dayId, ticket, status, reason, at }
// kind is one of NOTIFY_KINDS. The command is a side channel: a failure, a timeout or a non-zero exit
// is logged and the run goes on.
import { spawn, spawnSync } from 'node:child_process'

export const NOTIFY_KINDS = ['park', 'died', 'cap-hit', 'day-end', 'stop-hour', 'battery-pause']
export const NOTIFY_TIMEOUT_MS = 10000

export function notifyEvent({ kind, runId, dayId, ticket = null, status = null, reason = null, at = new Date() }) {
  const id = dayId !== undefined ? { dayId } : { runId: runId ?? null }
  return { kind, ...id, ticket, status, reason: reason == null ? null : String(reason).slice(0, 600), at: (at instanceof Date ? at : new Date(at)).toISOString() }
}

const describe = r => r.error ? `${r.error.code || r.error.message}` : r.signal ? `killed by ${r.signal}` : `exited ${r.status}`

// Resolves to { ok, skipped?, reason? }; never rejects. The command gets its own process group so a
// timeout also ends whatever it started.
export function notify(event, { cmd = process.env.TILLER_NOTIFY_CMD, log = m => process.stderr.write(`${m}\n`), timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  if (!cmd) return Promise.resolve({ ok: true, skipped: true })
  return new Promise(res => {
    let p
    try {
      p = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'pipe'], detached: true })
    } catch (e) {
      log(`notify ${event.kind}: ${e.message}`)
      return res({ ok: false, reason: e.message })
    }
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL') } catch {} }, timeoutMs)
    p.stderr.on('data', d => { if (err.length < 2000) err += d })
    p.stdin.on('error', () => {})
    p.on('error', e => { clearTimeout(timer); log(`notify ${event.kind}: ${e.message}`); res({ ok: false, reason: e.message }) })
    p.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return res({ ok: true })
      const why = timedOut ? `timed out after ${timeoutMs}ms` : describe({ status: code, signal })
      log(`notify ${event.kind}: command ${why}${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`)
      res({ ok: false, reason: why })
    })
    p.stdin.end(JSON.stringify(event) + '\n')
  })
}

// For exit paths that cannot wait on a promise (signal and crash handlers).
export function notifySync(event, { cmd = process.env.TILLER_NOTIFY_CMD, log = m => process.stderr.write(`${m}\n`), timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  if (!cmd) return { ok: true, skipped: true }
  try {
    const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(event) + '\n', stdio: ['pipe', 'ignore', 'pipe'], timeout: timeoutMs, killSignal: 'SIGKILL' })
    if (r.status === 0) return { ok: true }
    const why = describe(r)
    log(`notify ${event.kind}: command ${why}`)
    return { ok: false, reason: why }
  } catch (e) {
    log(`notify ${event.kind}: ${e.message}`)
    return { ok: false, reason: e.message }
  }
}
