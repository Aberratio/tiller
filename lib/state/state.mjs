#!/usr/bin/env node
// Run state store. Every state, checkpoint, decision, handoff, lock and quota write goes through here.
//
//   state.mjs init <ticket>                               create the ticket's run state (idempotent)
//   state.mjs phase-done <ticket> <phase> <json|@file> [--lane L] [--head SHA] [--status S [--reason TEXT] [--reason-full TEXT]]
//   state.mjs phase-get <ticket> <phase>                  latest output of that phase
//   state.mjs resume <ticket>                             startPhase + stored outputs (artifact)
//   state.mjs counter <ticket> <name> [--inc [--key K]]   read or bump a loop counter; a key already seen is not counted again
//   state.mjs set-status <ticket> <status> [--pr URL] [--reason TEXT]
//   state.mjs decide <json|@file> [--ledger PATH]         append to the decisions file and the branch ledger
//   state.mjs resolve <id> --resolution TEXT --by ROLE [--status resolved|withdrawn]
//   state.mjs open-count [--exclude k1,k2]                open ceiling decisions across the whole file
//   state.mjs handoff <text|@file> | --done | --pause ISO
//   state.mjs hash                                        digest of the run's state, for no-progress detection
//   state.mjs lock acquire <name> [--pid P] [--ttl S] [--timeout S] | lock release <name> <token>
//   state.mjs quota set <source> <resetAt ISO> | quota get [<source>]
//
// Root: STATE_ROOT is the run directory. Unset, it is ~/.claude/run-state/<FLOW_PROFILE>/<FLOW_RUN>/.
// The profile and run id are the root's last two path segments, so a root chosen by hand should keep
// that shape. Quota lives one level up, shared by every run of the profile.
//
// Layout under the root:
//   state.md                      handoff sections and `supervisor:` lines
//   decisions.jsonl               append-only; a later record with the same id supersedes an earlier one
//   tickets/<t>/run.json          run-state record
//   tickets/<t>/checkpoints/<seq>-<phase>.json
//   locks/<name>.lock/            mkdir lock with an owner file
//
// Output: one script-result JSON line (docs/harness.md, "Script I/O").

import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, kinds } from '../contract/validate.mjs'

const cap = name => kinds.caps[name].default
// Counters a run starts with; a run saved before a counter existed reads it as zero.
const COUNTERS = ['fixRounds', 'ciFix', 'confidencePasses', 'rebase', 'resumes', 'secondOpinions']
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')

class Exit extends Error {
  constructor(code, obj) { super(obj.reason || obj.status); this.code = code; this.obj = obj }
}
const refuse = reason => { throw new Exit(4, { status: 'refused', kind: 'policy', reason }) }
const fail = reason => { throw new Exit(1, { status: 'error', kind: 'script-error', reason }) }

export function resolveRoot(env = process.env) {
  if (env.STATE_ROOT) return env.STATE_ROOT.replace(/\/+$/, '')
  if (!env.FLOW_PROFILE || !env.FLOW_RUN) refuse('STATE_ROOT unset and FLOW_PROFILE/FLOW_RUN not both given')
  return join(env.HOME || homedir(), '.claude', 'run-state', env.FLOW_PROFILE, env.FLOW_RUN)
}

const safe = (what, v) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v || '')) refuse(`invalid ${what} "${v}"`)
  return v
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

const readJson = p => JSON.parse(readFileSync(p, 'utf8'))

// A killed writer can leave the last line without its newline; the next record must not be glued
// onto that fragment (readers skip the fragment, and would skip the record with it).
function appendLine(path, line) {
  let torn = false
  try {
    const st = statSync(path)
    if (st.size > 0) {
      const fd = openSync(path, 'r')
      try { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, st.size - 1); torn = b[0] !== 0x0a } finally { closeSync(fd) }
    }
  } catch { /* no file yet */ }
  appendFileSync(path, (torn ? '\n' : '') + line + '\n')
}

function inputJson(arg) {
  if (arg === undefined) refuse('missing JSON argument')
  try {
    return JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg)
  } catch (e) {
    return refuse(`unreadable JSON: ${e.message}`)
  }
}

function assertValid(schema, doc) {
  const errors = check(schema, doc)
  if (errors.length) throw new Exit(4, { status: 'refused', kind: 'policy', reason: `${schema} schema violation`, errors })
}

// ------------------------------------------------------------------------------------------ locks

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = pid => {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

function readOwner(dir) {
  try { return readJson(join(dir, 'owner')) } catch { return null }
}

function isStale(dir, ttlS) {
  const owner = readOwner(dir)
  if (!owner) {
    // Between mkdir and the owner write; only a dead writer leaves it like this for long.
    try { return Date.now() - statSync(dir).mtimeMs > ttlS * 1000 ? {} : null } catch { return null }
  }
  if (owner.host === hostname() && !alive(owner.pid)) return owner
  if (Date.now() - owner.since > ttlS * 1000) return owner
  return null
}

const lockDir = (root, name) => join(root, 'locks', `${safe('lock name', name)}.lock`)

export function lockOwner(root, name) {
  return readOwner(lockDir(root, name))
}

export function acquire(root, name, { pid = process.pid, ttl = 120, timeout = 30 } = {}) {
  const dir = lockDir(root, name)
  mkdirSync(dirname(dir), { recursive: true })
  const token = randomBytes(8).toString('hex')
  const deadline = Date.now() + timeout * 1000
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner'), JSON.stringify({ pid, host: hostname(), since: Date.now(), token }))
      return token
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    const stale = isStale(dir, ttl)
    if (stale) {
      // Rename is atomic, so of several breakers only one moves the directory; the token check
      // catches the case where the lock was re-taken between reading the owner and the rename.
      const grave = `${dir}.stale-${randomBytes(4).toString('hex')}`
      try {
        renameSync(dir, grave)
        const moved = readOwner(grave)
        if (moved && stale.token && moved.token !== stale.token) {
          try { renameSync(grave, dir) } catch { /* someone else holds it now; the victim re-acquires */ }
        } else rmSync(grave, { recursive: true, force: true })
      } catch { /* lost the race to another breaker */ }
      continue
    }
    if (Date.now() > deadline) fail(`lock "${name}" busy for ${timeout}s`)
    sleepMs(wait + Math.floor(Math.random() * wait))
  }
}

// Non-blocking acquire: the token, or null when a live holder has the lock (a stale one is broken
// as acquire does). `owner` then names the holder.
export function tryAcquire(root, name, opts = {}) {
  try { return { token: acquire(root, name, { ...opts, timeout: 0 }) } } catch (e) {
    if (e instanceof Exit && e.code === 1 && /busy/.test(e.obj.reason)) return { token: null, owner: lockOwner(root, name) }
    throw e
  }
}

export function release(root, name, token) {
  const dir = lockDir(root, name)
  const owner = readOwner(dir)
  if (!owner) return false
  if (owner.token !== token) refuse(`lock "${name}" is held by another token`)
  rmSync(dir, { recursive: true, force: true })
  return true
}

function withLock(root, name, fn) {
  const token = acquire(root, name)
  try { return fn() } finally { release(root, name, token) }
}

// ------------------------------------------------------------------------------------ run state

const ticketDir = (root, t) => join(root, 'tickets', safe('ticket', t))
const runPath = (root, t) => join(ticketDir(root, t), 'run.json')
const ids = root => ({ runId: process.env.FLOW_RUN || basename(root), profile: process.env.FLOW_PROFILE || basename(dirname(root)) })

function loadRun(root, t) {
  const p = runPath(root, t)
  if (!existsSync(p)) refuse(`no run state for ticket "${t}"; run init first`)
  return readJson(p)
}

function saveRun(root, run) {
  run.updatedAt = now()
  assertValid('run-state', run)
  writeAtomic(runPath(root, run.ticket), JSON.stringify(run, null, 2) + '\n')
  return run
}

function init(root, t) {
  return withLock(root, `ticket-${t}`, () => {
    if (existsSync(runPath(root, t))) return { created: false, run: loadRun(root, t) }
    const counters = Object.fromEntries(COUNTERS.map(k => [k, 0]))
    return { created: true, run: saveRun(root, { ...ids(root), ticket: t, status: 'running', counters }) }
  })
}

function checkpoints(root, t) {
  const dir = join(ticketDir(root, t), 'checkpoints')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map(f => /^(\d+)-([a-z-]+)\.json$/.exec(f))
    .filter(Boolean)
    .map(m => ({ seq: Number(m[1]), phase: m[2], file: join(dir, m[0]) }))
    .sort((a, b) => a.seq - b.seq)
}

function terminal(run, status, reason, reasonFull) {
  run.status = status
  if (reason) run.reason = String(reason).slice(0, 1000)
  else delete run.reason
  if (reasonFull) run.reasonFull = String(reasonFull).slice(0, 4000)
  else delete run.reasonFull
}

function phaseDone(root, t, phase, json, opts) {
  if (!kinds.phases.includes(phase)) refuse(`unknown phase "${phase}"`)
  if (opts.status && !kinds.runStatuses.includes(opts.status)) refuse(`unknown run status "${opts.status}"`)
  const output = inputJson(json)
  return withLock(root, `ticket-${t}`, () => {
    const run = loadRun(root, t)
    const cp = { runId: run.runId, ticket: t, phase, at: now(), output }
    if (opts.lane) cp.lane = opts.lane
    if (opts.head) cp.headSha = opts.head
    assertValid('checkpoint', cp)
    const seq = (checkpoints(root, t).at(-1)?.seq || 0) + 1
    // The checkpoint lands before the run state points at it, so a kill between the two writes
    // leaves a checkpoint resume can still see.
    writeAtomic(join(ticketDir(root, t), 'checkpoints', `${String(seq).padStart(4, '0')}-${phase}.json`), JSON.stringify(cp) + '\n')
    run.lastPhase = phase
    if (opts.head) run.headSha = opts.head
    if (opts.status) terminal(run, opts.status, opts.reason, opts['reason-full'])
    saveRun(root, run)
    return { seq, phase }
  })
}

function latestOutputs(root, t) {
  const out = {}
  for (const c of checkpoints(root, t)) out[c.phase] = readJson(c.file).output
  return out
}

function resume(root, t) {
  return withLock(root, `ticket-${t}`, () => {
    const run = loadRun(root, t)
    const cps = checkpoints(root, t)
    const outputs = latestOutputs(root, t)
    const payload = { ticket: t, runId: run.runId, completed: [...new Set(cps.map(c => c.phase))], resumes: run.counters.resumes, cap: cap('resumes') }
    if (!cps.length) return { ...payload, startPhase: kinds.phases[0], clean: true, capReached: false }
    const last = cps.at(-1).phase
    const next = kinds.phases[kinds.phases.indexOf(last) + 1] || null
    if (next && run.status !== 'merged') {
      run.counters.resumes += 1
      run.status = 'running'
      saveRun(root, run)
    }
    const artifact = join(ticketDir(root, t), 'resume.json')
    writeAtomic(artifact, JSON.stringify({ startPhase: next, outputs }) + '\n')
    return { ...payload, startPhase: next, resumes: run.counters.resumes, clean: false, capReached: run.counters.resumes > cap('resumes'), artifact }
  })
}

// A key makes the increment idempotent: an exec lane that retries a call whose write already
// landed would otherwise spend a fix round the run never had.
function counter(root, t, name, inc, key) {
  if (key !== undefined && !inc) refuse('--key needs --inc')
  return withLock(root, `ticket-${t}`, () => {
    const run = loadRun(root, t)
    if (!(name in run.counters)) {
      if (!COUNTERS.includes(name)) refuse(`unknown counter "${name}"`)
      run.counters[name] = 0
    }
    const c = kinds.caps[name]
    const answer = extra => ({ name, value: run.counters[name], cap: c.default, capReached: run.counters[name] >= c.default, ...extra })
    if (inc && key && (run.incKeys || []).includes(key)) return answer({ duplicate: true })
    if (inc) {
      run.counters[name] += 1
      if (key) run.incKeys = [...(run.incKeys || []), key].slice(-500)
      saveRun(root, run)
    }
    return answer()
  })
}

function setStatus(root, t, status, pr, reason) {
  return withLock(root, `ticket-${t}`, () => {
    const run = loadRun(root, t)
    terminal(run, status, reason)
    if (pr) run.prUrl = pr
    saveRun(root, run)
    return { ticket: t, runStatus: status }
  })
}

// ------------------------------------------------------------------------------------ decisions

const decisionsPath = root => join(root, 'decisions.jsonl')

export function readDecisions(root) {
  const p = decisionsPath(root)
  if (!existsSync(p)) return []
  const latest = new Map()
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue } // a torn last line from a killed writer
    latest.set(d.id, d)
  }
  return [...latest.values()]
}

function decide(root, json, ledger) {
  const d = inputJson(json)
  return withLock(root, 'decisions', () => {
    if (!d.runId) d.runId = ids(root).runId
    if (d.key) {
      const seen = readDecisions(root).find(x => x.key === d.key && x.runId === d.runId && x.ticket === d.ticket)
      if (seen) return { id: seen.id, decisionKind: seen.kind, ledger: ledger || null, duplicate: true }
    }
    if (!d.status) d.status = 'open'
    if (!d.at) d.at = now()
    if (!d.id) {
      safe('ticket', d.ticket)
      const n = new Set(readDecisions(root).filter(x => x.ticket === d.ticket).map(x => x.id)).size
      d.id = `${d.ticket}-D${n + 1}`
    }
    assertValid('decision', d)
    appendLine(decisionsPath(root), JSON.stringify(d))
    if (ledger) {
      mkdirSync(dirname(ledger), { recursive: true })
      const opts = d.options?.length ? ` Options: ${d.options.join(' / ')}.` : ''
      appendFileSync(ledger, `- ${d.at} \`${d.id}\` ${d.kind} (${d.status}): ${d.question} Why: ${d.why}.${opts}\n`)
    }
    return { id: d.id, decisionKind: d.kind, ledger: ledger || null }
  })
}

function resolveDecision(root, id, { resolution, by, status = 'resolved' }) {
  if (!resolution || !by) refuse('resolve needs --resolution and --by')
  return withLock(root, 'decisions', () => {
    const prev = readDecisions(root).find(d => d.id === id)
    if (!prev) refuse(`no decision "${id}"`)
    const d = { ...prev, status, resolution, resolvedBy: by, resolvedAt: now() }
    assertValid('decision', d)
    appendLine(decisionsPath(root), JSON.stringify(d))
    return { id, decisionStatus: status }
  })
}

export function openCount(root, exclude = []) {
  const byKind = {}
  let open = 0
  for (const d of readDecisions(root)) {
    if (d.status !== 'open' || !kinds.kinds[d.kind]?.ceiling || exclude.includes(d.kind)) continue
    open += 1
    byKind[d.kind] = (byKind[d.kind] || 0) + 1
  }
  return { open, byKind }
}

// -------------------------------------------------------------------------------- handoff, hash

function handoff(root, arg, opts) {
  const p = join(root, 'state.md')
  let text
  if (opts.done) text = 'supervisor: done\n'
  else if (opts.pause) {
    if (Number.isNaN(Date.parse(opts.pause))) refuse(`invalid --pause time "${opts.pause}"`)
    text = `supervisor: paused-usage ${opts.pause}\n`
  } else {
    if (!arg) refuse('handoff needs text, @file, --done or --pause')
    const body = arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg
    text = `\n## Handoff ${now()}\n\n${body.trimEnd()}\n`
  }
  return withLock(root, 'state-md', () => {
    mkdirSync(root, { recursive: true })
    appendFileSync(p, text)
    return { stateFile: p }
  })
}

export function stateHash(root) {
  const h = createHash('sha256')
  const walk = dir => {
    if (!existsSync(dir)) return
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f)
      if (p === join(root, 'locks') || f.endsWith('.log') || f === 'resume.json' || f.includes('.tmp-')) continue
      if (statSync(p).isDirectory()) walk(p)
      else h.update(p.slice(root.length)).update('\0').update(readFileSync(p)).update('\0')
    }
  }
  walk(root)
  return h.digest('hex')
}

// ---------------------------------------------------------------------------------------- quota

// quota.json is shared by every run of the profile, so its lock lives beside it, not in a run.
const quotaPath = root => join(dirname(root), 'quota.json')

function readQuotas(root) {
  const p = quotaPath(root)
  if (!existsSync(p)) return {}
  try {
    const all = readJson(p)
    if (all && typeof all === 'object' && !Array.isArray(all)) return all
    process.stderr.write(`${p}: not an object, treated as no quota\n`)
  } catch (e) {
    process.stderr.write(`${p}: unreadable (${e.message}), treated as no quota\n`)
  }
  return {}
}

function quotaSet(root, source, resetAt) {
  if (!source || Number.isNaN(Date.parse(resetAt || ''))) refuse('quota set needs <source> <resetAt ISO>')
  const q = { profile: ids(root).profile, source, resetAt, recordedAt: now() }
  assertValid('quota', q)
  return withLock(dirname(root), 'quota', () => {
    const all = readQuotas(root)
    all[source] = q
    writeAtomic(quotaPath(root), JSON.stringify(all, null, 2) + '\n')
    return { source, resetAt }
  })
}

function quotaGet(root, source) {
  const all = readQuotas(root)
  const active = Object.values(all).filter(q => (!source || q.source === source) && Date.parse(q.resetAt) > Date.now())
  return { active: active.length > 0, quotas: active.map(({ source: s, resetAt }) => ({ source: s, resetAt })) }
}

// ------------------------------------------------------------------------------------------ cli

function parse(argv) {
  const pos = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { pos.push(a); continue }
    const key = a.slice(2)
    if (['inc', 'done'].includes(key)) opts[key] = true
    else opts[key] = argv[++i]
  }
  return { pos, opts }
}

export function run(argv) {
  const { pos: [cmd, a, b, c], opts } = parse(argv)
  const root = resolveRoot()
  switch (cmd) {
    case 'init': return init(root, a)
    case 'phase-done': return phaseDone(root, a, b, c, opts)
    case 'phase-get': {
      const hit = checkpoints(root, a).filter(x => x.phase === b).at(-1)
      if (!hit) return { ticket: a, phase: b, found: false }
      const text = readFileSync(hit.file, 'utf8')
      return text.length > 3000 ? { ticket: a, phase: b, found: true, artifact: hit.file } : { ticket: a, phase: b, found: true, output: JSON.parse(text).output }
    }
    case 'resume': return resume(root, a)
    case 'counter': return counter(root, a, b, opts.inc, opts.key)
    case 'set-status':
      if (!kinds.runStatuses.includes(b)) refuse(`unknown run status "${b}"`)
      return setStatus(root, a, b, opts.pr, opts.reason)
    case 'decide': return decide(root, a, opts.ledger)
    case 'batch': {
      const ops = inputJson(a)
      if (!Array.isArray(ops) || !ops.length || !ops.every(o => Array.isArray(o) && o.length && o[0] !== 'batch')) refuse('batch needs a non-empty JSON array of argv arrays, none of them a batch')
      const done = []
      for (let i = 0; i < ops.length; i++) {
        try { done.push(run(ops[i].map(String))) } catch (e) {
          if (e instanceof Exit) throw new Exit(e.code, { ...e.obj, failedAt: i, batch: done })
          throw e
        }
      }
      return { ...done.at(-1), batch: done.slice(0, -1) }
    }
    case 'resolve': return resolveDecision(root, a, opts)
    case 'open-count': return openCount(root, (opts.exclude || '').split(',').filter(Boolean))
    case 'handoff': return handoff(root, a, opts)
    case 'hash': return { hash: stateHash(root) }
    case 'lock':
      if (a === 'acquire') {
        const pid = Number(opts.pid || process.ppid)
        return { name: b, token: acquire(root, b, { pid, ttl: Number(opts.ttl || 3600), timeout: Number(opts.timeout || 30) }) }
      }
      if (a === 'release') return { name: b, released: release(root, b, c) }
      return refuse('lock acquire|release')
    case 'quota':
      if (a === 'set') return quotaSet(root, b, c)
      if (a === 'get') return quotaGet(root, b)
      return refuse('quota set|get')
    default: return refuse(`unknown command "${cmd}"`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code = 0
  let obj
  try {
    const payload = run(process.argv.slice(2))
    const clash = ['status', 'kind', 'reason', 'retryAfter'].filter(k => k in payload)
    if (clash.length) fail(`payload uses reserved keys: ${clash.join(', ')}`)
    obj = { status: 'ok', ...payload }
  } catch (e) {
    if (e instanceof Exit) { code = e.code; obj = e.obj } else { code = 1; obj = { status: 'error', kind: 'script-error', reason: String(e.message || e) } }
  }
  process.stdout.write(JSON.stringify(obj) + '\n')
  process.exit(code)
}
