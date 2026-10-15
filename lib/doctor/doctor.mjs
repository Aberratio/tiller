#!/usr/bin/env node
// `tiller doctor`: one verdict line per requirement of the harness on this machine.
//
//   doctor.mjs [--json] [--dir <working dir>]
//
// Exit 0 when every required check passes (warnings allowed), 1 otherwise.
import { accessSync, constants, readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { delimiter, join, relative, basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { agentsStatus } from '../agents/install-agents.mjs'

export const CORE = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
// The one place the Node floor lives; there is no package.json to carry an engines field.
export const NODE_FLOOR = '20.11.0'

export function which(name, env = process.env) {
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p } catch {}
  }
  return null
}

const parse = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
export function atLeast(version, floor) {
  const a = parse(version), b = parse(floor)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

export function checkNode(version = process.version) {
  return atLeast(version, NODE_FLOOR)
    ? { name: 'node', status: 'ok', required: true, detail: `${version} (>= ${NODE_FLOOR})` }
    : { name: 'node', status: 'fail', required: true, detail: `${version} is below ${NODE_FLOOR}` }
}

// Shell files under lib/ and skills/ that call jq, found by scanning so the list cannot go stale.
export function jqUsers(core = CORE) {
  const out = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); continue }
      if (!e.name.endsWith('.sh')) continue
      const code = readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
      if (/(^|[\s|$(`;&])jq(\s|$)/m.test(code)) out.push(relative(core, p))
    }
  }
  for (const top of ['lib', 'skills']) walk(join(core, top))
  return out.sort()
}

function binary(name, env, { required, why, missing }) {
  const p = which(name, env)
  if (p) return { name, status: 'ok', required, detail: p }
  return { name, status: required ? 'fail' : 'warn', required, detail: `not found; ${missing}`, ...(why ? { neededBy: why } : {}) }
}

function tillerHome(env, core) {
  const h = env.TILLER_HOME
  if (!h) return { name: 'TILLER_HOME', status: 'fail', required: true, detail: `unset; export TILLER_HOME=${core}` }
  if (!existsSync(join(h, 'lib', 'resolve-profile.sh'))) {
    return { name: 'TILLER_HOME', status: 'fail', required: true, detail: `${h} is not a tiller checkout (no lib/resolve-profile.sh)` }
  }
  return { name: 'TILLER_HOME', status: 'ok', required: true, detail: h }
}

function profile(env, core, dir) {
  const r = spawnSync('bash', [join(core, 'lib', 'resolve-profile.sh'), dir], { encoding: 'utf8', env })
  if (r.status === 0) {
    const name = basename(dirname(r.stdout.trim()))
    if (!name.startsWith('_')) return { name: 'profile', status: 'ok', required: false, detail: `${name} for ${dir}` }
    return { name: 'profile', status: 'warn', required: false, detail: `${dir} resolves to template ${name}; flow-* skills stop here` }
  }
  return { name: 'profile', status: 'warn', required: false, detail: `none for ${dir}; flow-* skills stop here (set TILLER_PROFILE or add .tiller-profile)` }
}

function agents(core) {
  let s
  try { s = agentsStatus({ core }) } catch (e) { return { name: 'agents', status: 'warn', required: false, detail: e.message } }
  const total = s.installed.length + s.missing.length + s.foreign.length
  if (s.installed.length === total) return { name: 'agents', status: 'ok', required: false, detail: `${total}/${total} roles in ${s.dir}` }
  const bits = [`${s.installed.length}/${total} roles in ${s.dir}`]
  if (s.missing.length) bits.push(`missing ${s.missing.join(', ')}; run node lib/agents/install-agents.mjs`)
  if (s.foreign.length) bits.push(`not harness-generated: ${s.foreign.join(', ')}`)
  return { name: 'agents', status: 'warn', required: false, detail: bits.join('; ') }
}

export function doctor({ env = process.env, core = CORE, dir = process.cwd(), nodeVersion = process.version } = {}) {
  const jq = jqUsers(core)
  const keepAwake = which('caffeinate', env) || which('systemd-inhibit', env)
  const checks = [
    checkNode(nodeVersion),
    binary('git', env, { required: true, missing: 'worktrees, branches and every repo fact need it' }),
    binary('bash', env, { required: true, missing: 'every lib/*.sh script needs it' }),
    binary('jq', env, { required: true, why: jq, missing: `needed by ${jq.join(', ')}` }),
    binary('gh', env, { required: false, missing: 'needed only for PR phases (open, CI, review, merge)' }),
    binary('claude', env, { required: false, missing: 'lanes cannot run; dry-run only' }),
    binary('codex', env, { required: false, missing: 'optional runtime (unverified)' }),
    keepAwake
      ? { name: 'keep-awake', status: 'ok', required: false, detail: keepAwake }
      : { name: 'keep-awake', status: 'warn', required: false, detail: 'neither caffeinate nor systemd-inhibit found; an unattended run may stall when the machine sleeps' },
    tillerHome(env, core),
    profile(env, core, dir),
    agents(core),
  ]
  return { ok: checks.every(c => !c.required || c.status === 'ok'), checks }
}

export function render({ ok, checks }) {
  const w = Math.max(...checks.map(c => c.name.length))
  const lines = checks.map(c => `${c.status.padEnd(4)}  ${c.name.padEnd(w)}  ${c.detail}`)
  lines.push(ok ? 'doctor: all required checks pass' : 'doctor: a required check failed')
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--dir')
  const result = doctor(i === -1 ? {} : { dir: argv[i + 1] })
  process.stdout.write(argv.includes('--json') ? JSON.stringify(result) + '\n' : render(result))
  process.exit(result.ok ? 0 : 1)
}
