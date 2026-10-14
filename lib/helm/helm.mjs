#!/usr/bin/env node
// Helm CLI; the only code that runs git in the helm. The helm is $TILLER_HELM_DIR or
// $TILLER_HOME/helm. Without one, record and session are silent no-ops so tiller behaves as before.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEvent, newId, parseFrontmatter, validate } from './events.mjs'
import { deriveState } from './state.mjs'
import { report, statusText } from './due.mjs'
import { formatMachine, machineName, parseMachine, refreshMachine } from './machine.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = process.env.TILLER_HOME || join(HERE, '..', '..')
const HELM = process.env.TILLER_HELM_DIR || join(HOME, 'helm')
const ME = machineName(process.env, hostname())
const now = () => new Date(process.env.TILLER_HELM_NOW || Date.now())

function die(code, msg) { process.stderr.write(`helm: ${msg}\n`); process.exit(code) }
const hasHelm = () => existsSync(join(HELM, '.git'))
const git = (args, timeout = 10000) => spawnSync('git', ['-C', HELM, ...args], { encoding: 'utf8', timeout })
const branch = () => git(['symbolic-ref', '--short', 'HEAD']).stdout.trim() || 'main'

// A pull that stops mid-rebase (helm.md edited on two machines) is aborted, so the clone stays usable.
function pull(timeout) {
  if (git(['pull', '--rebase', '--quiet', 'origin', branch()], timeout).status === 0) return true
  if (existsSync(join(HELM, '.git', 'rebase-merge')) || existsSync(join(HELM, '.git', 'rebase-apply'))) git(['rebase', '--abort'])
  return false
}
const push = timeout => git(['push', '--quiet', '-u', 'origin', branch()], timeout).status === 0
const commit = (paths, msg) => git(['add', '--', ...paths]).status === 0 && git(['commit', '--quiet', '-m', msg]).status === 0

function opts(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { o._.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) o[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i]
    else o[a.slice(2)] = true
  }
  return o
}

function init(o) {
  if (existsSync(HELM)) die(3, `${HELM} already exists`)
  mkdirSync(dirname(HELM), { recursive: true })
  if (typeof o.new === 'string') {
    cpSync(join(HERE, 'template'), HELM, { recursive: true })
    for (const a of [['init', '--quiet', '-b', 'main'], ['add', '-A'], ['commit', '--quiet', '-m', 'init helm'], ['remote', 'add', 'origin', o.new]]) {
      if (git(a).status !== 0) die(3, `git ${a[0]} failed`)
    }
    if (!push(30000)) process.stderr.write('helm: push failed; the next write retries it\n')
  } else {
    const url = o._[0]
    if (!url) die(2, 'usage: init <url> | init --new <url>')
    const r = spawnSync('git', ['clone', '--quiet', url, HELM], { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0) die(3, `clone failed: ${r.stderr.trim()}`)
  }
  if (commands.session) commands.session({ row: '_none', quiet: true })
  process.stderr.write('helm: ready. Run ./install.sh --hooks and merge the SessionStart fragment.\n')
}

function record(o) {
  if (!hasHelm()) return
  const e = { project: o.project, kind: o.kind, summary: o.summary, due: o.due, supersedes: o.supersedes, calendar_for: o['calendar-for'], source: o.source || 'manual', link: o.link }
  e.id = newId(now(), ME, randomBytes(3).toString('hex'))
  const err = validate(e)
  if (err) die(2, err)
  pull(5000)
  mkdirSync(join(HELM, 'events'), { recursive: true })
  const rel = join('events', `${e.id}.md`)
  writeFileSync(join(HELM, rel), formatEvent(e))
  if (!commit([rel], `event: ${e.id}`)) die(3, 'commit failed')
  if (!push(5000)) process.stderr.write('helm: offline, event kept locally\n')
  process.stdout.write(`${e.id}\n`)
}

function readDir(sub, parse) {
  const d = join(HELM, sub)
  if (!existsSync(d)) return []
  const out = []
  for (const f of readdirSync(d).filter(f => f.endsWith('.md')).sort()) {
    try {
      const v = parse(readFileSync(join(d, f), 'utf8'))
      const err = sub === 'events' ? validate(v) : v.machine ? null : 'missing machine'
      if (err) process.stderr.write(`helm: skipped ${sub}/${f}: ${err}\n`)
      else out.push(v)
    } catch (x) {
      process.stderr.write(`helm: skipped ${sub}/${f}: ${x.message}\n`)
    }
  }
  return out
}
const loadEvents = () => readDir('events', t => parseFrontmatter(t).fields)
const loadMachines = () => readDir('machines', parseMachine)

function config() {
  const f = join(HELM, 'helm.md')
  let fm = {}
  try { fm = parseFrontmatter(readFileSync(f, 'utf8')).fields } catch { /* a missing or bare helm.md keeps the defaults */ }
  return { tz: fm.timezone || 'UTC', staleDays: Number(fm.stale_days) || 7 }
}

function profiles() {
  const d = join(HOME, 'profiles')
  if (!existsSync(d)) return []
  return readdirSync(d).filter(n => !n.startsWith('_') && existsSync(join(d, n, 'profile.md')))
}

function caps() {
  const out = (process.env.TILLER_MACHINE_CAPS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (process.env.TILLER_HELM_DETECT_GH !== '0' && spawnSync('gh', ['auth', 'status'], { timeout: 3000 }).status === 0) out.push('gh')
  return out
}

// A worktree resolves to its main checkout, so one repository is one clone.
function mainCheckout(cwd) {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' })
  return r.status === 0 ? dirname(r.stdout.trim()) : null
}

function unpushed() {
  const r = git(['rev-list', '--count', '@{u}..HEAD'])
  return r.status === 0 ? Number(r.stdout.trim()) : 0
}

function session(o) {
  if (!hasHelm()) return
  const online = pull(2000)
  const row = o.row || '_none'
  const rel = join('machines', `${ME}.md`)
  const path = join(HELM, rel)
  let prev = null
  try { prev = existsSync(path) ? parseMachine(readFileSync(path, 'utf8')) : null } catch { prev = null }
  const next = refreshMachine(prev, { name: ME, today: now().toISOString().slice(0, 10), profiles: profiles(), caps: caps(), row, clone: row === '_none' ? null : mainCheckout(o.cwd || process.cwd()) }, existsSync)
  const text = formatMachine(next)
  if (!prev || formatMachine(prev) !== text) {
    mkdirSync(join(HELM, 'machines'), { recursive: true })
    writeFileSync(path, text)
    commit([rel], `machine: ${ME}`)
  }
  // Events left local by an earlier offline write go out here, not only on the next write.
  if (online && unpushed() > 0) push(2000)
  if (o.quiet) return
  const { tz, staleDays } = config()
  const lines = report(deriveState(loadEvents()), loadMachines(), { now: now(), tz, staleDays, project: row === '_none' ? null : row, self: ME, unpushed: unpushed(), offline: !online })
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`)
}

function status(o) {
  if (!hasHelm()) die(4, 'no helm (./install.sh --helm <url>, or --helm --new <url>)')
  pull(5000)
  const { tz, staleDays } = config()
  const state = deriveState(loadEvents())
  const machines = loadMachines()
  if (o.json) process.stdout.write(`${JSON.stringify({ self: ME, tz, staleDays, state, machines })}\n`)
  else process.stdout.write(statusText(state, machines, { tz, self: ME }))
}

function calendarPending() {
  if (!hasHelm()) die(4, 'no helm (./install.sh --helm <url>, or --helm --new <url>)')
  if (!caps().includes('calendar')) die(5, `machine ${ME} has no calendar capability (TILLER_MACHINE_CAPS)`)
  pull(5000)
  for (const [project, p] of Object.entries(deriveState(loadEvents()))) {
    for (const o of p.open) if (o.kind === 'deadline' && !o.calendared) process.stdout.write(`${JSON.stringify({ id: o.id, project, summary: o.summary, due: o.due })}\n`)
  }
}

const commands = { init, record, session, status, 'calendar-pending': calendarPending }
const [cmd, ...rest] = process.argv.slice(2)
if (!commands[cmd]) die(2, `usage: helm.mjs <${Object.keys(commands).join('|')}> ...`)
commands[cmd](opts(rest))
