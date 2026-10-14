#!/usr/bin/env node
// tiller: bring a machine to a working harness. See docs/superpowers/specs/2026-10-13-harness-onboarding-design.md.
//
//   tiller doctor [--json]
//   tiller apply [--yes] [--dry-run] [--agents claude,...] [--user <name>]
//   tiller status [--json]
//   tiller onboard [--personal <git-url>] [--user <name>] [--yes] [--dry-run] [--agents claude,...]
//   tiller uninstall [--yes] [--dry-run] [--agents claude,...]
//
// Exit: 0 done, 2 usage, 3 refused, 4 failed.
import { existsSync, readdirSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homeOf, probe } from '../lib/machine/probe.mjs'
import { capabilities } from '../lib/machine/capabilities.mjs'
import { runApply } from '../lib/apply/apply.mjs'
import { writeAtomic } from '../lib/apply/merge.mjs'
import { printStatus, runStatus } from '../lib/apply/status.mjs'
import { runUninstall } from '../lib/apply/uninstall.mjs'

export { homeOf }

const USAGE = 'usage: tiller doctor [--json] | tiller onboard [--personal <git-url>] [--user <name>] [--yes] [--dry-run] [--agents claude,...] | tiller apply [--yes] [--dry-run] [--agents claude,...] [--user <name>] | tiller status [--json] | tiller uninstall [--yes] [--dry-run] [--agents claude,...]'
const TILLER_HOME = dirname(dirname(fileURLToPath(import.meta.url)))

// Synchronous so the whole apply stays one synchronous pass; returns null at end of input.
function ttyPrompt(question) {
  process.stdout.write(question)
  const buf = Buffer.alloc(1)
  let line = ''
  for (;;) {
    let n
    try { n = readSync(0, buf, 0, 1) } catch (e) { if (e.code === 'EAGAIN') continue; return null }
    if (n === 0) return line || null
    const ch = buf.toString()
    if (ch === '\n') return line
    line += ch
  }
}

function context(overrides = {}) {
  const env = overrides.env ?? process.env
  return {
    env,
    platform: overrides.platform ?? process.platform,
    home: homeOf(env, overrides.platform ?? process.platform),
    tillerHome: TILLER_HOME,
    isTTY: Boolean(process.stdin.isTTY),
    prompt: ttyPrompt,
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
    ...overrides,
  }
}

function doctor(argv, ctx) {
  const p = probe({ platform: ctx.platform, env: ctx.env, home: ctx.home })
  const features = capabilities(p)
  if (argv.includes('--json')) {
    ctx.stdout(JSON.stringify({ probe: p, features }, null, 2) + '\n')
    return 0
  }
  for (const f of features) {
    let line = `${f.status.padEnd(12)}${f.label}`
    if (f.reason) line += ` - ${f.reason}`
    if (f.install.length) line += `; install: ${f.install.join('; ')}`
    ctx.stdout(line + '\n')
  }
  return 0
}

function parseApply(argv) {
  const opts = { yes: false, dryRun: false, agents: null, user: null, personal: null }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = () => inline ?? argv[++i]
    if (flag === '--yes') opts.yes = true
    else if (flag === '--dry-run') opts.dryRun = true
    else if (flag === '--agents') opts.agents = (value() ?? '').split(',').filter(Boolean)
    else if (flag === '--user') opts.user = value()
    else if (flag === '--personal') opts.personal = value()
    else return null
  }
  if ((opts.agents && !opts.agents.length) || opts.user === undefined || opts.personal === undefined) return null
  return opts
}

const stateHomeOf = ctx => ctx.env.TILLER_STATE_HOME || join(ctx.home, '.tiller')
const personalRootOf = ctx => ctx.env.TILLER_PERSONAL_ROOT || join(ctx.tillerHome, 'personal')

function machineUser(stateHome) {
  const file = join(stateHome, 'machine.json')
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).user ?? null : null } catch { return null }
}

function apply(argv, ctx) {
  const opts = parseApply(argv)
  if (!opts || opts.personal) {
    ctx.stderr(USAGE + '\n')
    return 2
  }
  return applyWith(opts, ctx)
}

function applyWith(opts, ctx) {
  const stateHome = stateHomeOf(ctx)
  const user = opts.user ?? machineUser(stateHome)
  const personalDir = user ? join(personalRootOf(ctx), user) : null
  try {
    const r = runApply({
      tillerHome: ctx.tillerHome, home: ctx.home, env: ctx.env, platform: ctx.platform, stateHome, personalDir,
      agents: opts.agents, yes: opts.yes, dryRun: opts.dryRun, isTTY: ctx.isTTY, prompt: ctx.prompt, out: ctx.stdout,
    })
    if (r.status === 'refused') {
      ctx.stderr(`tiller apply: refused: ${r.reason}\n`)
      return 3
    }
    const written = [...r.files, ...(r.links ? [`${r.links} skill links and agent files`] : [])]
    ctx.stdout(r.status === 'written' ? `written: ${written.join(', ') || 'personal layer'}\n` : `${r.status}\n`)
    return 0
  } catch (e) {
    ctx.stderr(`tiller apply: ${e.message}\n`)
    return 4
  }
}

function status(argv, ctx) {
  if (argv.some(a => a !== '--json')) {
    ctx.stderr(USAGE + '\n')
    return 2
  }
  try {
    const s = runStatus({ stateHome: stateHomeOf(ctx), platform: ctx.platform })
    if (argv.includes('--json')) ctx.stdout(JSON.stringify(s, null, 2) + '\n')
    else printStatus(s, ctx.stdout)
    return 0
  } catch (e) {
    ctx.stderr(`tiller status: ${e.message}\n`)
    return 4
  }
}

function uninstall(argv, ctx) {
  const opts = parseApply(argv)
  if (!opts || opts.user || opts.personal) {
    ctx.stderr(USAGE + '\n')
    return 2
  }
  try {
    const r = runUninstall({
      stateHome: stateHomeOf(ctx), agents: opts.agents, platform: ctx.platform,
      yes: opts.yes, dryRun: opts.dryRun, isTTY: ctx.isTTY, prompt: ctx.prompt, out: ctx.stdout,
    })
    if (r.status === 'refused') {
      ctx.stderr(`tiller uninstall: refused: ${r.reason}\n`)
      return 3
    }
    if (r.status !== 'unchanged') ctx.stdout(`${r.status === 'written' ? 'uninstalled' : r.status}\n`)
    return 0
  } catch (e) {
    ctx.stderr(`tiller uninstall: ${e.message}\n`)
    return 4
  }
}

// Profile directories set up from a profile.md that still lack their secrets.env; `_template` is the
// skeleton new profiles are copied from, not a profile.
function missingSecrets(roots) {
  return roots.flatMap(root => {
    const dir = join(root, 'profiles')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(n => !n.startsWith('_')).map(n => join(dir, n))
      .filter(p => existsSync(join(p, 'profile.md')) && !existsSync(join(p, 'secrets.env')))
  })
}

// Clone when absent, fast-forward when present; onboard never pushes.
function syncPersonal(url, dir, ctx) {
  const args = existsSync(dir) ? ['-C', dir, 'pull', '--ff-only', '--quiet'] : ['clone', '--quiet', url, dir]
  const r = spawnSync('git', args, { env: ctx.env, encoding: 'utf8' })
  if (r.error || r.status !== 0) throw new Error(`git ${args.includes('pull') ? 'pull --ff-only' : 'clone'} ${existsSync(dir) ? dir : url}: ${(r.stderr || r.error?.message || '').trim()}`)
  ctx.stdout(`personal: ${args.includes('pull') ? 'pulled' : 'cloned'} ${dir}\n`)
}

function onboard(argv, ctx) {
  const opts = parseApply(argv)
  if (!opts) {
    ctx.stderr(USAGE + '\n')
    return 2
  }
  const stateHome = stateHomeOf(ctx)
  const user = opts.user ?? machineUser(stateHome)
  if (opts.personal && !user) {
    ctx.stderr('tiller onboard: --personal needs --user <name> the first time\n')
    return 2
  }
  doctor([], ctx)
  try {
    const personalDir = join(personalRootOf(ctx), user ?? '')
    if (opts.personal && opts.dryRun) ctx.stdout(`personal: would ${existsSync(personalDir) ? 'pull' : 'clone'} ${personalDir}\n`)
    else if (opts.personal) syncPersonal(opts.personal, personalDir, ctx)
    if (opts.user && !opts.dryRun && opts.user !== machineUser(stateHome)) {
      const file = join(stateHome, 'machine.json')
      const machine = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
      writeAtomic(file, JSON.stringify({ ...machine, user: opts.user }, null, 2) + '\n')
    }
  } catch (e) {
    ctx.stderr(`tiller onboard: ${e.message}\n`)
    return 4
  }
  const code = applyWith(opts, ctx)
  if (code !== 0) return code
  const missing = missingSecrets([ctx.tillerHome, ...(user ? [join(personalRootOf(ctx), user)] : [])])
  for (const p of missing) ctx.stdout(`missing secrets.env: ${p}\n`)
  return 0
}

export function main(argv, overrides) {
  const ctx = context(overrides)
  const [cmd, ...rest] = argv
  if (cmd === 'doctor') return doctor(rest, ctx)
  if (cmd === 'onboard') return onboard(rest, ctx)
  if (cmd === 'apply') return apply(rest, ctx)
  if (cmd === 'status') return status(rest, ctx)
  if (cmd === 'uninstall') return uninstall(rest, ctx)
  ctx.stderr(USAGE + '\n')
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
