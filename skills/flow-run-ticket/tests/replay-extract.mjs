#!/usr/bin/env node
// Turns a recorded Workflow run (its journal json plus the subagent transcripts next to it) into a
// replay fixture: every lane result in call order, keyed by label and occurrence, and every exec
// result keyed by script name and occurrence, with prose clipped and local paths neutralised.
//
//   node replay-extract.mjs --journal <wf_x.json> [--agents <dir>] --out <fixture.json>
//   node replay-extract.mjs --steps <root>/tickets/<T>/steps.jsonl --root <root> --out <fixture.json>

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { shellSplit } from './dryrun.mjs'

const PROSE = 300
const opt = (argv, k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1] }

const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{20,})/g

// The recorded run's STATE_ROOT becomes <ROOT> (the replay substitutes its own tmp root), the home
// directory `~`, anything token-shaped <redacted>, e-mail addresses <email>; prose is clipped.
export function scrub(v, subs) {
  if (typeof v === 'string') {
    let s = v
    for (const [from, to] of subs) s = s.split(from).join(to)
    s = s.replace(SECRET, '<redacted>').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    return s.length > PROSE ? `${s.slice(0, PROSE)}…` : s
  }
  if (Array.isArray(v)) return v.map(x => scrub(x, subs))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, subs)]))
  return v
}

// The last StructuredOutput call of a subagent transcript is its lane result.
function structuredOutput(file) {
  let out = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"StructuredOutput"')) continue
    const e = JSON.parse(line)
    for (const c of (e.message && e.message.content) || []) if (c.type === 'tool_use' && c.name === 'StructuredOutput') out = c.input
  }
  return typeof out === 'string' ? JSON.parse(out) : out
}

// A command as the exec lane echoed it: quoted, backslash-escaped or bare (a bare path with a space
// in it splits), so only the harness sub-command and the script name are read from it.
export function commandShape(command) {
  const sub = (/harness\.mjs'?\s+'?([a-z-]+)/.exec(command) || [])[1] || null
  const scripts = [...command.matchAll(/\/([a-z][a-z-]*\.mjs)/g)].map(m => m[1]).filter(x => x !== 'harness.mjs')
  return { sub, name: sub === 'run' && scripts.length ? scripts[0] : sub }
}

const lastJson = stdout => {
  const line = String(stdout || '').trim().split('\n').pop()
  try { return JSON.parse(line) } catch { return null }
}

// Exec calls the replay runs for real under its own STATE_ROOT (the run-state lib) or answers
// with the simulator's no-op; the fixture does not carry them.
export const LIVE_IN_REPLAY = new Set(['state.mjs', 'resume', 'classify', 'write', 'sleep'])

export function extract(journalPath, agentsDir) {
  const j = JSON.parse(readFileSync(journalPath, 'utf8'))
  const result = typeof j.result === 'string' ? JSON.parse(j.result) : j.result
  const agents = j.workflowProgress.filter(x => x.type === 'workflow_agent').sort((x, y) => x.index - y.index)
  if ((result.calls || []).length !== agents.length) throw new Error(`calls[] (${(result.calls || []).length}) does not line up with ${agents.length} agents`)
  const seen = {}
  const occ = key => (seen[key] = (seen[key] || 0) + 1)
  const lanes = []
  const execs = []
  const dropped = []
  let live = 0
  const firstCommand = agents.map(a => existsSync(join(agentsDir, `agent-${a.agentId}.jsonl`)) && structuredOutput(join(agentsDir, `agent-${a.agentId}.jsonl`))).find(o => o && o.command)
  const runRoot = (/--root '?([^' ]+)/.exec(firstCommand ? firstCommand.command : '') || [])[1]
  const subs = [...(runRoot ? [[runRoot, '<ROOT>']] : []), [tmpdir(), '<TMP>'], [homedir(), '~']]
  const clean = v => scrub(v, subs)
  // calls[] is in completion order; parallel calls finish out of start order, so pair them per label.
  const byLabel = {}
  for (const c of result.calls) (byLabel[c.label] = byLabel[c.label] || []).push(c)
  agents.forEach((a, i) => {
    const call = byLabel[a.label].shift()
    const file = join(agentsDir, `agent-${a.agentId}.jsonl`)
    const out = existsSync(file) ? structuredOutput(file) : null
    const [phase, lane, tier, ...rest] = a.label.split(':')
    const detail = rest.join(':')
    // An exec-lane answer the runner refused (altered command, not a script-result line, a harness
    // denial) was retried by the runner; the driver has no exec lane, so it never makes that call.
    if (call.outcome !== 'ok') { dropped.push({ label: a.label, outcome: call.outcome, why: call.why || call.detail }); return }
    if (lane === 'exec') {
      const shape = commandShape(out.command)
      if (LIVE_IN_REPLAY.has(shape.name)) { live += 1; return }
      execs.push(clean({ key: `${phase}:${detail}:${shape.name}`, occurrence: occ(`${phase}:${detail}:${shape.name}`), label: a.label, name: shape.name, exitCode: out.exitCode, result: lastJson(out.stdout) }))
    } else {
      lanes.push(clean({ key: `${phase}:${lane}:${detail}`, occurrence: occ(`${phase}:${lane}:${detail}`), label: a.label, result: out }))
    }
  })
  return {
    ticket: result.ticket, runId: j.runId, recordedAt: new Date(j.startTime || j.timestamp || 0).toISOString().slice(0, 10),
    terminal: clean({ status: result.status, reason: result.reason, prUrl: result.prUrl, headSha: result.headSha,
      gate: (result.gate && result.gate.conditions || []).map(x => ({ name: x.name, state: x.state })) }),
    counts: { agents: agents.length, lanes: lanes.length, execs: execs.length, liveInReplay: live, dropped: dropped.length },
    dropped, lanes, execs,
  }
}

// The Node driver's step log (<root>/tickets/<T>/steps.jsonl) as a fixture, lanes keyed by phase, lane and sub-scope (axis:spec, dim:correctness),
// execs by phase, exec detail and script, both in step order.
const STATE_STEP = /^(checkpoint|counter-.*|state-.*)$/

export function extractSteps(stepsPath, { root = null } = {}) {
  const rows = readFileSync(stepsPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const runId = (rows.find(r => r.runId) || {}).runId
  const kept = rows.filter(r => r.runId === runId && typeof r.step === 'string' && !r.volatile)
  const subs = [...(root ? [[root, '<ROOT>']] : []), [tmpdir(), '<TMP>'], [homedir(), '~']]
  const clean = v => scrub(v, subs)
  const seen = {}
  const occ = key => (seen[key] = (seen[key] || 0) + 1)
  const lanes = []
  const execs = []
  let live = 0
  for (const r of kept) {
    const parts = r.step.replace(/#\d+$/, '').split('/')
    const phase = parts[0]
    const leaf = parts.at(-1)
    const scope = parts.slice(1, -1).join('/')
    if (leaf.startsWith('lane:')) {
      const lane = leaf.slice('lane:'.length)
      const key = `${phase}:${lane}:${scope}`
      lanes.push(clean({ key, occurrence: occ(key), result: r.result && r.result.result }))
    } else if (leaf.startsWith('exec:')) {
      const detail = leaf.slice('exec:'.length)
      const res = (r.result && r.result.result) || {}
      // Checkpoints, counters, resume and classify are state the replayed driver keeps for itself.
      if (STATE_STEP.test(detail) || LIVE_IN_REPLAY.has(detail)) { live += 1; continue }
      const key = `${phase}:${detail}`
      execs.push(clean({ key, occurrence: occ(key), exitCode: r.result && r.result.exitCode, result: res }))
    }
  }
  return { ticket: (/tickets\/([^/]+)\/steps\.jsonl$/.exec(stepsPath) || [])[1] || null, runId, source: 'node-steps',
    counts: { steps: kept.length, lanes: lanes.length, execs: execs.length, liveInReplay: live }, lanes, execs }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const argv = process.argv.slice(2)
  const out = opt(argv, '--out')
  if (opt(argv, '--steps')) {
    const fx = extractSteps(opt(argv, '--steps'), { root: opt(argv, '--root') })
    writeFileSync(out, JSON.stringify(fx, null, 1) + '\n')
    console.log(JSON.stringify({ status: 'ok', artifact: out, counts: fx.counts }))
    process.exit(0)
  }
  const journal = opt(argv, '--journal')
  const agents = opt(argv, '--agents') || join(dirname(dirname(journal)), 'subagents', 'workflows', basename(journal, '.json'))
  const fx = extract(journal, agents)
  writeFileSync(out, JSON.stringify(fx, null, 1) + '\n')
  console.log(JSON.stringify({ status: 'ok', artifact: out, counts: fx.counts, terminal: fx.terminal }))
}
