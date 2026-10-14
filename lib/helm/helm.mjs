#!/usr/bin/env node
// Helm CLI; the only code that runs git in the helm. The helm is $TILLER_HELM_DIR or
// $TILLER_HOME/helm. Without one, record and session are silent no-ops so tiller behaves as before.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatEvent, newId, validate } from './events.mjs'
import { machineName } from './machine.mjs'

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

const commands = { init, record }
const [cmd, ...rest] = process.argv.slice(2)
if (!commands[cmd]) die(2, `usage: helm.mjs <${Object.keys(commands).join('|')}> ...`)
commands[cmd](opts(rest))
