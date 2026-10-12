export const meta = {
  name: 'run-day',
  description: 'An approved queue of tickets run unattended in waves of run-ticket children, under the day ceiling of open decisions, then a regression sweep and a day summary',
  whenToUse: 'Launched by the flow-run-day skill with args built by bin/harness.mjs day-args; never by hand',
  phases: [
    { title: 'waves', detail: 'run-ticket children, max-parallel per chunk, ceiling checked before every chunk' },
    { title: 'sweep', detail: 'cross-ticket regression sweep when the base branch moved' },
    { title: 'logs', detail: 'day summary' },
  ],
}

// ------------------------------------------------------------------------------ input

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
for (const k of ['facts', 'date', 'stateRoot', 'harnessBin', 'lib', 'routing', 'schemas', 'caps', 'tiers', 'waves', 'runTicketScript'])
  if (!ARGS || ARGS[k] === undefined || ARGS[k] === null) throw new Error(`args.${k} is required; build args with bin/harness.mjs day-args`)

const F = ARGS.facts
const DATE = ARGS.date
const ROOT = ARGS.stateRoot
const H = ARGS.harnessBin
const LIB = ARGS.lib
const CAPS = ARGS.caps
const ROUTING = ARGS.routing
const SCHEMAS = ARGS.schemas
const TIERS = ARGS.tiers
const RP = F.runPolicy || {}
const CEILING = RP.dayCeiling
const MAXP = Math.max(1, RP.maxParallel || 1)
// Exclusions narrow the count, never widen it: a kind that does not count toward the ceiling stays out.
const EXCLUDE = (RP.ceilingExclusions || []).filter(k => ARGS.kinds && ARGS.kinds[k] && ARGS.kinds[k].ceiling)
const WAVES = ARGS.waves
const AGENTS = ARGS.agents || {}
const TICKET = `day-${DATE}`
const TIER_ORDER = ['T1', 'T2', 'T3']
// A recorded run: a lane dispatched a subagent despite the no-dispatch
// rule. The built-in workflow-subagent already denies Agent and Workflow by default, but not Task
// (the pre-rename alias for the same tool), so it is named here and passed to every agent() call.
const DISPATCH_DENY = ['Agent', 'Task', 'Workflow']
const { waves: _w, runTicketScript: _s, ...CHILD_BASE } = ARGS
const PRIMARY = (F.repos || [])[0] || {}
const REPO_PATH = ARGS.repoPath || PRIMARY.path
const BASE = ARGS.base || String(PRIMARY.main || 'main').split(/[\s,]+/)[0]

if (!Number.isInteger(CEILING)) throw new Error('facts.runPolicy.dayCeiling is required')
if (!F.dayRunAllowed || !F.ownerProxy) throw new Error('the profile has no owner proxy: an unattended day run is refused')

// ------------------------------------------------------------------------------ prompt sections

const INVIOLABLES = (F.inviolables || []).length
  ? `INVIOLABLES (touching any of these means you PARK, you do not decide):\n${F.inviolables.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
  : 'The profile lists no inviolables; a signature path is still never decided by an agent.'

const RULINGS =
  `RULINGS: ${ROOT}/decisions.jsonl holds this day's decisions, one JSON object per line, latest line per id wins. ` +
  'A decision with status "resolved" and a non-empty resolution is a binding ruling. Read it with grep, not whole.'

const RESULT_CONTRACT = 'Your final text IS the result. Do not send it anywhere; there is no recipient.'

const UNATTENDED =
  'Unattended mode. Nobody is watching and nobody answers; you never ask the user anything. An open question goes ' +
  'into questions[] with two real options, a recommendation and why. Whatever is left for a human goes into ' +
  'awaiting[] as a full item; a refused tool call goes there with kind "harness-blocked" and the literal refusal text. ' +
  'A missing file, a failing command or a sandboxed spawn is not a refused tool call and is never filed as harness-blocked.'

// ------------------------------------------------------------------------------ escalation
// Inlined verbatim from lib/escalation/route.mjs; a test holds the two copies equal.

const NEVER = ['usage-limit', 'rate-limit', 'quota', 'context-exhaustion', 'harness-blocked', 'stop-hour', 'no-progress', 'duplicate']
const SIGN = ['ready-to-sign']
const MANDATES = ['approve-day-queue', 'start-next-ticket', 'approve-peer-step', 'resume-run', 'lift-cap-once', 'undraft-pr']
const ROUTES = ['decided', 'proxied', 'pending', 'parked-human', 'inviolable-park', 'ready-to-sign', 'no-escalation', 'invalid-answer']
const TO_HUMAN = ['parked-human', 'inviolable-park', 'ready-to-sign']

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function isDeclaredInviolable(cited, inviolables = []) {
  const c = norm(cited)
  return c !== '' && inviolables.some(i => norm(i).includes(c))
}

function harnessBlockIn(answers) {
  for (const lane of ['resolver', 'owner-proxy']) {
    const hit = (answers[lane]?.awaiting || []).find(a => a.kind === 'harness-blocked')
    if (hit) return { lane, item: hit }
  }
  return null
}

function stripQuestion(record) {
  if (!record || record.kind !== 'harness-blocked') return record
  const { options, recommendation, reversalCost, ...rest } = record
  return rest
}

function route(input) {
  const { facts = {}, decision = null, step = {}, answers = {} } = input
  const hops = ['resolver', 'owner-proxy'].filter(l => answers[l])
  let record = decision ? { ...decision } : null
  const done = (r, fields = {}) => ({
    route: r, next: null, by: null, reason: '', hops,
    human: TO_HUMAN.includes(r) ? (facts.escalation?.human || null) : null,
    record, ...fields,
  })
  const resolved = (by, resolution) => {
    if (record) record = { ...record, status: 'resolved', resolution, resolvedBy: by }
  }
  const park = (r, reason, recommendation) => {
    if (record && recommendation) record = { ...record, recommendation }
    return done(r, { reason })
  }

  if (record && NEVER.includes(record.kind)) {
    record = stripQuestion(record)
    return done('no-escalation', { reason: `${record.kind} is listed in run state and routed to nobody` })
  }
  if (record && SIGN.includes(record.kind)) return done('ready-to-sign', { reason: 'only a human signature moves it' })

  const block = harnessBlockIn(answers)
  if (block) {
    return done('no-escalation', {
      reason: `${block.lane} hit a harness block; no answer unblocks it`,
      harnessBlock: {
        runId: record?.runId, ticket: record?.ticket, kind: 'harness-blocked', status: 'open',
        question: block.item.question, why: block.item.why, blocks: block.item.blocks,
      },
    })
  }

  if (answers.source?.answer) {
    resolved('source-cascade', answers.source.answer)
    return done('decided', { by: 'source-cascade', reason: `answered from ${answers.source.source || 'sources'}` })
  }

  if (step.authority && step.authority !== 'agent') return done('ready-to-sign', { reason: `hard-stop path: authority ${step.authority}` })
  if (step.foreignPr) return park('parked-human', 'hard-stop path: merging a PR someone else authored')
  if (step.channel) return park('parked-human', `hard-stop channel: ${step.channel}`)

  let mandate = step.mandate || ''
  const res = answers.resolver
  if (!mandate) {
    if (!record) return done('invalid-answer', { reason: 'neither a decision nor a mandate step' })
    if (!res) return done('pending', { next: 'resolver', brief: brief(record, '', facts) })
    if (typeof res.park !== 'boolean') return park('parked-human', 'unreadable resolver answer')
    if (res.inviolable) {
      const declared = isDeclaredInviolable(res.inviolable, facts.inviolables)
      return done('inviolable-park', {
        reason: `inviolable: ${res.inviolable}${declared ? '' : ' (not declared in the profile; parked anyway)'}`,
        record: record && res.decision ? { ...record, recommendation: res.decision } : record,
      })
    }
    if (res.park) return park('parked-human', `resolver parked: ${res.rationale}`, res.decision)
    const doubt = res.doubt ? { ...res.doubt, log: facts.escalation?.doubtLog || null } : undefined
    if (!res.mandate) {
      resolved('resolver', res.decision)
      return done('decided', { by: 'resolver', reason: res.rationale, doubt })
    }
    mandate = res.mandate
  }

  if (!MANDATES.includes(mandate)) return park('parked-human', `not-in-mandate: "${mandate}" is outside the mandate vocabulary`)
  const proxy = facts.ownerProxy
  if (!proxy) return park('parked-human', 'no-proxy: the profile declares no owner proxy', res?.decision)
  if (!(proxy.mandate || []).includes(mandate)) return park('parked-human', `not-in-mandate: ${mandate}`, res?.decision)

  const act = answers['owner-proxy']
  if (!act) return done('pending', { next: 'owner-proxy', brief: brief(record, mandate, facts, step) })
  if (act.action !== 'act') return park('parked-human', `owner proxy parked: ${act.parkReason || 'no reason'} — ${act.rationale}`, res?.decision)
  if (act.mandate !== mandate) return park('parked-human', `owner proxy acted on "${act.mandate}", asked for "${mandate}"`)
  const unmet = (act.conditions || []).filter(c => c.met !== true)
  if (unmet.length) return park('parked-human', `condition-unmet: ${unmet.map(c => c.condition).join('; ')}`)
  resolved('owner-proxy', `${act.step} — ${act.rationale} — reversal: ${act.reversalCost}`)
  return done('proxied', { by: 'owner-proxy', reason: `mandate ${mandate}` })
}

function brief(record, mandate, facts, step = {}) {
  return {
    decisionId: record?.id || null,
    question: record?.question || step.what || null,
    mandate: mandate || null,
    profilePath: facts.profilePath || null,
  }
}

// Drives route() to a terminal answer. callLane(lane, brief) returns that lane's output.
async function runChain(input, callLane, maxHops = 3) {
  let cur = { ...input, answers: { ...(input.answers || {}) } }
  for (let i = 0; i <= maxHops; i++) {
    const r = route(cur)
    if (r.route !== 'pending') return r
    cur = { ...cur, answers: { ...cur.answers, [r.next]: await callLane(r.next, r.brief) } }
  }
  return { ...route(cur), route: 'parked-human', reason: 'escalation did not settle within its hops' }
}

// ------------------------------------------------------------------------------ awaiting triage
// Inlined verbatim from lib/contract/awaiting.mjs; a test holds the two copies equal.

function isQuotedRefusal(text, rules) {
  const s = String(text || '')
  return ((rules && rules.refusals) || []).some(p => new RegExp(p, 'i').test(s))
}

function triageAwaiting(lane, result, rules) {
  const out = { decisions: [], refusals: [], notes: [] }
  const prose = ((rules && rules.prose) || []).includes(lane)
  for (const a of (result && result.awaiting) || []) {
    if (prose) out.notes.push(a)
    else if (a.kind !== 'harness-blocked') out.decisions.push(a)
    else if (isQuotedRefusal(a.why, rules)) out.refusals.push(a)
    else out.notes.push(a)
  }
  return out
}

const AWAITING = ARGS.awaiting || { refusals: [], prose: [] }

// ------------------------------------------------------------------------------ plumbing

let pendingStop = null
class Stop {
  constructor(status, reason) { this.status = status; this.reason = reason; if (!pendingStop) pendingStop = this }
}

const calls = []
// calls[] becomes journal result lines (docs/harness.md, "Journal"): outcome in the phase-spend
// vocabulary, the raw outcome kept as detail, escalatedFrom as the failed attempt's model.
const OUTCOME = { ok: 'ok', pending: 'ok', refused: 'ok', error: 'ok', blocked: 'ok', schema: 'invalid', 'harness-blocked': 'harness-blocked' }
const pushCall = c => calls.push({ label: c.label, outcome: OUTCOME[c.outcome] || 'error', detail: c.outcome,
  escalatedFrom: c.escalatedFrom ? (TIERS[c.escalatedFrom] || c.escalatedFrom) : null, ...(c.why ? { why: c.why } : {}) })
const decisions = []
let CUR = 'waves'

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const label = (lane, tier, detail) => `${CUR}:${lane}:${tier}${detail ? `:${detail}` : ''}`
const modelOf = tier => (TIERS[tier] === null || TIERS[tier] === undefined ? undefined : TIERS[tier])
const clip = (s, n = 400) => String(s || '').slice(0, n)
const lastLine = s => String(s || '').trim().split('\n').pop() || ''

// A model echoing `command` re-renders its shell quoting (stripped quotes, `\ ` for a quoted space,
// '"'"' for '\'', real line breaks as \n) rather than copying bytes; compare with those collapsed.
const sameCommand = s => String(s || '').replace(/'"'"'|'\\''/g, "'").replace(/\\[nrt]/g, ' ').replace(/\\(\s)/g, '$1')
  .replace(/['"]/g, '').replace(/\s+/g, ' ').trim()

// A `write` body is too long for a small model to echo back intact (2026-10-02: cut to `...` while
// the file landed correctly), so a write is judged on the file it names and the bytes the harness measured.
const utf8Bytes = s => { let n = 0; for (const ch of String(s)) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 } return n }
const samePath = (a, b) => String(a || '').replace(/\/+/g, '/').replace(/\/$/, '') === String(b || '').replace(/\/+/g, '/').replace(/\/$/, '')
const writeLanded = argv => {
  const file = argv[argv.indexOf('--file') + 1]
  const bytes = utf8Bytes(argv[argv.indexOf('--text') + 1])
  return (result, exitCode) => exitCode === 0 && result.status === 'ok' && result.bytes === bytes && samePath(result.artifact, file)
}

async function execCommand(command, detail, landed) {
  const base = ROUTING.exec || { tier: 'T1', model: 'haiku' }
  const prompt =
    `Run exactly this command with the Bash tool, once, and nothing else: ${command}\n` +
    'Return JSON: `command` as given, `ran`, `exitCode`, `stdout` verbatim (untrimmed, unparsed). If the tool call is ' +
    'refused, return `ran: false`, `exitCode: null`, `stdout: ""` and the literal refusal text as `denial`. Do not ' +
    'retry, explain, or fix anything.'
  const attempts = [base.tier, base.tier, TIER_ORDER[Math.min(TIER_ORDER.indexOf(base.tier) + 1, 2)]]
  let blockedOnce = false
  for (let i = 0; i < attempts.length; i++) {
    const tier = attempts[i]
    const lbl = label('exec', tier, detail)
    const model = i === 0 ? (base.model || undefined) : modelOf(tier)
    const r = await agent(prompt, { label: lbl, phase: CUR, schema: SCHEMAS.exec, model, disallowedTools: DISPATCH_DENY })
    const bad = why => { pushCall({ label: lbl, outcome: 'schema', escalatedFrom: i === 2 ? attempts[0] : null, why }); return null }
    if (!r || typeof r !== 'object') { bad('no result'); continue }
    if (!landed && sameCommand(r.command) !== sameCommand(command)) { bad('command altered'); continue }
    if (r.ran === false) {
      pushCall({ label: lbl, outcome: 'harness-blocked', escalatedFrom: null })
      if (!blockedOnce) { blockedOnce = true; i -= 1; continue }
      return { status: 'blocked', kind: 'harness-blocked', denial: clip(r.denial || 'tool call refused') }
    }
    let result
    try { result = JSON.parse(lastLine(r.stdout)) } catch { bad('stdout is not a script-result line'); continue }
    if (!result || typeof result.status !== 'string') { bad('stdout is not a script-result line'); continue }
    if (landed && !landed(result, r.exitCode)) { bad('write not verified'); continue }
    pushCall({ label: lbl, outcome: result.status, escalatedFrom: i === 2 ? attempts[0] : null })
    return { ...result, exitCode: r.exitCode }
  }
  return { status: 'error', kind: 'schema', reason: `exec lane failed its checks three times: ${detail}` }
}

async function run(script, argv, detail) {
  const command = [H, 'run', '--root', ROOT, '--', `${LIB}/${script}`, ...argv].map(q).join(' ')
  const r = await execCommand(command, detail || script.split('/').pop().replace('.mjs', ''))
  if (r.kind === 'harness-blocked') await harnessBlocked(r.denial, command)
  return r
}

async function harness(argv, detail) {
  const command = [H, ...argv].map(q).join(' ')
  const r = await execCommand(command, detail, argv[0] === 'write' ? writeLanded(argv) : null)
  if (r.kind === 'harness-blocked') await harnessBlocked(r.denial, command)
  return r
}

const state = (argv, detail) => run('state/state.mjs', argv, detail || `state-${argv[0]}`)

// Never counted toward the ceiling, never offered as a choice: it parks the day with the rule named.
async function harnessBlocked(denial, what) {
  const d = { ticket: TICKET, kind: 'harness-blocked', question: `harness refused: ${clip(what, 200)}`, why: clip(denial), blocks: `the ${DATE} day run` }
  const r = await execCommand([H, 'run', '--root', ROOT, '--', `${LIB}/state/state.mjs`, 'decide', JSON.stringify(d)].map(q).join(' '), 'state-decide')
  if (r.status === 'ok') decisions.push(r.id)
  throw new Stop('parked', `harness-blocked: ${clip(denial, 200)}`)
}

async function decide({ ticket, kind, question, why, blocks, options, recommendation, reversalCost }) {
  const d = { ticket: ticket || TICKET, kind, question: clip(question, 1000), why: clip(why, 1000), blocks: clip(blocks || `the ${DATE} day run`, 300) }
  if (options && options.length) d.options = options.map(o => clip(o, 300))
  if (recommendation) d.recommendation = clip(recommendation, 300)
  if (reversalCost) d.reversalCost = clip(reversalCost, 300)
  const r = await state(['decide', JSON.stringify(d)])
  if (r.status === 'ok') decisions.push(r.id)
  else log(`day: decision not recorded (${r.reason || r.kind}): ${clip(question, 120)}`)
  return r.id || null
}

async function pauseForUsage(retryAfter) {
  await state(retryAfter ? ['handoff', '--pause', retryAfter] : ['handoff', `paused-usage: day ${DATE}, reset time unknown`])
  throw new Stop('paused-usage', `usage limit${retryAfter ? ` until ${retryAfter}` : ''}`)
}

async function classify(text) {
  const r = await harness(['classify', '--text', clip(text, 2000)], 'classify')
  return r.status === 'ok' ? null : r
}

async function lane(name, prompt, detail, opts = {}) {
  const route = ROUTING[name]
  if (!route) throw new Error(`no routing for lane "${name}"`)
  let tier = route.tier
  let model = route.model || undefined
  let escalatedFrom = null
  let retried = false
  let rateLimited = 0
  for (;;) {
    const lbl = label(name, tier, detail)
    let r = null
    let err = null
    try {
      r = await agent(prompt, { label: lbl, phase: CUR, schema: SCHEMAS[name], model, agentType: opts.agentType, disallowedTools: DISPATCH_DENY })
    } catch (e) { err = e }
    if (err) {
      const c = await classify(String(err && err.message ? err.message : err))
      const kind = c ? c.kind : 'script-error'
      pushCall({ label: lbl, outcome: kind, escalatedFrom })
      if (kind === 'usage-limit') await pauseForUsage(c.retryAfter)
      if (kind === 'rate-limit' && rateLimited < CAPS.backoffAttempts) {
        const s = Math.min(CAPS.backoffFirstSeconds * 2 ** rateLimited, CAPS.backoffMaxSeconds)
        rateLimited += 1
        await harness(['sleep', '--seconds', String(s)], 'backoff')
        continue
      }
      if (kind === 'harness-blocked') {
        if (!retried) { retried = true; continue }
        await harnessBlocked(String(err.message || err), lbl)
      }
      r = null
    }
    // A lane that finished its work is never re-run or parked for what it reports about the
    // environment; a day run has no PR body, so those items go to the log.
    const t = r ? triageAwaiting(name, r, AWAITING) : null
    if (t && t.refusals.length && r.ok !== true) {
      pushCall({ label: lbl, outcome: 'harness-blocked', escalatedFrom })
      if (!retried) { retried = true; continue }
      await harnessBlocked(t.refusals[0].why, lbl)
    }
    if (t) {
      for (const n of [...t.notes, ...t.refusals]) log(`${DATE} ${name} note: ${clip(n.question, 200)}: ${clip(n.why, 300)}`)
      r = { ...r, awaiting: t.decisions }
    }
    if (!r) {
      if (!err) pushCall({ label: lbl, outcome: 'died', escalatedFrom })
      if (!retried) { retried = true; continue }
      const i = TIER_ORDER.indexOf(tier)
      if (i < 2 && escalatedFrom === null) { escalatedFrom = tier; tier = TIER_ORDER[i + 1]; model = modelOf(tier); continue }
      return null
    }
    pushCall({ label: lbl, outcome: 'ok', escalatedFrom })
    for (const a of r.awaiting || []) await decide({ ...a, kind: ARGS.kinds && ARGS.kinds[a.kind] ? a.kind : 'question' })
    if (!opts.noEscalation)
      for (const x of r.questions || [])
        await escalate({ ticket: TICKET, kind: 'question', status: 'open', question: x.question, why: x.why || `raised by ${name}`,
          options: x.options, recommendation: x.recommendation, blocks: `the ${DATE} day run` })
    return r
  }
}

const laneForRole = (role, b, record, step) => lane(role,
  `Use the flow-${role} skill. Day run ${DATE}, unattended, phase "${CUR}". Profile: ${F.profilePath}.\n` +
  (b.question ? `Question: ${b.question}\n` : '') +
  (record && record.options ? `Options: ${record.options.join(' / ')}\n` : '') +
  (record && record.recommendation ? `The asking agent recommends: ${record.recommendation}\n` : '') +
  (record && record.why ? `Why: ${record.why}\n` : '') +
  (b.mandate ? `Mandate step: ${b.mandate}${step && step.what ? ` (${step.what})` : ''}\n` : '') +
  `\n${INVIOLABLES}\n\n${RULINGS}\n\n${RESULT_CONTRACT}`,
  b.mandate || 'question', { agentType: role === 'resolver' ? AGENTS.resolver : AGENTS.ownerProxy, noEscalation: true })

async function escalate(record, step) {
  const s = { ...(step || {}) }
  if (s.channel && Array.isArray(ARGS.hardStopChannels) && !ARGS.hardStopChannels.includes(s.channel)) delete s.channel
  const r = await runChain({ facts: F, decision: record, step: s }, (role, b) => laneForRole(role, b, record, s))
  if (r.harnessBlock) await harnessBlocked(r.harnessBlock.why, r.harnessBlock.question)
  if (r.route === 'decided' || r.route === 'proxied') return { ok: true, route: r.route, ruling: r.record ? r.record.resolution : r.reason }
  if (record) {
    const { status, ...rest } = record
    await decide({ ...rest, recommendation: (r.record && r.record.recommendation) || record.recommendation, why: `${record.why} [${r.reason}]` })
  }
  return { ok: false, route: r.route, reason: r.reason }
}

// ------------------------------------------------------------------------------ day

const results = []
let status = 'running'
let reason = null
let liftedOnce = false

// The count is read from the shared decisions file, so decisions written by other sessions on the
// same STATE_ROOT count too, and kinds that never escalate (harness-blocked among them) never do.
async function openCount() {
  const r = await state(['open-count', ...(EXCLUDE.length ? ['--exclude', EXCLUDE.join(',')] : [])], 'open-count')
  if (r.status !== 'ok') throw new Stop('parked', `open-count refused: ${r.reason || r.kind}`)
  return r.open
}

async function ceilingAllows(notStarted) {
  const open = await openCount()
  if (open < CEILING) return true
  const record = { ticket: TICKET, kind: 'ceiling', status: 'open',
    question: `The day stopped at ${open} open decisions (ceiling ${CEILING}); ${notStarted.join(', ')} did not start. Resolve the open items, or lift the ceiling once?`,
    why: `open-count ${open} >= dayCeiling ${CEILING}`, blocks: notStarted.join(', '),
    options: ['resolve the open decisions, then resume the day', 'lift the ceiling for one more chunk', 'leave the rest of the queue for another day'],
    recommendation: 'resolve the open decisions, then resume the day', reversalCost: 'low: a resumed day skips finished tickets' }
  if (!liftedOnce) {
    const r = await escalate(record, { mandate: 'lift-cap-once', what: `one more chunk past ceiling ${CEILING}` })
    if (r.ok) { liftedOnce = true; log(`ceiling ${CEILING} lifted once by ${r.route}`); return true }
  } else await decide(record)
  status = 'ceiling'
  reason = `ceiling ${CEILING} reached with ${open} open decisions`
  log(reason)
  return false
}

async function phaseOutput(ticket, ph) {
  const r = await state(['phase-get', ticket, ph], `phase-get-${ph}`)
  return r.status === 'ok' && r.found ? (r.output || {}) : null
}

async function runChild(entry) {
  const t = entry.ticket
  const done = await phaseOutput(t, 'logs')
  if (done) return { ticket: t, status: done.status || 'done', prUrl: done.prUrl || null, skipped: true }
  if (await phaseOutput(t, 'start')) {
    const r = await escalate(null, { mandate: 'resume-run', what: `resume ${t} from its last checkpoint` })
    if (!r.ok) {
      await decide({ ticket: t, kind: 'run-died', question: `${t} stopped mid-run and the owner proxy did not resume it (${r.reason}). Resume it, or hand it back?`,
        why: `resume-run: ${r.route}`, blocks: t, options: ['resume it from its last checkpoint', 'hand it back to the manual queue'],
        recommendation: 'resume it from its last checkpoint', reversalCost: 'low: checkpoints are kept either way' })
      return { ticket: t, status: 'parked', reason: 'resume-run not granted' }
    }
  }
  const r = await workflow({ scriptPath: ARGS.runTicketScript }, { ...CHILD_BASE, ...entry })
  return r ? { ticket: t, status: r.status, reason: r.reason, prUrl: r.prUrl, headSha: r.headSha, decisions: r.decisions || [] } : { ticket: t, status: 'died', reason: 'child returned nothing' }
}

async function runChunk(chunk) {
  // Children are started in queue order, each waiting only for its predecessor's start, so the
  // order of workflow() calls is a function of the queue and not of scheduling.
  let prev = Promise.resolve()
  const thunks = chunk.map(entry => {
    const mine = prev
    let started
    prev = new Promise(res => { started = res })
    return () => mine.then(() => {
      const p = runChild(entry)
      started()
      return p
    }).catch(e => ({ ticket: entry.ticket, status: 'died', reason: clip(e && e.message ? e.message : e, 300) }))
  })
  const rs = await parallel(thunks)
  if (pendingStop) throw pendingStop
  return rs.map((r, i) => r || { ticket: chunk[i].ticket, status: 'died', reason: 'no result' })
}

async function main() {
  CUR = 'waves'; phase('waves')
  for (let w = 0; w < WAVES.length; w++) {
    const wave = WAVES[w]
    if (w > 0) {
      const fresh = []
      for (const e of wave) if (!(await phaseOutput(e.ticket, 'start'))) fresh.push(e.ticket)
      if (fresh.length) {
        const r = await escalate(null, { mandate: 'start-next-ticket', what: `start wave ${w + 1}: ${fresh.join(', ')}` })
        if (!r.ok) {
          await decide({ kind: 'question', question: `Wave ${w + 1} (${fresh.join(', ')}) waits: the owner proxy did not start it (${r.reason}). Start it, or stop the day here?`,
            why: `start-next-ticket: ${r.route}`, blocks: fresh.join(', '), options: [`start wave ${w + 1}`, 'stop the day here'],
            recommendation: `start wave ${w + 1}`, reversalCost: 'low: nothing has started' })
          status = 'parked'
          reason = `wave ${w + 1} not started: ${r.reason}`
          return
        }
      }
    }
    for (let i = 0; i < wave.length; i += MAXP) {
      const chunk = wave.slice(i, i + MAXP)
      const rest = [...wave.slice(i), ...WAVES.slice(w + 1).flat()].map(e => e.ticket)
      if (!(await ceilingAllows(rest))) return
      log(`wave ${w + 1}/${WAVES.length}: ${chunk.map(e => e.ticket).join(', ')}`)
      for (const r of await runChunk(chunk)) {
        results.push(r)
        if (r.status === 'died') {
          await decide({ ticket: r.ticket, kind: 'run-died', question: `${r.ticket} ended without a result (${r.reason}). Resume it, or hand it back?`,
            why: clip(r.reason, 300), blocks: r.ticket, options: ['resume it from its last checkpoint', 'hand it back to the manual queue'],
            recommendation: 'resume it from its last checkpoint', reversalCost: 'low: checkpoints are kept either way' })
        }
        log(`${r.ticket}: ${r.status}${r.skipped ? ' (finished earlier)' : ''}`)
      }
      const paused = results.find(r => r.status === 'paused-usage')
      if (paused) throw new Stop('paused-usage', `${paused.ticket} hit a usage limit`)
    }
  }
}

try {
  await main()
} catch (e) {
  if (!(e instanceof Stop)) throw e
  status = e.status
  reason = e.reason
}
if (status === 'running') status = 'done'

const merged = results.filter(r => r.status === 'merged' && !r.skipped).map(r => r.ticket)
let sweep = null
if (status !== 'paused-usage' && REPO_PATH) {
  CUR = 'sweep'; phase('sweep')
  try {
    const base = await harness(['base-head', '--cwd', REPO_PATH, '--base', BASE, '--root', ROOT], 'base-head')
    const moved = base.status === 'ok' && base.headSha && base.headSha !== base.lastSweepSha
    if (base.status !== 'ok') log(`sweep skipped: base head unreadable (${base.reason || base.status})`)
    if (moved) {
    sweep = await lane('sweep-summary',
      `${UNATTENDED}\n\nDay ${DATE}, profile ${F.profilePath}. ${BASE} is at ${base.headSha}` +
      `${base.lastSweepSha ? `, last swept at ${base.lastSweepSha}` : ''}. Merged by today's runs: ${merged.join(', ') || 'none'}; ` +
      'other merges may have landed outside them. Per-ticket QA already ran; ' +
      'this sweep looks only for interactions between the changes. Read the profile sections "## environments" and "## test toolchain": ' +
      'confirm the environment serves a SHA that contains every merge, then run the full oracle set they name. A regression ' +
      'is reported with the SHA, the steps and the evidence; nothing is filed anywhere.\n\n' +
      `${INVIOLABLES}\n\n${RESULT_CONTRACT}`, 'regressions')
    for (const g of (sweep && sweep.regressions) || [])
      await decide({ kind: 'question', question: `Regression after today's merges: ${clip(g, 600)}`, why: 'day sweep', blocks: 'the next day run',
        options: ['open a fix ticket for it', 'revert the merge that caused it'], recommendation: 'open a fix ticket for it', reversalCost: 'low: nothing changed yet' })
    if (sweep) await harness(['write', '--file', `${ROOT}/sweep-sha`, '--text', base.headSha], 'sweep-mark')
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e
    status = e.status
    reason = e.reason
  }
}

let summary = null
if (status !== 'paused-usage') {
  CUR = 'logs'; phase('logs')
  const open = await state(['open-count'], 'open-count')
  const readyToSign = results.filter(r => r.status === 'ready-to-sign').map(r => `${r.ticket} ${r.prUrl || ''}`.trim())
  const prose = await lane('log-prose',
    `Write a short impersonal summary of day run ${DATE}: status ${status}${reason ? ` (${reason})` : ''}; per ticket ` +
    `${results.map(r => `${r.ticket} ${r.status}`).join(', ') || 'none'}; ready to sign: ${readyToSign.join(', ') || 'none'}; ` +
    `open decisions ${open.open === undefined ? '?' : open.open} of ceiling ${CEILING}; sweep regressions ` +
    `${sweep ? sweep.regressions.length : 'not run'}. No names, no first person. ${RESULT_CONTRACT}`, 'summary')
  summary = prose ? clip(prose.text, 1200) : null
  await harness(['write', '--file', `${ROOT}/day-summary.md`, '--text', `# Day ${DATE}\n\n${summary || status}\n`], 'write-summary')
  if (['done', 'ceiling', 'parked'].includes(status)) await state(['handoff', '--done'], 'handoff-done')
}

return {
  date: DATE, status, reason, results, merged, decisions, ceiling: CEILING, liftedOnce,
  readyToSign: results.filter(r => r.status === 'ready-to-sign'), sweep, summary, calls,
}
