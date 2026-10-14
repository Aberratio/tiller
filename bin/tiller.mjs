#!/usr/bin/env node
// tiller: bring a machine to a working harness. See docs/superpowers/specs/2026-10-13-harness-onboarding-design.md.
//
//   tiller doctor [--json]
//   tiller apply [--yes] [--dry-run] [--agents claude,...] [--user <name>]
//
// Exit: 0 done, 2 usage, 3 refused, 4 failed.
import { existsSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probe } from '../lib/machine/probe.mjs'
import { capabilities } from '../lib/machine/capabilities.mjs'
import { runApply } from '../lib/apply/apply.mjs'
import { printStatus, runStatus } from '../lib/apply/status.mjs'

const USAGE = 'usage: tiller doctor [--json] | tiller apply [--yes] [--dry-run] [--agents claude,...] [--user <name>] | tiller status [--json]'
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
const LATER = new Set(['onboard', 'uninstall'])

function context(overrides = {}) {
  const env = overrides.env ?? process.env
  return {
    env,
    platform: process.platform,
    home: env.HOME || env.USERPROFILE || homedir(),
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
  const opts = { yes: false, dryRun: false, agents: null, user: null }
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s)
    const value = () => inline ?? argv[++i]
    if (flag === '--yes') opts.yes = true
    else if (flag === '--dry-run') opts.dryRun = true
    else if (flag === '--agents') opts.agents = (value() ?? '').split(',').filter(Boolean)
    else if (flag === '--user') opts.user = value()
    else return null
  }
  if ((opts.agents && !opts.agents.length) || opts.user === undefined) return null
  return opts
}

function machineUser(stateHome) {
  const file = join(stateHome, 'machine.json')
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).user ?? null : null } catch { return null }
}

function apply(argv, ctx) {
  const opts = parseApply(argv)
  if (!opts) {
    ctx.stderr(USAGE + '\n')
    return 2
  }
  const stateHome = ctx.env.TILLER_STATE_HOME || join(ctx.home, '.tiller')
  const user = opts.user ?? machineUser(stateHome)
  const personalDir = user ? join(ctx.env.TILLER_PERSONAL_ROOT || join(ctx.tillerHome, 'personal'), user) : null
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
    const s = runStatus({ stateHome: ctx.env.TILLER_STATE_HOME || join(ctx.home, '.tiller') })
    if (argv.includes('--json')) ctx.stdout(JSON.stringify(s, null, 2) + '\n')
    else printStatus(s, ctx.stdout)
    return 0
  } catch (e) {
    ctx.stderr(`tiller status: ${e.message}\n`)
    return 4
  }
}

export function main(argv, overrides) {
  const ctx = context(overrides)
  const [cmd, ...rest] = argv
  if (cmd === 'doctor') return doctor(rest, ctx)
  if (cmd === 'apply') return apply(rest, ctx)
  if (cmd === 'status') return status(rest, ctx)
  if (LATER.has(cmd)) {
    ctx.stderr(`tiller ${cmd}: not available yet\n`)
    return 2
  }
  ctx.stderr(USAGE + '\n')
  return 2
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
