// Run context of the Node driver: the args, the prompt sections, and the plumbing every phase uses
// (lane retry/escalation, decisions, the deferred state batch, counters, checkpoints, Stop, fan-out).
// Side effects go through `runtime` (exec, lane, pool) and every one of them through the step log.
import { basename } from 'node:path'
import { withBackoff, realSleep } from '../resilience/with-backoff.mjs'
import { authorityOf } from '../gates/evaluate.mjs'
import { runChain } from '../escalation/route.mjs'
import { route as routeLane } from '../routing/route.mjs'
import { nextCandidate } from '../routing/ladder.mjs'
import { routeRecord } from '../routing/record.mjs'
import { awaitingRules, triageWithDenials } from '../contract/awaiting.mjs'
import { parseScriptResult, pool as defaultPool } from './runtime.mjs'
import { captureLaneInput } from './lane-input.mjs'
import { lint } from '../hitl/lint.mjs'
import { fromDecision, decisionFields, violationLines } from '../hitl/request.mjs'
import { ZERO_USAGE, appendJournal, execLine, journalPath, laneLine } from './journal.mjs'
import { overturnLine, verdictId, verdictLine, verdictsPath } from '../journal/verdicts.mjs'

export const PHASES = ['start', 'premise', 'plan', 'implement', 'review', 'pr', 'ci', 'review-bot', 'confidence', 'gate', 'merge', 'qa', 'cleanup', 'logs']
const SEVERE = ['blocker', 'high']
const HARNESS_SOURCES = ['harness', 'verify-claim', 'exec', 'toolchain']
// calls[] becomes journal result lines (docs/harness.md, "Journal"): outcome in the phase-spend
// vocabulary, the raw outcome kept as detail, escalatedFrom as the failed attempt's model.
const OUTCOME = { ok: 'ok', pending: 'ok', refused: 'ok', error: 'ok', blocked: 'ok', schema: 'invalid', 'harness-blocked': 'harness-blocked' }

export class Stop {
  constructor(status, reason) { this.status = status; this.reason = reason }
}

export const clip = (s, n = 400) => String(s || '').slice(0, n)

// A readable reason for anything thrown: String() of a Stop or a plain object is "[object Object]".
export function reasonOf(e) {
  if (e instanceof Stop) return `${e.status}: ${e.reason}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (e && typeof e === 'object') { try { return JSON.stringify(e) } catch { return Object.prototype.toString.call(e) } }
  return String(e)
}

class Died extends Error {}

export function createContext(rawArgs, runtime) {
  const ARGS = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
  for (const k of ['facts', 'ticket', 'date', 'stateRoot', 'harnessBin', 'lib', 'routing', 'router', 'schemas', 'caps', 'tiers'])
    if (!ARGS || ARGS[k] === undefined || ARGS[k] === null) throw new Error(`args.${k} is required; build args with bin/harness.mjs args`)

  const F = ARGS.facts
  const TICKET = ARGS.ticket
  const ROOT = ARGS.stateRoot
  const H = ARGS.harnessBin
  const LIB = ARGS.lib
  const CAPS = ARGS.caps
  const ROUTING = ARGS.routing
  const SCHEMAS = ARGS.schemas
  const TIERS = ARGS.tiers
  const BUDGETS = ARGS.budgetsUsd || {}
  const ROUTER = ARGS.router
  const PRIMARY = (F.repos || [])[0] || {}
  const NOTES = Array.isArray(ARGS.notes) ? ARGS.notes.filter(Boolean) : []
  const AGENTS = ARGS.agents || {}
  const AWAITING = ARGS.awaiting || awaitingRules()
  if (!Array.isArray(ARGS.disallowedTools)) throw new Error('args.disallowedTools is required; build args with bin/harness.mjs args')
  const DISALLOWED = ARGS.disallowedTools
  const log = runtime.log || (m => process.stderr.write(`${m}\n`))
  const sleep = runtime.sleep || realSleep
  const fanPool = (runtime.pool || defaultPool)(ARGS.concurrency || 3)
  const JOURNAL = journalPath(ROOT, TICKET)
  const VERDICTS = verdictsPath(ROOT, TICKET)
  const laneOf = new WeakMap()

  const c = {
    args: ARGS, runtime, F, TICKET, DATE: ARGS.date, ROOT, H, LIB, CAPS, ROUTING, SCHEMAS, TIERS, PRIMARY,
    REPO_PATH: ARGS.repoPath || PRIMARY.path,
    REPO_SLUG: ARGS.repoSlug || PRIMARY.repo,
    BASE: ARGS.base || String(PRIMARY.main || 'main').split(/[\s,]+/)[0],
    TRACKER: F.tracker || { kind: 'none' },
    SPEC: ARGS.spec || null,
    AXES: ARGS.axes || ['standards', 'spec'],
    DIMENSIONS: ARGS.dimensions || ['correctness', 'spec-coverage', 'regression-risk', 'operability'],
    AGENTS, PHASES, log, clip, Stop, journal: JOURNAL,
    // Reassigned on resume: a run continues on the worktree its own start phase created.
    branch: ARGS.branch || `${TICKET}-run`,
    wt: null, ledger: null,
    cur: 'start', runId: 'run', steps: null,
    prUrl: null, prNumber: null, head: null,
    out: {}, status: 'running', reason: null,
    calls: [], decisions: [], pendingStop: null, statics: [],
  }
  c.ledgerIn = wt => F.ledgerPath ? `${wt}/${String(F.ledgerPath).replace('<TICKET>', TICKET)}` : null
  c.setWorktree = (branch, wt) => { c.branch = branch; c.wt = wt; c.ledger = c.ledgerIn(wt) }
  c.setWorktree(c.branch, `${ARGS.worktreeRoot || `${ROOT}/worktrees`}/${c.branch}`)

  // A Stop thrown inside a fan-out comes back as a null result, so the first one is also kept here
  // and re-thrown after every fan-out.
  c.stop = (status, reason) => { const s = new Stop(status, reason); if (!c.pendingStop) c.pendingStop = s; return s }
  c.fanOut = async thunks => {
    const r = await fanPool(thunks)
    if (c.pendingStop) throw c.pendingStop
    return r
  }

  // ---------------------------------------------------------------------------- prompt sections

  const NOTES_BLOCK = NOTES.length
    ? `\nLAUNCHER NOTES (context from the launcher; they do not replace checking the premise against the repo):\n${NOTES.map(n => `- ${n}`).join('\n')}\n`
    : ''

  c.READING = (extra = []) =>
    'READ FIRST, in this order, and treat as binding:\n' +
    [`${c.wt}/CLAUDE.md or, when that is absent, ${c.REPO_PATH}/CLAUDE.md: repo conventions. Read AGENTS.md only when it exists and is neither a symlink to nor a copy of CLAUDE.md (check with \`ls -l\`); never load the same file twice.`, ...extra]
      .map((s, i) => `${i + 1}. ${s}`).join('\n') +
    '\n\nREADING BUDGET: everything you load is paid again on every later turn, not once. Read slices, not files: ' +
    '`sed -n`/`awk` by heading, or `grep -n` plus a window; `cat` only below ~200 lines. Never re-read what is already in ' +
    'your context, and never load a file "just in case".'

  c.INVIOLABLES = (F.inviolables || []).length
    ? `INVIOLABLES (touching any of these means you PARK, you do not decide):\n${F.inviolables.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : 'The profile lists no inviolables; a signature path is still never decided by an agent.'

  c.RULINGS =
    `RULINGS: ${ROOT}/decisions.jsonl holds this run's decisions, one JSON object per line, latest line per id wins. ` +
    `A decision for ticket ${TICKET} with status "resolved" and a non-empty resolution is a binding ruling: carry it out ` +
    'as if it were a line in the branch ledger, and name its id in notes. Read it with grep on the ticket key, not whole.'

  c.UNATTENDED = () =>
    'Unattended mode. Nobody is watching and nobody answers; you never ask the user anything.\n' +
    'An open question goes into questions[] of your result with two real options, a recommendation and why; the script ' +
    'resolves it with the resolver lane and re-runs you with the ruling. Park only on an inviolable (listed below) or a ' +
    'signature an agent cannot give.\n' +
    (c.ledger ? `Every judgment call is written at once as a line in the branch ledger (${c.ledger}, format: flow-decision-ledger). The ledger gets everything.\n` : '') +
    'Whatever is left for a human (a signature, a harness block, a contradiction in the spec, a choice that changes a ' +
    'rule beyond this branch) goes into awaiting[] as a full item: kind, question, options, recommendation, why, ' +
    'reversalCost, blocks. Return it the moment you know it, not at the end; the script records it as an open decision, ' +
    'and an item missing from awaiting[] does not exist for the open-decision count. A refused tool call goes into ' +
    'awaiting[] with kind "harness-blocked" and the literal refusal text as why, and nothing else. A missing file, a ' +
    'failing command or a sandboxed spawn is not a refused tool call and is never filed as harness-blocked.\n' +
    'The opposite mistake costs as much: an item handed over out of caution rather than for want of a signature spends ' +
    'the day ceiling and stops waves that could have run. "Ask the owner", "owner decides" and "wait" are not ' +
    'recommendations; if that is all you can write, it belongs in questions[].\n' +
    `${c.RULINGS}\n\n${c.INVIOLABLES}`

  c.RESULT_CONTRACT = 'Your final text IS the result. Do not send it anywhere; there is no recipient.'

  c.NO_DISPATCH =
    'You have no Agent/Task tool: you are ONE of several agents of this phase, fanned out by the driver ' +
    '(nesting is one level deep). Do not try to dispatch anyone; your slice is your whole job and you may not do ' +
    "another's. If a skill brief says to dispatch, that step was already done by the script: skip it and do only your " +
    'slice. An open question goes into questions[].'

  c.taskBrief = (task, extra = []) =>
    `${c.READING(extra)}\n\n${c.UNATTENDED()}\n${NOTES_BLOCK}\nTicket ${TICKET}. Worktree ${c.wt} on branch ${c.branch}, base ${c.BASE}.\n\n` +
    `TASK: ${task}\n\n${c.RESULT_CONTRACT}`

  c.reviewBotPredicate = gate =>
    `REVIEW-BOT PREDICATE for gate "${gate.name}" (the only source; do not re-derive the rule):\n` +
    `- Pass: ${gate.pass}\n` +
    `- Not a review: a check or status named after the bot, of any colour; a review on any commit other than the head` +
    ((gate.skipPatterns || []).length ? `; a review whose body matches ${gate.skipPatterns.map(p => `"${p}"`).join(', ')}` : '') + '.\n' +
    '- Whether the gate is green is decided by lib/forge/review-bot-green.mjs, not by you. Your job is the threads: ' +
    'every bot thread answered by a fix commit or a reasoned rebuttal quoting the code.'

  c.ticketSource = () =>
    c.SPEC
      ? `The ticket is the spec file ${c.SPEC.path}; read it from there.`
      : `Read ticket ${TICKET} from the ${c.TRACKER.kind} tracker (site ${c.TRACKER.site || 'as configured'}).`

  // ---------------------------------------------------------------------------- calls

  const label = (lane, tier, detail) => `${c.cur}:${lane}:${tier}${detail ? `:${detail}` : ''}`
  c.label = label
  const tierOf = (model, fallback) => Object.keys(TIERS).find(t => TIERS[t] === model) || fallback
  const journal = line => appendJournal(JOURNAL, { ...line, runId: c.runId })
  c.journalLine = journal
  // Before resume has named the run there is no step log yet; those calls run live.
  const stepOr = (name, input, fn, opts) => c.steps ? c.steps.step(name, input, fn, opts) : fn()
  c.withScope = (scope, fn) => c.steps ? c.steps.withScope(scope, fn) : fn()

  const pushCall = co => c.calls.push({ label: co.label, outcome: OUTCOME[co.outcome] || 'error', detail: co.outcome,
    escalatedFrom: co.escalatedFrom ? (TIERS[co.escalatedFrom] || co.escalatedFrom) : null, ...(co.why ? { why: co.why } : {}) })

  // One lib script or harness subcommand, run from an argv array. Result = the script-result line
  // plus the exit code.
  async function execStep(argv, detail, { backoff = false, volatile = false, journaled = true } = {}) {
    const target = argv[1] === H ? argv[2] : basename(argv[1])
    const lbl = `${c.cur}:exec:${detail}`
    let spent = null
    const live = async () => {
      const started = Date.now()
      const call = async () => {
        const r = await runtime.exec(argv, { env: { STATE_ROOT: ROOT }, label: lbl })
        return { result: parseScriptResult(r.stdout, argv[1] === H ? `harness ${argv[2]}` : argv[1]), exitCode: r.exitCode }
      }
      const out = backoff ? await withBackoff(call, { sleep }) : await call()
      spent = Date.now() - started
      return { result: out.result, exitCode: out.exitCode }
    }
    const rec = await stepOr(`exec:${detail}`, argv.slice(1), live, { volatile })
    if (journaled) journal(execLine({ phase: c.cur, label: lbl, script: target, exitCode: rec.exitCode, durationMs: spent || 0, replayed: spent === null }))
    return { ...rec.result, exitCode: rec.exitCode }
  }
  c.execStep = execStep

  // A lib script under STATE_ROOT, with the backoff `harness run` used to add.
  c.run = (script, argv, detail) =>
    execStep([process.execPath, `${LIB}/${script}`, ...argv], detail || script.split('/').pop().replace('.mjs', ''), { backoff: true })
  c.harness = (argv, detail, opts) => execStep([process.execPath, H, ...argv], detail, opts)

  // Writes nothing waits on ride with the next state call, one script call for the lot instead of one each.
  const pending = []
  const decideSeq = {}
  c.defer = argv => { pending.push(argv) }

  c.state = async (argv, detail) => {
    if (!pending.length) return c.run('state/state.mjs', argv, detail || `state-${argv[0]}`)
    const ops = pending.splice(0)
    const all = argv ? [...ops, argv] : ops
    const r = await c.run('state/state.mjs', ['batch', JSON.stringify(all)], detail || `state-${(argv || ops.at(-1))[0]}`)
    const answers = [...(r.batch || []), ...(r.status === 'ok' ? [r] : [])]
    ops.forEach((op, i) => {
      if (op[0] !== 'decide') return
      const id = answers[i] && answers[i].id
      if (id && !c.decisions.includes(id)) c.decisions.push(id)
      else if (!id) log(`${TICKET}: decision not recorded (${r.reason || r.kind}): ${clip(JSON.parse(op[1]).question, 120)}`)
    })
    return r
  }
  c.flush = () => pending.length ? c.state(null, 'state-flush') : null

  // Never counted toward the ceiling, never offered as a choice: it parks with the blocking rule named.
  c.harnessBlocked = async (denial, what) => {
    const d = { ticket: TICKET, kind: 'harness-blocked', question: `harness refused: ${clip(what, 200)}`, why: clip(denial), blocks: `${TICKET} ${c.cur}` }
    const r = await c.run('state/state.mjs', ['decide', JSON.stringify(d)], 'state-decide')
    if (r.status === 'ok') c.decisions.push(r.id)
    throw c.stop('parked', `harness-blocked: ${clip(denial, 200)}`)
  }

  // Environment notes and refusals from lanes that still finished. They never park; they travel to
  // the PR body and the gate's environment condition, and are checkpointed with their phase.
  c.notes = []
  c.note = (lane, items, refusal) => {
    for (const a of items) c.notes.push({ phase: c.cur, lane, refusal, question: clip(a.question, 300), why: clip(a.why, 500) })
  }
  c.noteLines = () => c.notes.map(n => `- ${n.refusal ? '**refused tool call** ' : ''}[${n.lane}] ${n.question}: ${n.why}`).join('\n')
  c.environmentCondition = () => {
    const refused = c.notes.filter(n => n.refusal)
    return { name: 'environment', state: refused.length ? 'blocked' : 'green', source: 'runner',
      evidence: refused.length ? refused.map(n => `${n.lane}: ${n.why}`).join('; ')
        : c.notes.length ? `${c.notes.length} note(s) in the PR body` : 'no environment note' }
  }

  // Anything put to a person is linted as a hitl-request. A request that fails gets one repair round when the
  // caller offers a hook; otherwise it is recorded with the broken rules listed, never padded into a readable shape.
  c.decide = async ({ kind, question, why, blocks, options, recommendation, reversalCost, ledger = c.ledger, request, repair }) => {
    decideSeq[c.cur] = (decideSeq[c.cur] || 0) + 1
    const key = `${c.cur}:${decideSeq[c.cur]}`
    const d = { ticket: TICKET, kind, key, blocks: clip(blocks || `${TICKET} ${c.cur}`, 300) }
    const legacy = () => {
      d.question = clip(question ?? (request && request.ask) ?? '', 1000)
      d.why = clip(why ?? (request && request.situation) ?? '', 1000)
      if (options && options.length) d.options = options.map(o => clip(o, 300))
      if (recommendation) d.recommendation = clip(recommendation, 300)
      if (reversalCost) d.reversalCost = clip(reversalCost, 300)
    }
    let result = { ok: true, violations: [] }
    if (kind === 'harness-blocked') legacy()
    else {
      const target = ledger ? 'ledger' : 'chat'
      let candidate = request || fromDecision({ ticket: TICKET, kind, key, question, why, options, recommendation, reversalCost })
      let res = lint(candidate, { target })
      if (!res.ok && repair) {
        const repaired = await repair(res.violations, candidate).catch(e => (log(`${TICKET}: repair of ${key} failed: ${clip(e.message, 200)}`), null))
        if (repaired) { candidate = repaired; res = lint(candidate, { target }) }
      }
      result = { ok: res.ok, violations: res.violations }
      if (res.ok) Object.assign(d, decisionFields(candidate), { request: candidate })
      else {
        legacy()
        d.violations = violationLines(res.violations).map(v => clip(v, 300))
        log(`${TICKET}: decision ${key} is unreadable to a person (${[...new Set(res.violations.map(v => v.rule))].join(', ')}); recorded with its violations, not padded`)
      }
    }
    const argv = ['decide', JSON.stringify(d)]
    if (ledger) argv.push('--ledger', ledger)
    c.defer(argv)
    return result
  }

  const incSeq = {}
  const incKey = () => { incSeq[c.cur] = (incSeq[c.cur] || 0) + 1; return `${c.runId}:${c.cur}:${incSeq[c.cur]}` }
  c.incKey = incKey

  c.counter = async (name, inc) => {
    const r = await c.state(['counter', TICKET, name, ...(inc ? ['--inc', '--key', incKey()] : [])], `counter-${name}`)
    const cap = CAPS[name] !== undefined ? CAPS[name] : r.cap
    return { value: r.value, cap, capReached: r.value >= cap }
  }

  c.pauseForUsage = async retryAfter => {
    await c.state(retryAfter ? ['handoff', '--pause', retryAfter] : ['handoff', `paused-usage: ${TICKET}, reset time unknown`])
    await c.state(['set-status', TICKET, 'paused-usage'])
    throw c.stop('paused-usage', `usage limit${retryAfter ? ` until ${retryAfter}` : ''}`)
  }

  c.classify = async text => {
    const r = await c.harness(['classify', '--text', clip(text, 2000)], 'classify')
    return r.status === 'ok' ? null : r
  }

  // One `claude -p` call through the step log. A dead agent (no result) writes nothing, like a throw.
  async function callLane(name, prompt, lbl, tier, model, agentType, rt = 'claude') {
    const route = ROUTING[name]
    const budgetUsd = route.budgetUsd ?? BUDGETS[tier]
    const cwd = c.out.start ? c.wt : c.REPO_PATH
    let spend = null
    // The runtime joins the step input only off claude, so step logs written before routing still replay.
    const input = { prompt, model, schema: name, agentType: agentType || null, ...(rt === 'claude' ? {} : { runtime: rt }) }
    try {
      const rec = await stepOr(`lane:${name}`, input, async () => {
        try {
          captureLaneInput(ROOT, { ticket: TICKET, label: lbl, prompt, schema: name, model, runtime: rt, budgetUsd, agentType, cwd, redactList: Array.isArray(F.redact) ? F.redact : [] })
        } catch (e) {
          journal({ kind: 'warning', phase: c.cur, label: lbl, message: `lane input not captured: ${clip(String(e.message || e), 300)}` })
        }
        const r = await runtime.lane({ name, label: lbl, prompt, model, schema: SCHEMAS[name], budgetUsd, cwd, agentType, disallowedTools: DISALLOWED, runtime: rt })
        spend = { usage: r.usage, costUsd: r.costUsd, durationMs: r.durationMs, model: r.model, denials: r.denials }
        if (r.result === null || r.result === undefined) throw new Died('lane returned no result')
        return { result: r.result, model: r.model || model }
      })
      return { r: rec.result, spend: spend || { replayed: true, model: rec.model } }
    } catch (e) {
      e.spend = spend || { usage: e.usage, costUsd: e.costUsd, durationMs: e.durationMs, model: e.model, denials: e.denials }
      throw e
    }
  }

  const record = (lbl, name, model, outcome, escalatedFrom, spend = {}, route) => {
    pushCall({ label: lbl, outcome, escalatedFrom })
    journal({ ...laneLine({ phase: c.cur, label: lbl, lane: name, model: spend.model || model, outcome,
      durationMs: spend.durationMs || 0, costUsd: spend.costUsd || 0, usage: spend.usage || ZERO_USAGE, replayed: !!spend.replayed }), route })
  }

  // The candidates for one lane, with the launch-resolved model (tier routing or a profile override)
  // first when it is still eligible.
  const routeFor = name => {
    const r = routeLane(name, ROUTER.catalogue, ROUTER.lanes, ROUTER.state)
    if (r.park) throw c.stop('parked', `no model can run lane "${name}" (${r.park}): ${r.rejected.map(x => `${x.model} ${x.why}`).join(', ')}`)
    const want = ROUTING[name].model
    const i = r.candidates.findIndex(x => x.model === want)
    return i > 0 ? { ...r, candidates: [r.candidates[i], ...r.candidates.slice(0, i), ...r.candidates.slice(i + 1)] } : r
  }

  // A judgment lane. Candidates from route(); a death or a harness block retried once identically,
  // a failed or unusable result walked down the ladder (nextCandidate), backoff on rate limits, a
  // pause on usage limits, and the result's awaiting[]/questions[] turned into decisions and rulings.
  c.lane = async (name, prompt, detail, opts = {}) => {
    if (!ROUTING[name]) throw new Error(`no routing for lane "${name}"`)
    const R = routeFor(name)
    let model = R.candidates[0].model
    let step = null
    let ladder
    let escalatedFrom = null
    let rateLimited = 0
    let rulings = ''
    let schemaError = ''
    let resolverRound = 0
    const climb = (kind, error) => {
      const n = nextCandidate(R, { kind, model, ladder, error })
      ladder = n.ladder
      if (n.action === 'park') return n
      step = n
      if (n.escalatedFrom) escalatedFrom = n.escalatedFrom
      model = n.model
      schemaError = n.appendError ? `\n\nYOUR PREVIOUS RESULT WAS REJECTED (${clip(n.appendError, 500)}); return a result that fits the schema.` : ''
      return n
    }
    for (;;) {
      const cand = R.candidates.find(x => x.model === model)
      const tier = tierOf(model, ROUTING[name].tier)
      const lbl = label(name, tier, detail)
      const rec = routeRecord(R, step)
      const done = (outcome, spend) => record(lbl, name, model, outcome, escalatedFrom, spend, rec)
      let r = null
      let err = null
      let spend
      try {
        ({ r, spend } = await callLane(name, prompt + rulings + schemaError, lbl, tier, model, opts.agentType, cand.runtime))
      } catch (e) { err = e; spend = e.spend }
      let failure = null
      if (err instanceof Died) { done('died', spend); failure = { kind: 'died' } }
      else if (err) {
        const denied = (err.denials || []).map(d => d.text).join('; ')
        const cl = denied ? null : await c.classify(String(err && err.message ? err.message : err))
        const kind = denied ? 'harness-blocked' : cl ? cl.kind : 'script-error'
        done(kind, spend)
        if (kind === 'usage-limit') await c.pauseForUsage(cl.retryAfter)
        const transport = ['rate-limit', 'ci-infra'].includes(kind) || err.exitClass === 'rate_limit'
        failure = kind === 'harness-blocked' ? { kind, why: denied || String(err.message || err) }
          : transport ? { kind: 'transport' }
          : { kind: 'schema', error: err.exitClass === 'schema' ? String(err.message || err) : undefined }
      }
      // A lane that finished its work is never re-run or parked for what it reports about the
      // environment: those items become notes for the PR body and the gate.
      const t = r ? triageWithDenials(name, r, AWAITING, spend && spend.denials) : null
      const finished = !!r && r.ok === true
      if (t && t.refusals.length && !finished) {
        done('harness-blocked', spend)
        failure = { kind: 'harness-blocked', why: t.refusals[0].why }
      } else if (t) {
        c.note(name, t.notes, false)
        c.note(name, t.refusals, true)
        r = { ...r, awaiting: t.decisions }
      }
      if (failure) {
        const n = climb(failure.kind, failure.error)
        // No other candidate to move to: wait on this one, up to the backoff cap.
        if (n.action === 'backoff') {
          if (rateLimited >= CAPS.backoffAttempts) return null
          const s = Math.min(CAPS.backoffFirstSeconds * 2 ** rateLimited, CAPS.backoffMaxSeconds)
          rateLimited += 1
          await c.harness(['sleep', '--seconds', String(s)], 'backoff')
          continue
        }
        if (n.action !== 'park') continue
        if (failure.kind === 'harness-blocked') await c.harnessBlocked(failure.why, lbl)
        return null
      }
      done('ok', spend)
      for (const a of r.awaiting || []) await c.decide({ ...a, kind: ARGS.kinds && ARGS.kinds[a.kind] ? a.kind : 'question' })
      if ((r.questions || []).length && resolverRound < 1 && !opts.noEscalation) {
        resolverRound += 1
        const answers = await c.resolveQuestions(r.questions)
        if (answers.length) {
          rulings = `\n\nRULINGS FROM THE RESOLVER (carry them out, then finish the task):\n${answers.join('\n')}`
          continue
        }
      }
      laneOf.set(r, { model: (spend && spend.model) || model, tier })
      return r
    }
  }

  // The verdict ledger: what a lane asserted, and what later contradicted it (calibration input).
  c.verdict = (r, lane, field, value, detail) => {
    const who = (r && laneOf.get(r)) || {}
    appendJournal(VERDICTS, verdictLine({ runId: c.runId, phase: c.cur, lane, model: who.model, tier: who.tier, field, value, detail }))
  }
  c.overturn = ({ phase, lane, detail, field }, by, source, evidence) =>
    appendJournal(VERDICTS, overturnLine({ runId: c.runId, verdictId: verdictId({ runId: c.runId, phase, lane, detail, field }), by, source, evidence }))

  // Escalation for one open item: resolver, then owner proxy when the ruling needs a mandate, then a
  // human. The profile's own hard-stop channel list is applied here, before a step names a channel.
  const laneForRole = (role, b, rec, step) => c.lane(role,
    `Use the flow-${role} skill. Ticket ${TICKET}, unattended run, phase "${c.cur}". Profile: ${F.profilePath}.\n` +
    (b.question ? `Question: ${b.question}\n` : '') +
    (rec && rec.options ? `Options: ${rec.options.join(' / ')}\n` : '') +
    (rec && rec.recommendation ? `The asking agent recommends: ${rec.recommendation}\n` : '') +
    (rec && rec.why ? `Why: ${rec.why}\n` : '') +
    (b.mandate ? `Mandate step: ${b.mandate}${step && step.what ? ` (${step.what})` : ''}\n` : '') +
    `\n${c.INVIOLABLES}\n\n${c.RULINGS}\n\n${c.RESULT_CONTRACT}`,
    b.mandate || 'question', { agentType: role === 'resolver' ? AGENTS.resolver : AGENTS.ownerProxy, noEscalation: true })

  c.escalate = async (rec, step) => {
    const s = { ...(step || {}) }
    if (s.channel && Array.isArray(ARGS.hardStopChannels) && !ARGS.hardStopChannels.includes(s.channel)) delete s.channel
    const r = await runChain({ facts: F, decision: rec, step: s }, (role, b) => laneForRole(role, b, rec, s))
    if (r.harnessBlock) await c.harnessBlocked(r.harnessBlock.why, r.harnessBlock.question)
    if (r.route === 'decided' || r.route === 'proxied') return { ok: true, route: r.route, ruling: r.record ? r.record.resolution : r.reason }
    if (rec) {
      const { status, ...rest } = rec
      await c.decide({ ...rest, recommendation: (r.record && r.record.recommendation) || rec.recommendation, why: `${rec.why} [${r.reason}]` })
    }
    return { ok: false, route: r.route, reason: r.reason }
  }

  c.resolveQuestions = async questions => {
    const answers = []
    for (const item of questions) {
      const rec = { ticket: TICKET, kind: 'question', status: 'open', question: item.question, why: item.why || 'raised by a lane',
        options: item.options, recommendation: item.recommendation, blocks: `${TICKET} ${c.cur}` }
      const r = await c.escalate(rec)
      if (r.ok) answers.push(`- ${item.question}\n  Ruling: ${r.ruling}`)
    }
    return answers
  }

  c.ownerProxy = async (step, what) => {
    const r = await c.escalate(null, { mandate: step, what })
    return { action: r.ok ? 'act' : 'park', rationale: r.reason || r.ruling }
  }

  c.checkpoint = async (phaseName, output, extra = []) => {
    const own = c.notes.filter(n => n.phase === phaseName)
    const argv = ['phase-done', TICKET, phaseName, JSON.stringify(own.length ? { ...output, laneNotes: own } : output), ...extra]
    if (c.head) argv.push('--head', c.head)
    const r = await c.state(argv, 'checkpoint')
    if (r.status !== 'ok') throw c.stop('parked', `checkpoint ${phaseName} refused: ${r.reason || r.kind}`)
  }

  // ---------------------------------------------------------------------------- findings and conditions

  c.severe = findings => (findings || []).filter(f => SEVERE.includes(f.severity))
  // A finding about the run's own tooling says nothing a fix agent can repair: it is held as blocked
  // for the gate instead of entering a fix round.
  const fromHarness = f => HARNESS_SOURCES.includes(f && f.source)
  c.fromHarness = fromHarness
  c.harnessFindings = []
  c.holdHarness = findings => {
    for (const f of findings) if (fromHarness(f) && !c.harnessFindings.some(x => x.id === f.id)) c.harnessFindings.push({ id: f.id, severity: f.severity, source: f.source, summary: clip(f.summary, 200) })
    return findings.filter(f => !fromHarness(f))
  }
  const condition = name => checks => {
    const blocked = checks.filter(x => x.state === 'blocked')
    const red = checks.filter(x => x.state === 'red')
    return { name, state: blocked.length ? 'blocked' : red.length ? 'red' : 'green', source: 'runner',
      evidence: !checks.length ? 'none declared' : [...blocked.map(x => `${x.check} (${x.kind}): ${x.reason}`), ...red.map(x => `${x.check}: exit ${x.exitCode}`)].join('; ') || checks.map(x => x.check).join(', ') + ' green' }
  }
  c.staticCondition = condition('static-checks')
  // A worktree-setup command that cannot run is `blocked`, same as a static check with no
  // toolchain: never a hard park, the run still reaches CI and review-bot.
  c.setupCondition = condition('worktree-setup')
  c.FIX_GUARD = 'Never edit the plan, the spec or the ticket text to make a finding go away. A finding about the harness ' +
    '(verify-claim, exec, the toolchain) is not yours to fix: list its id in skipped[] and change nothing for it.'
  c.pathOf = loc => String(loc || '').trim().replace(/^\.\//, '').replace(/(:\d+)+$/, '').replace(/#L\d+(-L?\d+)?$/, '')
  // A blocker whose location needs a signature under the profile's merge authority is the only open
  // finding that stops the run before the PR; every other one travels to the PR and the gate.
  c.signatureBlockers = findings => (findings || []).filter(f => f.severity === 'blocker')
    .flatMap(f => (f.locations || []).map(c.pathOf).filter(Boolean).filter(p => authorityOf(p, F.mergeAuthority) !== 'agent'))
  c.findingLines = findings => (findings || []).map(f =>
    `- \`${f.id || 'finding'}\` [${f.severity || 'high'}${f.axis ? `, ${f.axis}` : ''}] ${f.summary}${(f.locations || []).length ? ` — ${f.locations.join(', ')}` : ''}`).join('\n')

  return c
}
