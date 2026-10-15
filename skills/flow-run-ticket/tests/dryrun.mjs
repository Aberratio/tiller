// Dry-run plumbing for the drivers: the Node ticket and day drivers run in-process over a stubbed
// runtime (sim.runtime). Judgment lanes return canned, schema-checked results; exec really runs
// the harness for state, resume, classify and write (under a temporary STATE_ROOT) and returns
// canned results for forge, git and verify-claim. Nothing reaches GitHub, a tracker or `claude`.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakeRuntimes } from '../../../lib/testing/fake-runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
installFakeRuntimes()

export const CORE = resolve(HERE, '..', '..', '..')
export const HARNESS = join(CORE, 'skills', 'flow-run-ticket', 'bin', 'harness.mjs')
export const PROFILE = join(CORE, 'lib', 'testing', 'fixtures', 'acme', 'profile.md')
export const NO_TRACKER = join(HERE, 'fixtures', 'no-tracker.md')
const { check } = await import(join(CORE, 'lib', 'contract', 'validate.mjs'))

export const tmpRoot = tag => mkdtempSync(join(tmpdir(), `flow-dry-${tag}-`))
// Where the canned repo worktree command "puts" a worktree: writable, since the driver writes its ledger there.
export const nativeWorktree = branch => join(tmpdir(), 'flow-dry-native-worktrees', branch)

export function shellSplit(cmd) {
  const out = []
  const re = /'((?:[^']|'\\'')*)'/g
  let m
  while ((m = re.exec(cmd))) out.push(m[1].replace(/'\\''/g, "'"))
  return out
}

export function harness(root, ...argv) {
  const p = spawnSync(process.execPath, [HARNESS, ...argv], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root, FLOW_FAKE_SLEEP: '1' } })
  return { exitCode: p.status, stdout: p.stdout, result: JSON.parse(p.stdout.trim().split('\n').pop()) }
}

export function state(root, ...argv) {
  const p = spawnSync(process.execPath, [join(CORE, 'lib', 'state', 'state.mjs'), ...argv], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root } })
  return JSON.parse(p.stdout.trim().split('\n').pop())
}

export function buildArgs(root, { profile = PROFILE, ticket = 'ABC-1', spec, extra = [] } = {}) {
  const argv = ['args', '--profile', profile, '--date', '2026-09-28', '--root', root, ...(spec ? ['--spec', spec] : ['--ticket', ticket]), ...extra]
  const r = harness(root, ...argv)
  if (r.result.status !== 'ok') throw new Error(`args refused: ${r.stdout}`)
  return JSON.parse(readFileSync(r.result.artifact, 'utf8'))
}

const defaults = (lane, ctx) => {
  const sha = ctx.head
  switch (lane) {
    case 'premise': return { verdict: 'holds', evidence: 'src/a.js:1 matches the ticket', awaiting: [] }
    case 'plan': return { ok: true, ticketKind: 'code', premiseVerdict: 'holds', planPath: join(ctx.sim.root, 'tickets', ctx.ticket, 'plan.md'), planSummary: 'plan', authorisedFiles: [...new Set(['server-new/', 'src/', ...ctx.files])], awaiting: [] }
    case 'implement': return { ok: true, headSha: ctx.nextSha(), commits: ['c1'], testCommand: 'npm test', testResult: 'pass', awaiting: [] }
    case 'review-axis': {
      // A re-verify resolves every finding the prompt asked about.
      const asked = (/Re-verify only these findings you raised: (.*?)\. List each/s.exec(ctx.prompt) || [])[1]
      const resolved = asked ? asked.split('; ').map(x => ({ id: x.split(': ')[0], evidence: 'fixed' })) : []
      // A resumed simulator has no head of its own yet; the lane reviews the SHA its brief names.
      const briefed = (/reviewedSha ([0-9a-f]{7,40})/.exec(ctx.prompt) || [])[1]
      return { axis: ctx.detail.split(':')[0], reviewedSha: briefed || sha, skipped: false, findings: [], report: 'clean', resolved, stillOpen: [], awaiting: [] }
    }
    case 'fix': return { headSha: ctx.nextSha(), fixed: [], skipped: [], awaiting: [] }
    case 'pr-description': return { title: `[${ctx.ticket}] chore: change`, body: "Body with 'quotes'.", awaiting: [] }
    case 'confidence-dim': return { dimension: ctx.detail, reviewedSha: sha, findings: [], report: 'fine', acCoverage: [], awaiting: [] }
    case 'reverify': return { findingId: ctx.detail, verdict: 'refuted', rationale: 'not reproducible', awaiting: [] }
    case 'conflict': return { resolved: true, headSha: ctx.nextSha(), files: ['server-new/a.ts'], unresolved: [], awaiting: [] }
    case 'qa-judge': return { deployedSha: sha, criteria: [{ id: 'AC1', verdict: 'pass', evidence: 'observed' }], awaiting: [] }
    case 'resolver': return { decision: 'take option one', park: false, rationale: 'sources agree', reversalCost: 'low', awaiting: [] }
    case 'owner-proxy': {
      const mandate = (/Mandate step: ([a-z-]+)/.exec(ctx.prompt) || [])[1] || 'undraft-pr'
      return { action: 'act', mandate, step: mandate, parkReason: '', conditions: [], rationale: 'within mandate', reversalCost: 'low', awaiting: [] }
    }
    case 'second-opinion': return { reviewedSha: (/reviewedSha ([0-9a-f]{7,40})/.exec(ctx.prompt) || [])[1] || sha, verdicts: [], report: 'nothing to downgrade', awaiting: [] }
    case 'log-prose': return { text: 'Run summary.', awaiting: [] }
    case 'sweep-summary': return { summary: 'Day summary.', regressions: [], awaiting: [] }
    default: throw new Error(`no default for lane ${lane}`)
  }
}

const canned = (script, argv, ctx) => {
  const opt = k => argv[argv.indexOf(k) + 1]
  switch (script) {
    case 'duplicate-guard.mjs': return { status: 'ok', key: opt('--key'), prs: [], branches: [] }
    // A repo-native command puts the worktree where the repo keeps them, never at --dir.
    case 'worktree.mjs': return { status: 'ok', path: argv.includes('--command') ? nativeWorktree(opt('--branch')) : opt('--dir'), branch: opt('--branch'), headSha: 'ba5e000', created: true }
    case 'verify-claim.mjs': return { status: 'ok', match: argv[1], command: 'npm test', claim: 'pass', actual: 'pass', exitCode: 0, mismatch: false }
    case 'scope-fence.mjs': {
      const from = argv.indexOf('--authorised')
      const end = argv.findIndex((a, j) => j > from && a.startsWith('--'))
      const authorised = from < 0 ? [] : argv.slice(from + 1, end < 0 ? argv.length : end)
      const extra = ctx.files.filter(f => !authorised.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a)))
      return { status: 'ok', pin: opt('--pin'), head: opt('--head'), changedFiles: ctx.files, authorised, extra, inScope: extra.length === 0 }
    }
    case 'head-truth.mjs': {
      const expect = argv.includes('--expect') ? opt('--expect') : null
      // An honest worktree holds the head it is asked about; mutants override this explicitly.
      return { status: 'ok', headSha: expect || ctx.head, clean: true, dirty: [], expect, matchesExpect: expect === null ? null : true, descendsFromBase: true }
    }
    case 'scan-diff.mjs': return { status: 'ok', base: opt('--base'), head: opt('--head'), changedFiles: 1, total: 0, audit: null, findings: [] }
    case 'pr-open.mjs': return { status: 'ok', prUrl: 'https://forge.test/pr/7', number: 7, draft: true }
    case 'pr-ready.mjs': return { status: 'ok' }
    case 'wait-ci.mjs': return { status: 'ok', sha: opt('--sha'), state: 'green', checks: [{ name: 'test', conclusion: 'success' }] }
    case 'review-bot-green.mjs': return { status: 'ok', headSha: opt('--sha'), reviewed: true, green: true, reviewId: 1, reviewCommit: opt('--sha'), matchedSkipPattern: null }
    case 'diff-since-review.mjs': return { status: 'ok', pin: opt('--pin'), head: opt('--head'), artifact: opt('--out'), bytes: 10, changedFiles: ctx.files }
    case 'pr-state.mjs': return { status: 'ok', state: 'OPEN', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', isDraft: false }
    case 'update-from-base.mjs': return { status: 'ok', updated: false, baseSha: 'ma1n001', headSha: ctx.head }
    case 'pr-merge.mjs': return { status: 'ok', merged: true, number: Number(opt('--pr')), method: 'squash' }
    case 'cleanup.mjs': return { status: 'ok', removed: [], kept: [] }
    default: throw new Error(`no canned result for ${script}`)
  }
}

// One simulated run. `mode` hooks: agent(lane, ctx) and exec(name, argv, ctx) may return an
// override object, `null` (a dead agent), { throw: text }, { hang: true } or undefined (default).
export function makeSim(root, args, mode = {}) {
  let n = 0
  const sim = {
    root, args, labels: [], execs: [], logs: [], laneOpts: [], files: mode.files || ['server-new/a.ts'],
    hung: null, heads: {}, children: [], baseHead: mode.baseHead || 'ma1n001',
  }
  // Children of a day run share one simulator, so heads are kept per ticket.
  const ticketOf = text => (/Ticket ([A-Z][A-Z0-9-]*)\./.exec(text) || /'--branch' '([A-Z0-9-]+)-run'/.exec(text) || /--branch ([A-Z0-9-]+)-run/.exec(text) || /\/([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)-run[-/ '"]/.exec(text) || [])[1] || '_'
  const headOf = t => sim.heads[t] || 'ba5e000'
  Object.defineProperty(sim, 'head', { get: () => headOf(Object.keys(sim.heads).at(-1) || '_') })
  let onHang
  sim.hangPromise = new Promise(r => { onHang = r })
  const hang = where => { sim.hung = where; onHang(where); return new Promise(() => {}) }
  const ctxOf = (label, prompt) => {
    const [phase, lane, tier, ...rest] = label.split(':')
    const ticket = ticketOf(prompt)
    return { phase, lane, tier, detail: rest.join(':'), prompt, ticket, head: headOf(ticket), files: sim.files, sim,
      nextSha: () => { n += 1; return (0xc0ffee0 + n).toString(16) }, count: l => sim.labels.filter(x => x.split(':')[1] === l).length }
  }

  sim.agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (!/^[a-z-]+:[a-z-]+:T[0-4](:.+)?$/.test(label)) throw new Error(`bad label "${label}"`)
    sim.labels.push(label)
    const ctx = ctxOf(label, prompt)
    const route = args.routing[ctx.lane]
    if (!route) throw new Error(`lane ${ctx.lane} has no routing`)
    if (ctx.tier === 'T3' && opts.model !== (args.tiers.T3 ?? undefined)) throw new Error(`T3 lane ${label} got model ${opts.model}, not the pinned ${args.tiers.T3}`)
    if (TIERS_BELOW_GATE(args, ctx)) throw new Error(`gate lane ${label} below T3`)
    const o = mode.agent ? mode.agent(ctx.lane, ctx) : undefined
    if (o === null) return null
    if (o && o.hang) return hang(label)
    if (o && o.throw) throw new Error(o.throw)
    const out = { ...defaults(ctx.lane, ctx), ...(o || {}) }
    // mode.skipLaneCheck: only for tests exercising what happens when a real agent call's
    // structured-output schema (looser than lib/contract's semantic rules) lets an
    // otherwise-schema-valid-but-semantically-incomplete result through, as a live agent() call can.
    if (!mode.skipLaneCheck) {
      const errs = check(`lane-${ctx.lane}`, out)
      if (errs.length) throw new Error(`stub for ${label} violates lane-${ctx.lane}: ${errs.join('; ')}`)
    }
    if (out.headSha) sim.heads[ctx.ticket] = out.headSha
    return out
  }

  // One harness-shaped argv ([HARNESS, sub, ...]) against the stubs: { ran, exitCode, stdout },
  // { denial } for a refused call, or a hang. state.mjs runs itself; resume, classify and write run
  // through the harness.
  const dispatch = async (argv, command, ctx, label) => {
    const sub = argv[1]
    const script = sub === 'run' ? argv[argv.indexOf('--') + 1] : null
    const sargs = sub === 'run' ? argv.slice(argv.indexOf('--') + 2) : argv.slice(2)
    const name = script ? script.split('/').pop() : sub
    sim.execs.push({ name, argv: sargs, label })
    const o = mode.exec ? mode.exec(name, sargs, ctx) : undefined
    if (o && o.hang) return hang(label)
    if (o && o.denied) return { ran: false, exitCode: null, stdout: '', denial: o.denied }
    if (o && o.raw) return o.raw
    let result
    let exitCode = 0
    if (o) result = o
    else if (name === 'state.mjs') {
      const p = spawnSync(process.execPath, [script, ...sargs], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root } })
      return { ran: true, exitCode: p.status, stdout: p.stdout }
    } else if (['resume', 'classify', 'write'].includes(sub)) {
      const r = harness(root, ...argv.slice(1))
      return { ran: true, exitCode: r.exitCode, stdout: r.stdout }
    } else if (sub === 'sleep') result = { status: 'ok', slept: 0 }
    else if (sub === 'push') result = { status: 'ok', branch: 'b', headSha: headOf(ticketOf(command)) }
    else if (sub === 'command') result = { status: 'ok', state: 'green', exitCode: 0 }
    else if (sub === 'base-head') {
      const mark = join(root, 'sweep-sha')
      result = { status: 'ok', headSha: sim.baseHead, lastSweepSha: existsSync(mark) ? readFileSync(mark, 'utf8').trim() : null }
    }
    else result = canned(name, sargs, ctx)
    // A script that moved the branch is the head's new source, as a lane's headSha is.
    if (name === 'update-from-base.mjs' && result && result.status === 'ok' && result.headSha) sim.heads[ctx.ticket] = result.headSha
    if (result.status === 'pending') exitCode = 2
    else if (result.status !== 'ok') exitCode = 1
    return { ran: true, exitCode, stdout: JSON.stringify(result) + '\n' }
  }

  // The Node driver's runtime on the same simulator: lanes go to sim.agent, argv arrays to the stubs.
  sim.runtime = {
    lane: async ({ label, prompt, model, schema, agentType, disallowedTools }) => {
      sim.laneOpts.push({ label, disallowedTools, agentType })
      const result = await sim.agent(prompt, { label, model, schema, agentType })
      return { result, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, costUsd: 0, durationMs: 0, model }
    },
    exec: async (argv, opts = {}) => {
      const label = opts.label || ''
      const [phase, , ...rest] = label.split(':')
      const hargv = argv[1] === HARNESS ? argv.slice(1) : [HARNESS, 'run', '--root', root, '--', ...argv.slice(1)]
      const command = argv.slice(1).join(' ')
      const ticket = ticketOf(command)
      const ctx = { phase, lane: 'exec', tier: null, detail: rest.join(':'), prompt: command, ticket, head: headOf(ticket), files: sim.files, sim,
        nextSha: () => { n += 1; return (0xc0ffee0 + n).toString(16) }, count: l => sim.labels.filter(x => x.split(':')[1] === l).length }
      const r = await dispatch(hargv, command, ctx, label)
      if (r.ran === false) return { exitCode: 126, stdout: '', stderr: r.denial || 'refused', durationMs: 0 }
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout || '', stderr: '', durationMs: 0 }
    },
    log: m => sim.logs.push(m),
    sleep: async () => {},
  }
  return sim
}

const TIERS_BELOW_GATE = (args, ctx) => {
  const r = args.routing[ctx.lane]
  return r && r.tier === 'T3' && ctx.tier !== 'T3'
}

// One simulated ticket run through the Node driver.
export async function runTicketDriver(sim) {
  const { createRun } = await import(join(CORE, 'lib', 'driver', 'drive.mjs'))
  return Promise.race([createRun(sim.args, sim.runtime), sim.hangPromise.then(where => ({ killed: where }))])
}

// The pid of a process that has already exited: a day lock taken under it is stale for the next run,
// as it is after a real crash.
export const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid

// One simulated day through the Node day driver; each child runs the Node ticket driver in-process.
export async function runDayDriver(sim, runtime = {}) {
  const { driveDay } = await import(join(CORE, 'lib', 'driver', 'day.mjs'))
  const { drive } = await import(join(CORE, 'lib', 'driver', 'drive.mjs'))
  const launch = async (entry, childArgs) => {
    sim.children.push(entry.ticket)
    return (await drive(childArgs, sim.runtime)).result
  }
  // A fixed mid-morning clock: the fixture profiles set a stop hour, and a test must not depend on when it runs.
  const run = driveDay(sim.args, { ...sim.runtime, pid: DEAD_PID, launch, now: () => new Date(2026, 8, 28, 10, 0), ...runtime })
    .then(({ result, fatal }) => fatal ? { ...result, fatal } : result)
  return Promise.race([run, sim.hangPromise.then(where => ({ killed: where }))])
}

export function buildDayArgs(root, { profile = PROFILE, queue, extra = [] }) {
  const qf = join(root, 'queue.json')
  writeFileSync(qf, JSON.stringify(queue))
  const r = harness(root, 'day-args', '--profile', profile, '--date', '2026-09-28', '--root', root, '--queue', qf, ...extra)
  if (r.result.status !== 'ok') return { refused: r.result }
  return JSON.parse(readFileSync(r.result.artifact, 'utf8'))
}

export const decisionsOf = root => {
  try {
    const latest = new Map()
    for (const l of readFileSync(join(root, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const d = JSON.parse(l)
      latest.set(d.id, d)
    }
    return [...latest.values()]
  } catch { return [] }
}
