#!/usr/bin/env node
// The driver's one bridge to the deterministic layer: the args it runs on, the subcommands it
// calls mid-run, and the launch of the driver itself all go through this file.
//
//   harness.mjs run --root <STATE_ROOT> -- <absolute-script> [args...]
//       run a lib script with STATE_ROOT set, under with-backoff; stdout and exit passed through
//   harness.mjs classify --text <error text> [--exit-code N]
//       classify-failure over text that arrived as an argument rather than a file
//   harness.mjs sleep --seconds N           a bounded wait (capped at caps.waitCiSeconds)
//   harness.mjs write --file <path> --text <text>    write a file from an argument, verified by size (PR body)
//   harness.mjs push --cwd <worktree> --branch <name>   push the ticket branch to origin
//   harness.mjs base-head --cwd <repo> --base <branch> --root <STATE_ROOT>
//       fetched head of the base branch and the SHA the last day sweep covered (<root>/sweep-sha)
//   harness.mjs command --cwd <dir> --cmd <shell command>
//       a `command:` gate source; exit 0 = green, anything else = red
//   harness.mjs args --profile <file> --date <ISO> (--ticket <KEY> | --spec <path>)
//                    [--root <dir>] [--run <id>] [--note <text>]... [--hold-merge <reason>]
//                    [--branch <name> | --summary <ticket summary>] [--test-match <text>]
//       build the run-ticket args for the driver; written to <root>/args-<ticket>.json (artifact)
//   harness.mjs drive --args <artifact>
//       run the ticket on the Node driver (lib/driver/drive.mjs); one script-result line
//   harness.mjs resume --root <STATE_ROOT> --ticket <KEY>
//       state.mjs resume with the checkpoint outputs inline, one line to read
//   harness.mjs day-args --profile <file> --date <ISO> --queue <waves.json> [--root <dir>] [--run <id>]
//       build the day args for the day driver; refused when the profile allows no unattended day run
//   harness.mjs drive-day --args <args-day.json>
//       run the day on the Node day driver (lib/driver/day.mjs); one script-result line
//   harness.mjs supervise-env --profile <file> [--disallow <tool>]...
//       SUPERVISE_STOP_HOUR and SUPERVISE_DISALLOWED_TOOLS for lib/supervisor/supervise.sh
//   harness.mjs calibrate --profile <file> [--root <run-state dir>] [--out <file>] [--min-n N] [--dry-run]
//       fold every run's verdict ledger under the profile's run-state directory into config/measured.json
//
// Output: one script-result line (docs/harness.md, "Script I/O").

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitingRules } from '../../../lib/contract/awaiting.mjs'
import { withPrices } from '../../../lib/driver/adapters/budget.mjs'
import { claudeToolName } from '../../../lib/driver/adapters/claude.mjs'
import { outwardRoleOps, resolveTools } from '../../../lib/driver/adapters/tools.mjs'
import { runtimeAvailability } from '../../../lib/driver/adapters/index.mjs'
import { checkMeasured, cooldownFrom, journalsUnder, recentFrom } from '../../../lib/journal/calibrate.mjs'
import { readJournal } from '../../../lib/driver/journal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CORE = resolve(HERE, '..', '..', '..')
export const LIB = join(CORE, 'lib')
const kinds = JSON.parse(readFileSync(join(LIB, 'contract', 'kinds.json'), 'utf8'))

const emit = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code) }
const refuse = reason => emit(4, { status: 'refused', kind: 'policy', reason })
const fail = reason => emit(1, { status: 'error', kind: 'script-error', reason })

function parse(argv, repeatable = []) {
  const opts = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') { rest.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--')) { rest.push(a); continue }
    const key = a.slice(2)
    const next = argv[i + 1]
    const val = next === undefined || next.startsWith('--') ? true : (i++, next)
    if (repeatable.includes(key)) (opts[key] ||= []).push(val)
    else opts[key] = val
  }
  return { opts, rest }
}

const lastJsonLine = s => {
  const line = String(s || '').trim().split('\n').pop() || ''
  try { return JSON.parse(line) } catch { return null }
}

// ------------------------------------------------------------------------------ run

async function run(opts, rest) {
  if (!opts.root || !rest.length) refuse('usage: run --root <STATE_ROOT> -- <absolute-script> [args...]')
  const [script, ...scriptArgs] = rest
  if (!isAbsolute(script)) refuse(`script must be an absolute path: ${script}`)
  const env = { ...process.env, STATE_ROOT: opts.root }
  const { withBackoff } = await import(join(LIB, 'resilience', 'with-backoff.mjs'))
  const call = () => {
    const p = spawnSync(process.execPath, [script, ...scriptArgs], { encoding: 'utf8', env })
    if (p.stderr) process.stderr.write(p.stderr)
    return { result: lastJsonLine(p.stdout), exitCode: p.status, raw: p.stdout }
  }
  const out = await withBackoff(call)
  if (!out.result) fail(`no script-result line from ${basename(script)}`)
  process.stdout.write(JSON.stringify(out.result) + '\n')
  process.exit(out.exitCode ?? 1)
}

function classify(opts) {
  if (typeof opts.text !== 'string') refuse('usage: classify --text <error text> [--exit-code N]')
  const dir = mkdtempSync(join(tmpdir(), 'flow-classify-'))
  const file = join(dir, 'error.txt')
  writeFileSync(file, opts.text)
  const args = [join(LIB, 'resilience', 'classify-failure.mjs'), file]
  if (opts['exit-code'] !== undefined) args.push('--exit-code', String(opts['exit-code']))
  const p = spawnSync(process.execPath, args, { encoding: 'utf8' })
  process.stdout.write((p.stdout || '').trim().split('\n').pop() + '\n')
  process.exit(p.status ?? 1)
}

function sleep(opts) {
  const max = kinds.caps.waitCiSeconds.default
  const s = Math.max(0, Math.min(Number(opts.seconds) || 0, max))
  if (process.env.FLOW_FAKE_SLEEP !== '1') spawnSync('sleep', [String(s)])
  emit(0, { status: 'ok', slept: s })
}

function write(opts) {
  if (typeof opts.file !== 'string' || typeof opts.text !== 'string') refuse('usage: write --file <path> --text <text>')
  mkdirSync(dirname(resolve(opts.file)), { recursive: true })
  writeFileSync(resolve(opts.file), opts.text)
  emit(0, { status: 'ok', artifact: resolve(opts.file), bytes: Buffer.byteLength(opts.text) })
}

function push(opts) {
  if (typeof opts.cwd !== 'string' || typeof opts.branch !== 'string') refuse('usage: push --cwd <worktree> --branch <name>')
  const p = spawnSync('git', ['push', '-u', 'origin', opts.branch], { cwd: opts.cwd, encoding: 'utf8' })
  if (p.status !== 0) {
    const text = `${p.stderr || ''}${p.stdout || ''}`.trim()
    emit(1, { status: 'error', kind: 'script-error', reason: `push failed: ${text.split('\n').slice(-3).join(' | ')}` })
  }
  const h = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: opts.cwd, encoding: 'utf8' })
  emit(0, { status: 'ok', branch: opts.branch, headSha: h.stdout.trim() })
}

// The day sweep runs when the base moved since the last sweep, not only when a wave merged: a merge
// made outside the waves still needs sweeping.
function baseHead(opts) {
  if (typeof opts.cwd !== 'string' || typeof opts.base !== 'string' || typeof opts.root !== 'string')
    refuse('usage: base-head --cwd <repo> --base <branch> --root <STATE_ROOT>')
  const f = spawnSync('git', ['fetch', '-q', 'origin', opts.base], { cwd: opts.cwd, encoding: 'utf8' })
  if (f.status !== 0) emit(1, { status: 'error', kind: 'script-error', reason: `fetch failed: ${(f.stderr || '').trim().split('\n').pop()}` })
  const h = spawnSync('git', ['rev-parse', `origin/${opts.base}`], { cwd: opts.cwd, encoding: 'utf8' })
  if (h.status !== 0) emit(1, { status: 'error', kind: 'script-error', reason: `no origin/${opts.base}` })
  const mark = join(opts.root, 'sweep-sha')
  const lastSweepSha = existsSync(mark) ? readFileSync(mark, 'utf8').trim() || null : null
  emit(0, { status: 'ok', headSha: h.stdout.trim(), lastSweepSha })
}

function command(opts) {
  if (!opts.cwd || typeof opts.cmd !== 'string') refuse('usage: command --cwd <dir> --cmd <shell command>')
  const p = spawnSync('sh', ['-c', opts.cmd], { cwd: opts.cwd, encoding: 'utf8' })
  emit(0, { status: 'ok', state: p.status === 0 ? 'green' : 'red', exitCode: p.status })
}

// ------------------------------------------------------------------------------ args

function facts(profile) {
  const p = spawnSync('bash', [join(LIB, 'profile-facts.sh'), '--profile', profile, dirname(profile)], { encoding: 'utf8' })
  if (p.status === 4) refuse(`profile refused: ${(p.stderr || p.stdout).trim().split('\n').slice(-3).join(' | ')}`)
  if (p.status !== 0) fail(`profile-facts.sh exit ${p.status}: ${(p.stderr || '').trim()}`)
  return JSON.parse(p.stdout)
}

function routing(factsObj, root) {
  const f = join(root, 'facts.json')
  writeFileSync(f, JSON.stringify(factsObj))
  const p = spawnSync(process.execPath, [join(LIB, 'routing', 'resolve.mjs'), join(CORE, 'config', 'routing.json'), f], { encoding: 'utf8' })
  const r = lastJsonLine(p.stdout)
  if (!r || r.status !== 'ok') refuse(`routing refused: ${r ? r.reason : p.stderr}`)
  return r.routing
}

// The driver routes each lane call itself; it gets the catalogue, the lane policy and what was
// reachable at launch. A profile tier override is honoured by pinning the overriding model to the lane.
// The state also carries what the journals under `journalsRoot` say: measured scores
// (config/measured.json, or the file TILLER_MEASURED names), recent mean tokens per model and lane,
// and the models rate-limited within the last caps.cooldownMinutes.
function router(resolved, journalsRoot, c) {
  const read = f => JSON.parse(readFileSync(join(CORE, 'config', f), 'utf8'))
  const catalogue = withPrices(read('models.json'))
  for (const [lane, r] of Object.entries(resolved)) {
    const m = r.model && catalogue.models[r.model]
    if (m && !(m.pinnedLanes || []).includes(lane)) m.pinnedLanes = [...(m.pinnedLanes || []), lane]
  }
  const asOf = new Date().toISOString()
  const measuredPath = process.env.TILLER_MEASURED || join(CORE, 'config', 'measured.json')
  const measured = existsSync(measuredPath) ? JSON.parse(readFileSync(measuredPath, 'utf8')) : {}
  const bad = checkMeasured(measured)
  if (bad.length) refuse(`${measuredPath}: ${bad.join('; ')}`)
  const lines = existsSync(journalsRoot) ? journalsUnder(journalsRoot).journals.flatMap(readJournal) : []
  return { catalogue, lanes: read('lanes.json'), state: { asOf, runtimes: runtimeAvailability(), measured, recent: recentFrom(lines), cooldown: cooldownFrom(lines, asOf, c.cooldownMinutes) } }
}
function routingConfig() {
  const { tiers, budgetsUsd, concurrency } = JSON.parse(readFileSync(join(CORE, 'config', 'routing.json'), 'utf8'))
  return { tiers, budgetsUsd, concurrency }
}

// Quoted phrases in a `## gates` note that starts with `<gate name>:` are the texts that mean the
// bot did not really review. Rendered as literal, case-insensitive patterns.
export function skipPatterns(profileText, gateName) {
  const body = (profileText.split(/^## gates\s*$/m)[1] || '').split(/^## /m)[0]
  const bullets = []
  for (const line of body.split('\n')) {
    if (/^\s*-\s+/.test(line)) bullets.push(line)
    else if (/^\s+\S/.test(line) && bullets.length) bullets[bullets.length - 1] += ' ' + line.trim()
    else bullets.push('')
  }
  const out = []
  for (const b of bullets) {
    const m = /^\s*-\s+([\w-]+):/.exec(b)
    if (!m || m[1] !== gateName) continue
    for (const q of b.matchAll(/"([^"]+)"/g)) out.push(q[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
  return out
}

export function caps(factsObj) {
  const c = Object.fromEntries(Object.entries(kinds.caps).map(([k, v]) => [k, v.default]))
  const rp = factsObj.runPolicy || {}
  if (Number.isInteger(rp.fixRounds)) c.fixRounds = Math.min(rp.fixRounds, kinds.caps.fixRounds.max)
  if (Number.isInteger(rp.ciFix)) c.ciFix = Math.min(rp.ciFix, kinds.caps.ciFix.max)
  return c
}

// The profile names its hard-stop channels in prose. Absent, or "every outward channel", keeps all
// of them; otherwise a channel stays a hard stop only when the prose names it.
const CHANNEL_WORDS = {
  'chat-send': /chat send/i,
  'chat-schedule': /schedul/i,
  'email-send': /email send/i,
  'email-draft': /email draft/i,
  'calendar-write': /calendar/i,
  'public-comment': /comment/i,
}
export function hardStopChannels(factsObj) {
  const all = kinds.outwardChannels
  const prose = factsObj.ownerProxy && factsObj.ownerProxy.hardStopChannels
  if (Array.isArray(prose)) return all.filter(c => prose.includes(c))
  if (typeof prose !== 'string' || !prose.trim() || /every outward channel/i.test(prose)) return [...all]
  const named = all.filter(c => CHANNEL_WORDS[c].test(prose))
  return named.length ? named : [...all]
}

// Tools removed from every child the harness spawns, supervisor or driver lane alike.
export function outwardTools(factsObj, disallow = []) {
  const extra = [].concat(disallow || []).filter(x => typeof x === 'string')
  const channels = hardStopChannels(factsObj)
  // Children are claude processes, so role ops resolve to Claude tool names here. The defaults stay
  // blocked too: a role the profile rebinds or sets to none must not reopen the server it left.
  const pt = factsObj.tools || {}
  const named = [...resolveTools(outwardRoleOps(channels, pt), pt), ...resolveTools(outwardRoleOps(channels))]
    .map(t => t.startsWith('mcp:') ? claudeToolName(t) : t)
  return { channels, tools: [...new Set([...named, ...extra])] }
}

function schemas() {
  const dir = join(LIB, 'contract', 'schemas')
  const out = {}
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('lane-')) continue
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    delete s.$id
    out[f.replace(/^lane-|\.json$/g, '')] = s
  }
  return out
}

function rootFor(opts, profileName) {
  const run = opts.run || `${opts.ticket || basename(String(opts.spec || 'spec'), '.md')}-${opts.date}`
  return resolve(opts.root || process.env.STATE_ROOT || join(homedir(), '.claude', 'run-state', profileName, run))
}
// Where the profile's runs live: the journals routing state and calibration read. An explicit run
// root reads itself only, so a custom layout never picks up a stranger's journals.
const runStateFor = (opts, profileName, root) => resolve(process.env.TILLER_RUN_STATE || (opts.root || process.env.STATE_ROOT ? root : join(homedir(), '.claude', 'run-state', profileName)))

function common(opts) {
  if (!opts.profile || !opts.date) refuse('--profile and --date are required')
  const f = facts(resolve(opts.profile))
  const root = rootFor(opts, f.profile)
  mkdirSync(root, { recursive: true })
  const profileText = readFileSync(f.profilePath, 'utf8')
  const gates = (f.gates || []).map(g => g.source.type === 'bot' ? { ...g, skipPatterns: skipPatterns(profileText, g.name) } : g)
  const resolved = routing(f, root)
  return {
    root,
    base: {
      facts: { ...f, gates },
      date: opts.date,
      stateRoot: root,
      roots: { scratch: join(root, 'scratch'), diffs: join(root, 'diffs') },
      harnessBin: join(HERE, 'harness.mjs'),
      lib: LIB,
      routing: resolved,
      router: router(resolved, runStateFor(opts, f.profile, root), caps(f)),
      ...routingConfig(),
      caps: caps(f),
      kinds: Object.fromEntries(Object.entries(kinds.kinds).map(([k, v]) => [k, { escalate: v.escalate, ceiling: v.ceiling }])),
      awaiting: awaitingRules(),
      phases: kinds.phases,
      schemas: schemas(),
      hardStopChannels: hardStopChannels(f),
      disallowedTools: outwardTools(f, opts.disallow).tools,
    },
  }
}

function stateCli(root, ...a) {
  const p = spawnSync(process.execPath, [join(LIB, 'state', 'state.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root } })
  const r = lastJsonLine(p.stdout)
  if (!r || r.status !== 'ok') fail(`state.mjs ${a[0]}: ${r ? r.reason : p.stderr}`)
  return r
}

// `<KEY>-<first words of the summary>`; a short suffix only when the primary checkout already has
// the name as a local or remote-tracking branch (a relaunch whose earlier worktree still holds it).
function branchFor(ticket, summary, repo) {
  if (typeof summary !== 'string') return null
  const words = summary.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean)
  const key = ticket.toLowerCase().split('-')
  if (words.slice(0, key.length).join('-') === key.join('-')) words.splice(0, key.length)
  let slug = ''
  for (const w of words.slice(0, 6)) {
    const next = slug ? `${slug}-${w}` : w.slice(0, 40)
    if (next.length > 40) break
    slug = next
  }
  if (!slug) return null
  const name = `${ticket}-${slug}`
  const taken = b => repo && existsSync(repo) && [`refs/heads/${b}`, `refs/remotes/origin/${b}`]
    .some(ref => spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', ref]).status === 0)
  if (!taken(name)) return name
  for (;;) {
    const b = `${name}-${randomBytes(2).toString('hex')}`
    if (!taken(b)) return b
  }
}

// One ticket's own fields on top of the shared base. `item` is the CLI options or a day-queue entry.
function ticketEntry(base, root, item) {
  if (!item.ticket === !item.spec) refuse('exactly one of --ticket or --spec')
  const tracker = base.facts.tracker || { kind: 'none' }
  let ticket = item.ticket
  let spec = null
  if (item.spec) {
    if (tracker.kind !== 'none') refuse('--spec stands in for a ticket only when the profile tracker is none')
    const p = resolve(item.spec)
    if (!existsSync(p)) refuse(`spec not found: ${p}`)
    spec = { path: p, text: readFileSync(p, 'utf8').slice(0, 20000) }
    ticket = basename(p).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9-]+/g, '-').toUpperCase()
  } else {
    if (tracker.kind === 'none') refuse('the profile has no tracker: pass --spec <path> instead of --ticket')
    const key = String(ticket).split('-')[0]
    if (!(base.facts.jiraKeys || tracker.keys || []).includes(key)) refuse(`ticket key ${key} is not one of this profile's tracker keys`)
  }
  stateCli(root, 'init', ticket)
  const hold = item['hold-merge'] ?? item.holdMerge
  const match = item['test-match'] ?? item.testMatch
  return {
    ticket,
    spec,
    notes: [].concat(item.note || item.notes || []).filter(x => typeof x === 'string'),
    holdMerge: typeof hold === 'string',
    holdMergeReason: typeof hold === 'string' ? hold : null,
    testMatch: typeof match === 'string' ? match : null,
    // One branch per launch: a relaunch must never reuse a branch an earlier worktree still holds.
    branch: typeof item.branch === 'string' ? item.branch
      : branchFor(ticket, item.summary, (base.facts.repos || [])[0]?.path) || `${ticket}-run-${randomBytes(4).toString('hex')}`,
    branchGiven: typeof item.branch === 'string',
    worktreeRoot: join(root, 'worktrees'),
  }
}

// The Node driver is the only runner; args that name another one are refused rather than ignored.
const noDriverFlag = opts => { if (opts.driver !== undefined) refuse('--driver is gone: the Node driver is the only runner') }

// A proxy outside config/agents.json keeps a plain lane.
function roleAgents(f) {
  const roles = JSON.parse(readFileSync(join(CORE, 'config', 'agents.json'), 'utf8'))
  const proxy = f.ownerProxy && f.ownerProxy.role
  return { resolver: 'flow-resolver', ...(proxy && roles[proxy] ? { ownerProxy: proxy } : {}) }
}

function ticketArgs(opts) {
  if (!opts.ticket === !opts.spec) refuse('exactly one of --ticket or --spec')
  noDriverFlag(opts)
  const { root, base } = common(opts)
  const out = { ...base, ...ticketEntry(base, root, opts), agents: roleAgents(base.facts) }
  const file = join(root, `args-${out.ticket}.json`)
  writeFileSync(file, JSON.stringify(out))
  emit(0, { status: 'ok', ticket: out.ticket, stateRoot: root, artifact: file })
}

function drive(opts) {
  if (typeof opts.args !== 'string') refuse('usage: drive --args <args-<ticket>.json>')
  const p = spawnSync(process.execPath, [join(LIB, 'driver', 'drive.mjs'), '--args', resolve(opts.args)], { stdio: 'inherit' })
  process.exit(p.status ?? 1)
}

function resumeInline(opts) {
  if (!opts.root || !opts.ticket) refuse('usage: resume --root <STATE_ROOT> --ticket <KEY>')
  const root = resolve(opts.root)
  stateCli(root, 'init', opts.ticket)
  const r = stateCli(root, 'resume', opts.ticket)
  const run = JSON.parse(readFileSync(join(root, 'tickets', opts.ticket, 'run.json'), 'utf8'))
  const data = r.clean ? { startPhase: r.startPhase, outputs: {} } : JSON.parse(readFileSync(r.artifact, 'utf8'))
  emit(0, { status: 'ok', ticket: opts.ticket, runId: run.runId, clean: r.clean, startPhase: data.startPhase, outputs: data.outputs,
    resumes: r.resumes, cap: r.cap, capReached: r.capReached, runStatus: run.status, prUrl: run.prUrl || null })
}

function driveDay(opts) {
  if (typeof opts.args !== 'string') refuse('usage: drive-day --args <args-day.json>')
  const p = spawnSync(process.execPath, [join(LIB, 'driver', 'day.mjs'), '--args', resolve(opts.args)], { stdio: 'inherit' })
  process.exit(p.status ?? 1)
}

function dayArgs(opts) {
  if (!opts.queue) refuse('--queue <waves.json> is required')
  noDriverFlag(opts)
  const { root, base } = common({ ...opts, run: opts.run || `day-${opts.date}` })
  if (!base.facts.dayRunAllowed || !base.facts.ownerProxy) refuse('the profile has no ## owner proxy: an unattended day run is refused')
  const rp = base.facts.runPolicy || {}
  if (!Number.isInteger(rp.dayCeiling) || !Number.isInteger(rp.maxParallel)) refuse('## run policy must state dayCeiling and maxParallel')
  const raw = JSON.parse(readFileSync(resolve(opts.queue), 'utf8'))
  if (!Array.isArray(raw) || !raw.length || !raw.every(w => Array.isArray(w) && w.length))
    refuse('queue must be a non-empty array of non-empty waves')
  const waves = raw.map(w => w.map(t => ticketEntry(base, root, typeof t === 'string' ? { ticket: t } : t)))
  const seen = new Set()
  for (const t of waves.flat()) {
    if (seen.has(t.ticket)) refuse(`${t.ticket} is queued twice`)
    seen.add(t.ticket)
  }
  const out = { ...base, waves, agents: roleAgents(base.facts) }
  const file = join(root, 'args-day.json')
  writeFileSync(file, JSON.stringify(out))
  emit(0, { status: 'ok', stateRoot: root, waves: waves.length, tickets: seen.size, artifact: file })
}

// Environment for lib/supervisor/supervise.sh, rendered from the profile: the stop hour and the
// tools that reach an outward channel the profile keeps as a hard stop.
function superviseEnv(opts) {
  if (!opts.profile) refuse('--profile is required')
  const f = facts(resolve(opts.profile))
  const hour = /^(\d{1,2})(?::\d{2})?$/.exec(String((f.runPolicy || {}).stopHour ?? ''))
  const { channels, tools } = outwardTools(f, opts.disallow)
  emit(0, { status: 'ok', channels, env: { SUPERVISE_STOP_HOUR: hour ? String(Number(hour[1])) : '', SUPERVISE_DISALLOWED_TOOLS: tools.join(' ') } })
}

// Calibration over every run under the profile's run-state directory (lib/journal/calibrate.mjs).
function calibrate(opts) {
  if (!opts.profile) refuse('--profile is required')
  const f = facts(resolve(opts.profile))
  const dir = resolve(opts.root || process.env.TILLER_RUN_STATE || join(homedir(), '.claude', 'run-state', f.profile))
  const argv = [join(LIB, 'journal', 'calibrate.mjs'), '--root', dir, '--out', resolve(opts.out || join(CORE, 'config', 'measured.json'))]
  if (opts['min-n']) argv.push('--min-n', String(opts['min-n']))
  if (opts['dry-run']) argv.push('--dry-run')
  const p = spawnSync(process.execPath, argv, { encoding: 'utf8' })
  process.stdout.write(p.stdout)
  process.stderr.write(p.stderr || '')
  process.exit(p.status ?? 1)
}

// ------------------------------------------------------------------------------ main

const [cmd, ...argv] = process.argv.slice(2)
const { opts, rest } = parse(argv, ['note', 'disallow'])
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  switch (cmd) {
    case 'run': await run(opts, rest); break
    case 'classify': classify(opts); break
    case 'sleep': sleep(opts); break
    case 'command': command(opts); break
    case 'base-head': baseHead(opts); break
    case 'write': write(opts); break
    case 'push': push(opts); break
    case 'args': ticketArgs(opts); break
    case 'drive': drive(opts); break
    case 'day-args': dayArgs(opts); break
    case 'drive-day': driveDay(opts); break
    case 'resume': resumeInline(opts); break
    case 'supervise-env': superviseEnv(opts); break
    case 'calibrate': calibrate(opts); break
    default: refuse(`unknown command "${cmd}"`)
  }
}
