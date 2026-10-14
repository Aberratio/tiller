// Node day driver: an approved queue run in waves of ticket runs under the day ceiling of open
// decisions, then a regression sweep and a day summary. The Node counterpart of
// skills/flow-run-day/run-day.workflow.js, with the same day semantics.
//
//   const { result, fatal } = await driveDay(args, runtime)
//   node lib/driver/day.mjs --args <stateRoot>/args-day.json
//
// Each ticket runs in its own `node lib/driver/drive.mjs` process (runtime.launch overrides that), so
// a child that crashes, runs out of memory or is killed is one `died` result and the day moves on.
// The day holds the `day` lock for its lifetime and keeps <stateRoot>/day-result.json current: status
// `running` with its pid while it runs, the outcome on every way out the process can catch.
//
// The CLI prints one line { status, dayStatus, reason, results, record, journal }; every terminal day
// status exits 0, a crash 1, a refusal (lock held, bad args) 4, a signal 128 + its number.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquire, release } from '../state/state.mjs'
import { Stop, clip, createContext } from './core.mjs'
import * as realRuntime from './runtime.mjs'
import { journalPath, readJournal, summarize } from './journal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVE = join(HERE, 'drive.mjs')
const STATE = join(HERE, '..', 'state', 'state.mjs')

const writeJson = (file, obj) => {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  renameSync(tmp, file)
}
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null } }

function checkArgs(a) {
  for (const k of ['facts', 'date', 'stateRoot', 'harnessBin', 'lib', 'routing', 'schemas', 'caps', 'tiers', 'waves'])
    if (!a || a[k] === undefined || a[k] === null) return `args.${k} is required; build args with bin/harness.mjs day-args`
  if (!Number.isInteger((a.facts.runPolicy || {}).dayCeiling)) return 'facts.runPolicy.dayCeiling is required'
  if (!a.facts.dayRunAllowed || !a.facts.ownerProxy) return 'the profile has no owner proxy: an unattended day run is refused'
  return null
}

// One ticket run as a child process. Resolves to the driver's result, or null when it left none.
export function spawnLaunch(children) {
  return (entry, childArgs) => new Promise(res => {
    const file = join(childArgs.stateRoot, `args-${entry.ticket}.json`)
    writeFileSync(file, JSON.stringify(childArgs))
    const resultFile = join(childArgs.stateRoot, 'tickets', entry.ticket, 'driver-result.json')
    const before = existsSync(resultFile) ? statSync(resultFile).mtimeMs : null
    // Own process group, so a kill of the day reaches the child's lanes too.
    const p = spawn(process.execPath, [DRIVE, '--args', file], { stdio: ['ignore', 'pipe', 'inherit'], detached: true, env: { ...process.env, STATE_ROOT: childArgs.stateRoot } })
    children.add(p)
    let out = ''
    p.stdout.on('data', d => { out += d })
    p.on('close', (code, signal) => {
      children.delete(p)
      if (signal) return res({ ticket: entry.ticket, status: 'died', reason: `drive.mjs killed by ${signal}` })
      const fresh = existsSync(resultFile) && statSync(resultFile).mtimeMs !== before
      const result = fresh ? readJson(resultFile) : null
      if (result && code === 0) return res(result)
      let line = null
      try { line = JSON.parse(out.trim().split('\n').pop()) } catch {}
      res({ ...(result || { ticket: entry.ticket }), status: 'died', reason: clip((line && line.reason) || `drive.mjs exited ${code}`, 300) })
    })
    p.on('error', e => { children.delete(p); res({ ticket: entry.ticket, status: 'died', reason: clip(e.message, 300) }) })
  })
}

export async function driveDay(args, runtime, ctl = {}) {
  const bad = checkArgs(args)
  if (bad) return { result: { status: 'refused', reason: bad }, fatal: null }
  const DATE = args.date
  const ROOT = args.stateRoot
  const TICKET = `day-${DATE}`
  const RECORD = join(ROOT, 'day-result.json')
  mkdirSync(ROOT, { recursive: true })

  let token
  try {
    token = acquire(ROOT, 'day', { pid: runtime.pid ?? process.pid, ttl: 86400, timeout: 0 })
  } catch (e) {
    const owner = readJson(join(ROOT, 'locks', 'day.lock', 'owner')) || {}
    return { result: { date: DATE, status: 'refused', reason: `another day driver holds the day lock (pid ${owner.pid ?? '?'}): ${clip(e.message, 200)}` }, fatal: null }
  }

  const F = args.facts
  const RP = F.runPolicy || {}
  const CEILING = RP.dayCeiling
  const MAXP = Math.max(1, RP.maxParallel || 1)
  const EXCLUDE = (RP.ceilingExclusions || []).filter(k => args.kinds && args.kinds[k] && args.kinds[k].ceiling)
  const WAVES = args.waves
  const { waves: _w, runTicketScript: _s, driver: _d, ...CHILD_BASE } = args
  const launch = runtime.launch || spawnLaunch(ctl.children || new Set())

  const c = createContext({ ...args, ticket: TICKET }, runtime)
  c.ledgerIn = () => null
  c.ledger = null
  c.cur = 'waves'
  const results = []
  let liftedOnce = !!(readJson(RECORD) || {}).liftedOnce
  let sweep = null
  let summary = null

  const snapshot = () => ({
    date: DATE, status: c.status, reason: c.reason, pid: runtime.pid ?? process.pid, updatedAt: new Date().toISOString(),
    results, merged: results.filter(r => r.status === 'merged' && !r.skipped).map(r => r.ticket), decisions: c.decisions,
    ceiling: CEILING, liftedOnce, readyToSign: results.filter(r => r.status === 'ready-to-sign'), sweep, summary,
    calls: c.calls, journal: c.journal,
  })
  const save = () => writeJson(RECORD, snapshot())
  let ended = false
  // Synchronous on purpose: it also runs from signal and uncaught-error handlers.
  ctl.die = why => {
    if (ended) return
    ended = true
    c.status = 'died'
    c.reason = clip(why, 600)
    try { save() } catch {}
    spawnSync(process.execPath, [STATE, 'handoff', `day ${DATE} died: ${c.reason}. Relaunch the same command to resume; finished tickets are skipped.`], { env: { ...process.env, STATE_ROOT: ROOT } })
    try { release(ROOT, 'day', token) } catch {}
  }
  save()

  // The day's decisions are written at once and unkeyed: a rerun of the day asks again.
  c.decide = async ({ ticket, kind, question, why, blocks, options, recommendation, reversalCost }) => {
    const d = { ticket: ticket || TICKET, kind, question: clip(question, 1000), why: clip(why, 1000), blocks: clip(blocks || `the ${DATE} day run`, 300) }
    if (options && options.length) d.options = options.map(o => clip(o, 300))
    if (recommendation) d.recommendation = clip(recommendation, 300)
    if (reversalCost) d.reversalCost = clip(reversalCost, 300)
    const r = await c.state(['decide', JSON.stringify(d)], 'state-decide')
    if (r.status === 'ok') c.decisions.push(r.id)
    else c.log(`day: decision not recorded (${r.reason || r.kind}): ${clip(question, 120)}`)
    return r.id || null
  }
  c.pauseForUsage = async retryAfter => {
    await c.state(retryAfter ? ['handoff', '--pause', retryAfter] : ['handoff', `paused-usage: day ${DATE}, reset time unknown`])
    throw c.stop('paused-usage', `usage limit${retryAfter ? ` until ${retryAfter}` : ''}`)
  }
  // A day lane's questions go up the escalation chain one by one; nothing re-runs the lane.
  const lane = async (name, prompt, detail) => {
    const r = await c.lane(name, prompt, detail, { noEscalation: true })
    for (const x of (r && r.questions) || [])
      await c.escalate({ ticket: TICKET, kind: 'question', status: 'open', question: x.question, why: x.why || `raised by ${name}`,
        options: x.options, recommendation: x.recommendation, blocks: `the ${DATE} day run` })
    return r
  }

  const openCount = async () => {
    const r = await c.state(['open-count', ...(EXCLUDE.length ? ['--exclude', EXCLUDE.join(',')] : [])], 'open-count')
    if (r.status !== 'ok') throw c.stop('parked', `open-count refused: ${r.reason || r.kind}`)
    return r.open
  }

  const ceilingAllows = async notStarted => {
    const open = await openCount()
    if (open < CEILING) return true
    const rec = { ticket: TICKET, kind: 'ceiling', status: 'open',
      question: `The day stopped at ${open} open decisions (ceiling ${CEILING}); ${notStarted.join(', ')} did not start. Resolve the open items, or lift the ceiling once?`,
      why: `open-count ${open} >= dayCeiling ${CEILING}`, blocks: notStarted.join(', '),
      options: ['resolve the open decisions, then resume the day', 'lift the ceiling for one more chunk', 'leave the rest of the queue for another day'],
      recommendation: 'resolve the open decisions, then resume the day', reversalCost: 'low: a resumed day skips finished tickets' }
    if (!liftedOnce) {
      const r = await c.escalate(rec, { mandate: 'lift-cap-once', what: `one more chunk past ceiling ${CEILING}` })
      if (r.ok) { liftedOnce = true; save(); c.log(`ceiling ${CEILING} lifted once by ${r.route}`); return true }
    } else await c.decide(rec)
    c.status = 'ceiling'
    c.reason = `ceiling ${CEILING} reached with ${open} open decisions`
    c.log(c.reason)
    return false
  }

  // Each child is held to the run cap across all its runs, so what the queue and the day's own lanes
  // recorded plus the run cap each chunk ticket has left bounds the day before the chunk starts.
  const BUDGETS = args.budgetsUsd || {}
  const spentOf = t => summarize(readJournal(journalPath(ROOT, t))).costUsd
  const dayCapAllows = async (chunk, notStarted) => {
    if (typeof BUDGETS.day !== 'number') return true
    const spent = [TICKET, ...WAVES.flat().map(e => e.ticket)].reduce((n, t) => n + spentOf(t), 0)
    const reserve = typeof BUDGETS.run === 'number' ? chunk.reduce((n, e) => n + Math.max(0, BUDGETS.run - spentOf(e.ticket)), 0) : 0
    if (spent + reserve <= BUDGETS.day) return true
    const money = n => `$${n.toFixed(2)}`
    c.status = 'parked'
    c.reason = `budget-exhausted: spent ${money(spent)} + run caps left for ${chunk.map(e => e.ticket).join(', ')} ${money(reserve)} > day cap ${money(BUDGETS.day)}`
    await c.decide({ kind: 'budget-exhausted', blocks: notStarted.join(', '),
      question: `The day stopped before ${notStarted.join(', ')}: the next chunk could pass the day cap of ${money(BUDGETS.day)}. Raise the cap and resume the day, or leave the rest for another day?`,
      why: c.reason.replace(/^budget-exhausted: /, ''),
      options: ['raise budgetsUsd.day and resume the day', 'leave the rest of the queue for another day'],
      recommendation: 'leave the rest of the queue for another day', reversalCost: 'low: a resumed day skips finished tickets' })
    c.log(c.reason)
    return false
  }

  const phaseOutput = async (ticket, ph) => {
    const r = await c.state(['phase-get', ticket, ph], `phase-get-${ph}`)
    return r.status === 'ok' && r.found ? (r.output || {}) : null
  }

  const runChild = async entry => {
    const t = entry.ticket
    const done = await phaseOutput(t, 'logs')
    if (done) return { ticket: t, status: done.status || 'done', prUrl: done.prUrl || null, skipped: true }
    if (await phaseOutput(t, 'start')) {
      const r = await c.escalate(null, { mandate: 'resume-run', what: `resume ${t} from its last checkpoint` })
      if (!r.ok) {
        await c.decide({ ticket: t, kind: 'run-died', question: `${t} stopped mid-run and the owner proxy did not resume it (${r.reason}). Resume it, or hand it back?`,
          why: `resume-run: ${r.route}`, blocks: t, options: ['resume it from its last checkpoint', 'hand it back to the manual queue'],
          recommendation: 'resume it from its last checkpoint', reversalCost: 'low: checkpoints are kept either way' })
        return { ticket: t, status: 'parked', reason: 'resume-run not granted' }
      }
    }
    const r = await launch(entry, { ...CHILD_BASE, ...entry, driver: 'node' })
    return r ? { ticket: t, status: r.status, reason: r.reason, prUrl: r.prUrl, headSha: r.headSha, decisions: r.decisions || [] } : { ticket: t, status: 'died', reason: 'child returned nothing' }
  }

  // Children start in queue order, each after its predecessor's start, so the order of launches is a
  // function of the queue and not of scheduling.
  const runChunk = async chunk => {
    let prev = Promise.resolve()
    const ps = chunk.map(entry => {
      const mine = prev
      let started
      prev = new Promise(res => { started = res })
      return mine.then(() => {
        const p = runChild(entry)
        started()
        return p
      }).catch(e => ({ ticket: entry.ticket, status: 'died', reason: clip(e && e.message ? e.message : e, 300) }))
    })
    const rs = await Promise.all(ps)
    if (c.pendingStop) throw c.pendingStop
    return rs
  }

  const waves = async () => {
    c.cur = 'waves'
    for (let w = 0; w < WAVES.length; w++) {
      const wave = WAVES[w]
      if (w > 0) {
        const fresh = []
        for (const e of wave) if (!(await phaseOutput(e.ticket, 'start'))) fresh.push(e.ticket)
        if (fresh.length) {
          const r = await c.escalate(null, { mandate: 'start-next-ticket', what: `start wave ${w + 1}: ${fresh.join(', ')}` })
          if (!r.ok) {
            await c.decide({ kind: 'question', question: `Wave ${w + 1} (${fresh.join(', ')}) waits: the owner proxy did not start it (${r.reason}). Start it, or stop the day here?`,
              why: `start-next-ticket: ${r.route}`, blocks: fresh.join(', '), options: [`start wave ${w + 1}`, 'stop the day here'],
              recommendation: `start wave ${w + 1}`, reversalCost: 'low: nothing has started' })
            c.status = 'parked'
            c.reason = `wave ${w + 1} not started: ${r.reason}`
            return
          }
        }
      }
      for (let i = 0; i < wave.length; i += MAXP) {
        const chunk = wave.slice(i, i + MAXP)
        const rest = [...wave.slice(i), ...WAVES.slice(w + 1).flat()].map(e => e.ticket)
        if (!(await ceilingAllows(rest))) return
        if (!(await dayCapAllows(chunk, rest))) return
        c.log(`wave ${w + 1}/${WAVES.length}: ${chunk.map(e => e.ticket).join(', ')}`)
        for (const r of await runChunk(chunk)) {
          results.push(r)
          if (r.status === 'died') {
            await c.decide({ ticket: r.ticket, kind: 'run-died', question: `${r.ticket} ended without a result (${r.reason}). Resume it, or hand it back?`,
              why: clip(r.reason, 300), blocks: r.ticket, options: ['resume it from its last checkpoint', 'hand it back to the manual queue'],
              recommendation: 'resume it from its last checkpoint', reversalCost: 'low: checkpoints are kept either way' })
          }
          c.log(`${r.ticket}: ${r.status}${r.skipped ? ' (finished earlier)' : ''}`)
        }
        save()
        const paused = results.find(r => r.status === 'paused-usage')
        if (paused) throw c.stop('paused-usage', `${paused.ticket} hit a usage limit`)
      }
    }
  }

  const sweepPhase = async () => {
    const REPO = c.REPO_PATH
    if (!REPO) return
    c.cur = 'sweep'
    const merged = results.filter(r => r.status === 'merged' && !r.skipped).map(r => r.ticket)
    const base = await c.harness(['base-head', '--cwd', REPO, '--base', c.BASE, '--root', ROOT], 'base-head')
    if (base.status !== 'ok') { c.log(`sweep skipped: base head unreadable (${base.reason || base.status})`); return }
    if (!base.headSha || base.headSha === base.lastSweepSha) return
    sweep = await lane('sweep-summary',
      `${c.UNATTENDED()}\n\nDay ${DATE}, profile ${F.profilePath}. ${c.BASE} is at ${base.headSha}` +
      `${base.lastSweepSha ? `, last swept at ${base.lastSweepSha}` : ''}. Merged by today's runs: ${merged.join(', ') || 'none'}; ` +
      'other merges may have landed outside them. Per-ticket QA already ran; ' +
      'this sweep looks only for interactions between the changes. Read the profile sections "## environments" and "## test toolchain": ' +
      'confirm the environment serves a SHA that contains every merge, then run the full oracle set they name. A regression ' +
      'is reported with the SHA, the steps and the evidence; nothing is filed anywhere.\n\n' +
      `${c.RESULT_CONTRACT}`, 'regressions')
    for (const g of (sweep && sweep.regressions) || [])
      await c.decide({ kind: 'question', question: `Regression after today's merges: ${clip(g, 600)}`, why: 'day sweep', blocks: 'the next day run',
        options: ['open a fix ticket for it', 'revert the merge that caused it'], recommendation: 'open a fix ticket for it', reversalCost: 'low: nothing changed yet' })
    if (sweep) await c.harness(['write', '--file', `${ROOT}/sweep-sha`, '--text', base.headSha], 'sweep-mark')
  }

  const logsPhase = async () => {
    c.cur = 'logs'
    const open = await c.state(['open-count'], 'open-count')
    const ready = results.filter(r => r.status === 'ready-to-sign').map(r => `${r.ticket} ${r.prUrl || ''}`.trim())
    const prose = await lane('log-prose',
      `Write a short impersonal summary of day run ${DATE}: status ${c.status}${c.reason ? ` (${c.reason})` : ''}; per ticket ` +
      `${results.map(r => `${r.ticket} ${r.status}`).join(', ') || 'none'}; ready to sign: ${ready.join(', ') || 'none'}; ` +
      `open decisions ${open.open === undefined ? '?' : open.open} of ceiling ${CEILING}; sweep regressions ` +
      `${sweep ? (sweep.regressions || []).length : 'not run'}. No names, no first person. ${c.RESULT_CONTRACT}`, 'summary')
    summary = prose ? clip(prose.text, 1200) : null
    await c.harness(['write', '--file', `${ROOT}/day-summary.md`, '--text', `# Day ${DATE}\n\n${summary || c.status}\n`], 'write-summary')
    if (['done', 'ceiling', 'parked'].includes(c.status)) await c.state(['handoff', '--done'], 'handoff-done')
  }

  // A Stop ends the phase it was thrown in; anything else is a crash of the day driver.
  const guarded = async fn => {
    try { await fn() } catch (e) {
      if (!(e instanceof Stop)) throw e
      c.status = e.status
      c.reason = e.reason
    }
  }

  try {
    await guarded(waves)
    if (c.status === 'running') c.status = 'done'
    if (c.status !== 'paused-usage') await guarded(sweepPhase)
    if (c.status !== 'paused-usage') await logsPhase()
  } catch (e) {
    ctl.die(`${e && e.name ? `${e.name}: ` : ''}${e && e.message ? e.message : e}`)
    return { result: snapshot(), fatal: e }
  }
  ended = true
  save()
  release(ROOT, 'day', token)
  return { result: snapshot(), fatal: null }
}

async function cli(argv) {
  const emit = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exitCode = code }
  const i = argv.indexOf('--args')
  const file = i >= 0 ? argv[i + 1] : undefined
  if (!file || file.startsWith('--')) return emit(4, { status: 'refused', kind: 'policy', reason: 'usage: day.mjs --args <args-day.json>' })
  let args
  try { args = JSON.parse(readFileSync(resolve(file), 'utf8')) } catch (e) { return emit(4, { status: 'refused', kind: 'policy', reason: clip(e.message, 300) }) }
  if (args && args.stateRoot) process.env.STATE_ROOT = args.stateRoot

  const ctl = { children: new Set() }
  const killChildren = () => { for (const p of ctl.children) { try { process.kill(-p.pid, 'SIGTERM') } catch {} } }
  const lastWords = (why, code) => {
    killChildren()
    if (ctl.die) ctl.die(why)
    emit(code, { status: 'error', kind: 'script-error', dayStatus: 'died', reason: clip(why, 600), record: args.stateRoot ? join(args.stateRoot, 'day-result.json') : null })
    process.exit(code)
  }
  const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
  for (const [sig, n] of Object.entries(SIGNALS)) process.on(sig, () => lastWords(`killed by ${sig}`, 128 + n))
  process.on('uncaughtException', e => lastWords(`uncaught ${e && e.stack ? e.stack.split('\n')[0] : e}`, 1))
  process.on('unhandledRejection', e => lastWords(`unhandled rejection ${e && e.message ? e.message : e}`, 1))

  const { result, fatal } = await driveDay(args, { exec: realRuntime.exec, lane: realRuntime.lane, pool: realRuntime.pool }, ctl)
  if (result.status === 'refused') return emit(4, { status: 'refused', kind: 'policy', reason: result.reason })
  const line = { dayStatus: result.status, reason: result.reason, results: result.results.map(r => ({ ticket: r.ticket, status: r.status })),
    record: join(args.stateRoot, 'day-result.json'), journal: result.journal }
  if (fatal) return emit(1, { status: 'error', kind: 'script-error', ...line })
  emit(0, { status: 'ok', ...line })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli(process.argv.slice(2))
