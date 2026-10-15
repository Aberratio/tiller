// Entry of the Node driver: one ticket run over the phases, resumable from checkpoints (phase level)
// and from the step log (inside the unfinished phase).
//
//   const result = await createRun(args, runtime)
//   node lib/driver/drive.mjs --args <args-<ticket>.json>
//
// The CLI runs with the real runtime and prints one script-result line
// { status, runStatus, reason, prUrl, journal, steps: { replayed, live } }; every terminal run status
// (parked and paused-usage included) exits 0, a crash exits 1, a signal (SIGHUP, SIGINT, SIGTERM)
// exits 128 + its number after the running lanes' process groups are sent SIGTERM and the run is
// recorded as `died` with the signal's name. The result object is also written to
// <stateRoot>/tickets/<TICKET>/driver-result.json. A ticket another live process is running (its
// `ticket-run-<TICKET>` lock under the state root) is refused with kind `locked`, exit 4, and
// nothing is written.
//
// TILLER_NOTIFY_CMD (runtime.notifyCmd overrides it) hears about a park, a run-cap hit and a death
// (lib/driver/notify.mjs); a failing command is logged only.
//
// `result` is the run's outcome: { ticket, status, reason, prUrl, headSha, decisions, calls, gate }.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lockOwner, release, tryAcquire } from '../state/state.mjs'
import { openSteps } from '../state/steps.mjs'
import { setFenceNonce } from '../text/untrusted.mjs'
import { PHASES, Stop, clip, createContext, reasonOf } from './core.mjs'
import { execLine } from './journal.mjs'
import { PHASE_FNS } from './phases.mjs'
import * as realRuntime from './runtime.mjs'
import { killLive } from './proc.mjs'
import { notify, notifyEvent } from './notify.mjs'

const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'state', 'state.mjs')

// One live process per ticket under a state root. The lock outlives every phase, so only a dead
// holder (or one older than the ttl) is ever broken.
const RUN_LOCK_TTL_S = 7 * 24 * 3600
class Locked { constructor(owner) { this.owner = owner } }

function takeRunLock(c) {
  const name = `ticket-run-${c.TICKET}`
  // A run abandoned earlier inside this same process (a hung lane, never resumed) is not a live holder.
  const own = lockOwner(c.ROOT, name)
  if (own && own.pid === process.pid && own.host === hostname()) release(c.ROOT, name, own.token)
  const r = tryAcquire(c.ROOT, name, { ttl: RUN_LOCK_TTL_S })
  if (!r.token) throw new Locked(r.owner || { pid: null, host: null, since: null })
  return () => release(c.ROOT, name, r.token)
}

async function main(c) {
  c.releaseRunLock = takeRunLock(c)
  const argv = [process.execPath, c.H, 'resume', '--root', c.ROOT, '--ticket', c.TICKET]
  // Resume names the run, so its journal line waits until the runId is known.
  const started = Date.now()
  const resume = await c.execStep(argv, 'resume', { journaled: false })
  if (resume.status !== 'ok') throw c.stop('parked', `resume failed: ${resume.reason || resume.kind}`)
  if (resume.runId) c.runId = String(resume.runId).replace(/[^A-Za-z0-9._-]/g, '-')
  if (resume.fenceNonce) setFenceNonce(resume.fenceNonce)
  c.steps = openSteps({ root: c.ROOT, ticket: c.TICKET, runId: c.runId })
  await c.withScope('resume', () => c.steps.step('exec:resume', argv.slice(1), async () => resume, { volatile: true }))
  c.journalLine(execLine({ phase: c.cur, label: `${c.cur}:exec:resume`, script: 'resume', exitCode: resume.exitCode, durationMs: Date.now() - started }))

  if (resume.capReached) {
    await c.decide({ kind: 'run-died', question: `${c.TICKET} died ${resume.resumes} times; resume again?`, why: `resume cap ${resume.cap} reached`,
      options: ['resume once more after reading the last checkpoint', 'restart the ticket from a fresh worktree'], recommendation: 'resume once more after reading the last checkpoint', reversalCost: 'low' })
    throw c.stop('parked', 'resume cap reached')
  }
  Object.assign(c.out, resume.outputs || {})
  for (const p of PHASES) c.notes.push(...((c.out[p] && c.out[p].laneNotes) || []))
  // In-memory state the review phase leaves behind; a resume past review starts from its record.
  if (c.out.review) {
    c.statics = [...(c.out.review.staticChecks || [])]
    c.harnessFindings.push(...((c.out.confidence && c.out.confidence.harness) || c.out.review.harness || []))
  }
  if (c.out.start && c.out.start.branch) c.setWorktree(c.out.start.branch, c.out.start.worktree || c.wt)
  if (resume.startPhase === null) { c.status = (c.out.logs && c.out.logs.status) || resume.runStatus; return }
  c.prUrl = resume.prUrl || (c.out.pr && c.out.pr.prUrl) || null
  c.prNumber = c.out.pr ? c.out.pr.number : null
  c.head = [...PHASES].reverse().map(p => c.out[p] && c.out[p].headSha).find(Boolean) || null
  const from = PHASES.indexOf(resume.startPhase)
  if (!resume.clean) c.log(`${c.TICKET}: resuming at ${resume.startPhase} (${resume.resumes}/${resume.cap})`)
  if (from > PHASES.indexOf('merge')) c.status = c.out.merge ? c.out.merge.status : c.status

  for (const p of PHASES.slice(from, PHASES.indexOf('logs'))) {
    c.cur = p
    c.runtime.phase?.(p)
    await c.withScope(p, () => PHASE_FNS[p](c))
  }
}

const resultOf = c => ({ ticket: c.TICKET, status: c.status, reason: c.reason, reasonFull: c.reasonFull, prUrl: c.prUrl, headSha: c.head, decisions: c.decisions, calls: c.calls, gate: c.out.gate || null })

export async function createRun(args, runtime) {
  const { result, fatal } = await drive(args, runtime)
  if (fatal) throw fatal
  return result
}

// Like createRun, but never throws past the context: a crash comes back as `fatal` next to the
// result it left, together with the step-log counts. `ctl.die(why)` is set for the caller's signal
// handlers: it records the run as died while the process is still alive.
export async function drive(args, runtime, ctl = {}) {
  const c = createContext(args, runtime)
  let fatal = null
  let locked = null
  let ended = false
  // Synchronous on purpose: it runs from a signal handler, and only the first words stand.
  ctl.die = why => {
    if (ended || locked) return
    ended = true
    c.status = 'died'
    c.reason = clip(why, 600)
    const dir = join(c.ROOT, 'tickets', c.TICKET)
    try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'driver-result.json'), JSON.stringify(resultOf(c), null, 2) + '\n') } catch {}
    const env = { ...process.env, STATE_ROOT: c.ROOT }
    spawnSync(process.execPath, [STATE, 'set-status', c.TICKET, 'died', '--reason', c.reason], { env })
    spawnSync(process.execPath, [STATE, 'handoff', `${c.TICKET} died: ${c.reason}. Relaunch the same command to resume from the last checkpoint.`], { env })
    if (c.releaseRunLock) try { c.releaseRunLock() } catch {}
  }
  try {
    await main(c)
  } catch (e) {
    if (e instanceof Locked) {
      // The ticket is being run by the holder: nothing of this process reaches the run's state.
      locked = e.owner
      c.reason = `${c.TICKET} is run by pid ${e.owner.pid} on ${e.owner.host || 'this host'} since ${e.owner.since ? new Date(e.owner.since).toISOString() : 'unknown'}`
    } else if (e instanceof Stop) { c.status = e.status; c.reason = e.reason; c.reasonFull = e.reasonFull || null } else { fatal = e; c.status = 'died'; c.reason = clip(reasonOf(e), 600) }
  }
  // Every way out except a usage pause ends at the logs checkpoint, which carries the terminal
  // status into run.json in the same write.
  if (!locked && c.status !== 'paused-usage' && !c.out.logs) {
    try {
      c.cur = 'logs'
      c.runtime.phase?.('logs')
      await c.withScope('logs', async () => {
        await c.flush()
        // The summary is prose only: a park of its own lane must not replace the run's terminal status.
        const prose = fatal ? null : await c.lane('log-prose',
          `Write three impersonal sentences summarising run ${c.TICKET}: status ${c.status}${c.reason ? ` (${c.reason})` : ''}, PR ${c.prUrl || 'none'}, head ${c.head || 'none'}, ` +
          `open decisions ${c.decisions.join(', ') || 'none'}. No names, no first person. ${c.RESULT_CONTRACT}`, 'summary')
          .catch(e => { if (e instanceof Stop && e.status !== 'paused-usage') return null; throw e })
        c.out.logs = { status: c.status, reason: c.reason, reasonFull: c.reasonFull, prUrl: c.prUrl, headSha: c.head, decisions: c.decisions, summary: prose ? clip(prose.text, 600) : null }
        await c.checkpoint('logs', c.out.logs, ['--status', c.status, ...(c.reason ? ['--reason', c.reason] : []), ...(c.reasonFull ? ['--reason-full', c.reasonFull] : [])])
      })
    } catch (e) {
      if (!fatal) { if (e instanceof Stop) { c.status = e.status; c.reason = e.reason; c.reasonFull = e.reasonFull || null } else throw e }
    }
  }
  ended = true
  if (c.releaseRunLock) try { c.releaseRunLock() } catch { /* broken as stale and re-taken meanwhile: not this run's to release */ }
  const kind = locked ? null : c.status === 'died' ? 'died' : c.status === 'parked' ? (/^budget-exhausted/.test(c.reason || '') ? 'cap-hit' : 'park') : null
  if (kind) await notify(notifyEvent({ kind, runId: c.runId, ticket: c.TICKET, status: c.status, reason: c.reason, at: (runtime.now || (() => new Date()))() }),
    { cmd: runtime.notifyCmd !== undefined ? runtime.notifyCmd : process.env.TILLER_NOTIFY_CMD, log: c.log })
  const stats = c.steps ? c.steps.stats : { replayed: 0, live: 0 }
  return { result: resultOf(c), fatal, steps: { replayed: stats.replayed, live: stats.live }, journal: c.journal, ...(locked ? { locked } : {}) }
}

// Args written for the retired Workflow runner are refused, not migrated: rebuild them with harness.mjs args.
export const LEGACY_ARGS = 'args were built for the retired Workflow runner ("driver": "workflow"); rebuild them with harness.mjs args'

export const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

// A signal ends the run as `died` with the signal's name: the running lanes' process groups are
// sent SIGTERM (they lead their own groups, so a kill of this process's group does not reach them),
// then the record, run status and handoff are written through `ctl.die` before the process exits
// 128 + the signal number.
export function installLastWords(ctl, { emit, on = (sig, fn) => process.on(sig, fn), exit = code => process.exit(code), kill = () => killLive('SIGTERM') }) {
  const lastWords = (why, code) => {
    try { kill() } catch {}
    if (ctl.die) ctl.die(why)
    emit(code, { status: 'error', kind: 'script-error', runStatus: 'died', reason: clip(why, 600) })
    exit(code)
  }
  for (const [sig, n] of Object.entries(SIGNALS)) on(sig, () => lastWords(`killed by ${sig}`, 128 + n))
  return lastWords
}

async function cli(argv) {
  const emit = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exitCode = code }
  const i = argv.indexOf('--args')
  const file = i >= 0 ? argv[i + 1] : undefined
  if (!file || file.startsWith('--')) return emit(4, { status: 'refused', kind: 'policy', reason: 'usage: drive.mjs --args <args-<ticket>.json>' })
  try {
    const args = JSON.parse(readFileSync(resolve(file), 'utf8'))
    if (args && args.driver === 'workflow') return emit(4, { status: 'refused', kind: 'policy', reason: LEGACY_ARGS })
    if (args && args.stateRoot) process.env.STATE_ROOT = args.stateRoot
    const ctl = {}
    installLastWords(ctl, { emit })
    const { result, fatal, steps, journal, locked } = await drive(args, { exec: realRuntime.exec, lane: realRuntime.lane, pool: realRuntime.pool }, ctl)
    if (locked) return emit(4, { status: 'refused', kind: 'locked', runStatus: result.status, reason: result.reason })
    const dir = join(args.stateRoot, 'tickets', result.ticket)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'driver-result.json'), JSON.stringify(result, null, 2) + '\n')
    if (fatal) return emit(1, { status: 'error', kind: 'script-error', runStatus: result.status, reason: result.reason, prUrl: result.prUrl, journal, steps })
    emit(0, { status: 'ok', runStatus: result.status, reason: result.reason, prUrl: result.prUrl, journal, steps })
  } catch (e) {
    emit(1, { status: 'error', kind: 'script-error', reason: clip(reasonOf(e), 600) })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli(process.argv.slice(2))
