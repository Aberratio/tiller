// Shared plumbing for lib/git scripts: argv parsing and the one-JSON-line contract from
// docs/harness.md. No script-specific logic lives here.
import { spawnSync } from 'node:child_process'

export function parseArgs(argv, { repeatable = [] } = {}) {
  const out = {}
  for (const key of repeatable) out[key] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const val = argv[i + 1]
    if (repeatable.includes(key)) out[key].push(val)
    else out[key] = val
    i++
  }
  return out
}

export function emit(exitCode, obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(exitCode)
}

export function refuse(reason, extra = {}) {
  emit(4, { status: 'refused', kind: 'policy', reason, ...extra })
}

export function scriptError(reason, extra = {}) {
  emit(1, { status: 'error', kind: 'script-error', reason, ...extra })
}

export function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts })
}

export function gitLines(args, opts = {}) {
  const r = git(args, opts)
  if (r.error || r.status !== 0) return { ok: false, r }
  return { ok: true, lines: r.stdout.split('\n').filter(Boolean), r }
}
