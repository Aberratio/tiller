#!/usr/bin/env node
// The guided setup behind `tiller setup` and its single-step commands. Every step checks the world
// first and is skipped with one `ok` line when it is done; there is no state file.
//
//   wizard.mjs setup [--yes] [--answers <file.json>]
//   wizard.mjs login [claude|codex] [--yes] [--answers <file.json>]
//   wizard.mjs hooks
//
// Answers come from the answers file (one object keyed by step id), then --yes (every default),
// then a terminal prompt. No terminal and nothing else to answer with is exit 4, as in prereqs.sh.
// TILLER_INTERACTIVE=1 prompts on piped input too. TILLER_HELM_DIR replaces where the helm is
// looked for, for tests.
// Exit: 0 done, 1 a step failed (the command that repeats it is printed), 2 usage, 4 an answer is
// needed and there is no terminal to ask it on.

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class StepFailed extends Error {
  constructor(message, resume) { super(message); this.resume = resume }
}
class NeedsAnswer extends Error {}
class Usage extends Error {}

function parse(argv) {
  const opts = { yes: false, answers: null, pos: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--yes' || a === '-y') opts.yes = true
    else if (a === '--answers') {
      const f = argv[++i]
      if (!f) throw new Usage('--answers needs a file')
      try { opts.answers = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { throw new Usage(`--answers ${f}: ${e.message}`) }
    } else if (a.startsWith('-')) throw new Usage(`unknown option ${a}`)
    else opts.pos.push(a)
  }
  return opts
}

// One line reader for the whole run: piped lines that arrive between two questions are kept.
let lines
function readLine() {
  lines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]()
  return lines.next().then(n => (n.done ? null : n.value.trim()))
}

export function context(opts) {
  const interactive = Boolean(process.stdin.isTTY) || process.env.TILLER_INTERACTIVE === '1'
  const ctx = {
    root: ROOT,
    yes: opts.yes,
    answers: opts.answers || {},
    notes: [],
    next: null,
    only: null,
    signedIn: {},
    // ask(step, key, question, default, { optional }): an optional question nobody can answer takes
    // its default instead of stopping the run.
    async ask(step, key, question, dflt, { optional = false } = {}) {
      const block = ctx.answers[step]
      if (block && Object.hasOwn(block, key)) return block[key]
      if (ctx.yes) return dflt
      if (!interactive) {
        if (optional) return dflt
        throw new NeedsAnswer(`${step}.${key}: ${question}`)
      }
      const shown = typeof dflt === 'boolean' ? (dflt ? 'Y/n' : 'y/N') : dflt ?? ''
      process.stdout.write(`${question}${shown === '' ? '' : ` [${shown}]`} `)
      const raw = await readLine()
      process.stdout.write('\n')
      if (raw === null || raw === '') return dflt
      if (typeof dflt === 'boolean') return /^y(es)?$/i.test(raw)
      return raw
    },
    sh(cmd, args, { capture = false, env = {} } = {}) {
      const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: { ...process.env, ...env } })
      return { code: typeof r.status === 'number' ? r.status : 1, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }
    },
  }
  return ctx
}

const prereqs = (ctx, ...args) => ctx.sh('bash', [join(ctx.root, 'lib', 'setup', 'prereqs.sh'), ...args], { capture: true })

export const tools = {
  id: 'tools',
  done: ctx => (prereqs(ctx, 'check').code === 0 ? 'every required tool present' : null),
  async run(ctx) {
    const plan = prereqs(ctx, 'plan')
    console.log(prereqs(ctx, 'check').out.trimEnd())
    console.log(`\nTo install what is missing:\n${plan.out.trimEnd().replace(/^/gm, '  ')}`)
    if (!(await ctx.ask('tools', 'install', 'Run these now?', true))) throw new StepFailed('required tools are missing')
    ctx.sh('bash', [join(ctx.root, 'lib', 'setup', 'prereqs.sh'), 'install', '--yes'])
  },
}

// --- providers -------------------------------------------------------------------------------------

export const PROVIDERS = ['claude', 'codex']
const home = () => process.env.HOME || homedir()
const onPath = cmd => (process.env.PATH || '').split(delimiter).some(d => d && ['', '.exe', '.cmd'].some(x => existsSync(join(d, cmd + x))))
const native = p => p.replaceAll('\\', '/')

function skillsDir(p) {
  return p === 'claude'
    ? process.env.CLAUDE_SKILLS_DIR || join(home(), '.claude', 'skills')
    : process.env.CODEX_SKILLS_DIR || join(home(), '.agents', 'skills')
}

const exists = p => { try { lstatSync(p); return true } catch { return false } }

// What `install.sh --target <p> all` leaves behind: a destination for every skill (one that is not
// ours is install.sh's to report, not ours to retry), TILLER_HOME where the agent reads it, and the
// two rc lines.
function linked(ctx, p) {
  const src = join(ctx.root, 'skills')
  const skills = readdirSync(src).filter(s => existsSync(join(src, s, 'SKILL.md')))
  if (!skills.every(s => exists(join(skillsDir(p), s)))) return false
  const me = native(ctx.root)
  if (p === 'claude') {
    try {
      const s = JSON.parse(readFileSync(process.env.CLAUDE_SETTINGS || join(home(), '.claude', 'settings.json'), 'utf8'))
      if (native(s.env?.TILLER_HOME || '') !== me) return false
    } catch { return false }
  } else {
    const f = process.env.CODEX_CONFIG || join(home(), '.codex', 'config.toml')
    if (!existsSync(f) || !readFileSync(f, 'utf8').split('\n').includes(`TILLER_HOME = "${me}"`)) return false
  }
  const rc = process.env.TILLER_SHELL_RC || join(home(), basename(process.env.SHELL || 'bash') === 'zsh' ? '.zshrc' : '.bashrc')
  const lines = existsSync(rc) ? readFileSync(rc, 'utf8').split('\n') : []
  return lines.includes(`export TILLER_HOME="${me}"  # tiller`) && lines.includes('export PATH="$TILLER_HOME/bin:$PATH"  # tiller')
}

// true, false, or null when the CLI has no status command that answers.
function signedIn(ctx, p) {
  if (Object.hasOwn(ctx.signedIn, p)) return ctx.signedIn[p]
  let v
  if (p === 'claude') {
    const r = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' })
    try { v = JSON.parse(r.stdout).loggedIn === true } catch { v = null }
  } else v = spawnSync('codex', ['login', 'status'], { stdio: 'ignore' }).status === 0
  return (ctx.signedIn[p] = v)
}

function chosen(ctx) {
  if (ctx.only) return [ctx.only]
  const use = ctx.answers.providers?.use
  if (use !== undefined) return parseProviders(use)
  return PROVIDERS.filter(onPath)
}

function parseProviders(v) {
  const list = (Array.isArray(v) ? v : String(v).split(/[\s,]+/)).filter(Boolean).flatMap(p => (p === 'both' ? PROVIDERS : [p]))
  for (const p of list) if (!PROVIDERS.includes(p)) throw new Usage(`unknown provider ${p} (expected ${PROVIDERS.join(', ')} or both)`)
  return [...new Set(list)]
}

function installCli(ctx, p) {
  if (p === 'claude') {
    // The same installer lines prereqs.sh plans.
    const windows = prereqs(ctx, 'os').out.trim() === 'windows'
    const line = windows ? 'powershell.exe -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"' : 'curl -fsSL https://claude.ai/install.sh | bash'
    if (ctx.sh('bash', ['-c', line]).code !== 0) throw new StepFailed('installing Claude Code failed', 'tiller login claude')
    // Its installer puts the CLI in ~/.local/bin and leaves PATH to a new shell.
    const local = join(home(), '.local', 'bin')
    if (!onPath('claude') && existsSync(join(local, 'claude'))) process.env.PATH = `${local}${delimiter}${process.env.PATH}`
  } else if (ctx.sh('npm', ['install', '-g', '@openai/codex']).code !== 0) throw new StepFailed('installing Codex failed', 'tiller login codex')
  if (!onPath(p)) throw new StepFailed(`${p} is installed but this terminal cannot see it yet; open a new terminal`, `tiller login ${p}`)
}

export const providers = {
  id: 'providers',
  done(ctx) {
    const list = chosen(ctx)
    const ready = list.length > 0 && list.every(p => onPath(p) && linked(ctx, p) && signedIn(ctx, p) === true)
    return ready ? `${list.join(', ')} linked and signed in` : null
  },
  resume: ctx => `tiller login${ctx.only ? ` ${ctx.only}` : ''}`,
  async run(ctx) {
    if (!ctx.only) {
      const found = PROVIDERS.filter(onPath)
      const dflt = (found.length ? found : ['claude']).join(',')
      ctx.answers.providers = { ...ctx.answers.providers, use: parseProviders(await ctx.ask('providers', 'use', 'Providers to connect (claude, codex, both)', dflt)) }
    }
    for (const p of chosen(ctx)) {
      if (!onPath(p)) installCli(ctx, p)
      if (!linked(ctx, p) && ctx.sh('bash', [join(ctx.root, 'install.sh'), '--target', p, 'all']).code !== 0) {
        throw new StepFailed(`linking the skills for ${p} failed`, `tiller install --target ${p} all`)
      }
      const before = signedIn(ctx, p)
      if (before === true) continue
      const login = p === 'claude' ? ['claude', ['auth', 'login']] : ['codex', ['login']]
      if (ctx.sh(...login).code !== 0) throw new StepFailed(`signing in to ${p} failed`, `tiller login ${p}`)
      // A CLI with no status command: the login's own exit 0 is the only answer there is.
      if (before === null) ctx.signedIn[p] = true
      else delete ctx.signedIn[p]
    }
  },
}

// --- hook ------------------------------------------------------------------------------------------

const settingsFile = () => process.env.CLAUDE_SETTINGS || join(home(), '.claude', 'settings.json')

// Our two entries from `install.sh --hooks`, keyed by event, with the file name each one runs; an
// entry running the same file from another checkout is replaced, since one machine runs one.
function fragment(ctx) {
  ctx.hooks ??= (() => {
    const r = ctx.sh('bash', [join(ctx.root, 'install.sh'), '--hooks'], { capture: true })
    if (r.code !== 0) throw new StepFailed('install.sh --hooks failed', 'tiller hooks')
    return JSON.parse(r.stdout).hooks
  })()
  return ctx.hooks
}
const hookFile = cmd => (cmd.match(/\/lib\/hooks\/([\w-]+\.sh)/) || [])[1]

function readSettings(f) {
  if (!existsSync(f)) return {}
  try { return JSON.parse(readFileSync(f, 'utf8') || '{}') } catch {
    throw new StepFailed(`${f} is not valid JSON; fix it, or merge the output of  tiller install --hooks  into it by hand`, 'tiller hooks')
  }
}

const mineIn = (s, f) => Object.entries(f).every(([ev, groups]) => (s.hooks?.[ev] || []).some(g => (g.hooks || []).some(h => h.command === groups[0].hooks[0].command)))

export const hook = {
  id: 'hook',
  done(ctx) {
    if (!mineIn(readSettings(settingsFile()), fragment(ctx))) return null
    return `private-access hook in ${settingsFile()}${onPath('codex') ? '; Codex has no hook' : ''}`
  },
  resume: () => 'tiller hooks',
  async run(ctx) {
    const file = settingsFile()
    const s = readSettings(file)
    s.hooks ??= {}
    for (const [ev, groups] of Object.entries(fragment(ctx))) {
      const want = groups[0].hooks[0].command
      const name = hookFile(want)
      const kept = []
      for (const g of s.hooks[ev] || []) {
        const hooks = (g.hooks || []).filter(h => {
          const stale = h.command !== want && hookFile(h.command || '') === name
          if (stale) console.log(`replaced: ${h.command}`)
          return !stale
        })
        if (hooks.length) kept.push({ ...g, hooks })
      }
      s.hooks[ev] = kept.some(g => g.hooks.some(h => h.command === want)) ? kept : [...kept, ...groups]
    }
    const tmp = `${file}.tiller.${process.pid}`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`)
    renameSync(tmp, file)
    ctx.notes.push('restart open Claude Code sessions so they load the hook')
  },
}

export const optional = {
  id: 'optional',
  done: ctx => (existsSync(process.env.TILLER_HELM_DIR || join(ctx.root, 'helm')) ? 'helm present' : null),
  async run(ctx) {
    const url = await ctx.ask('optional', 'helm', 'Git URL of a private helm to clone (empty: none)', '', { optional: true })
    if (!url) return 'skip'
    const r = ctx.sh('bash', [join(ctx.root, 'install.sh'), '--helm', url])
    if (r.code !== 0) throw new StepFailed('cloning the helm failed', `tiller install --helm ${url}`)
  },
}

export function verdict(ctx) {
  const r = ctx.sh('bash', [join(ctx.root, 'bin', 'doctor')], { env: { TILLER_HOME: ctx.root } })
  if (r.code !== 0) throw new StepFailed('doctor found a required check failing', 'tiller doctor')
  console.log('\nReady.')
  for (const n of ctx.notes) console.log(`  still yours: ${n}`)
  console.log('  optional: a brain (a private notes vault), see brains/_template/README.md')
  if (ctx.next) console.log(`\nNext: ${ctx.next}`)
}

// runSteps: each step's done-condition first; a step that ran must leave it true.
export async function runSteps(ctx, steps, resume) {
  for (const step of steps) {
    const before = step.done(ctx)
    if (before) { console.log(`ok       ${step.id.padEnd(10)} ${before}`); continue }
    const result = await step.run(ctx)
    if (result === 'skip') continue
    const after = step.done(ctx)
    if (!after) throw new StepFailed(`${step.id} is still not done`, step.resume?.(ctx) || resume)
    console.log(`done     ${step.id.padEnd(10)} ${after}`)
  }
}

export const SETUP = [tools, providers, hook, optional]

async function main(argv) {
  const [cmd, ...rest] = argv
  const opts = parse(rest)
  const ctx = context(opts)
  const notes = () => { for (const n of ctx.notes) console.log(`  still yours: ${n}`) }
  switch (cmd) {
    case 'setup':
      await runSteps(ctx, SETUP, 'tiller setup')
      verdict(ctx)
      return 0
    case 'login':
      if (opts.pos.length > 1) throw new Usage('login takes at most one provider')
      if (opts.pos.length) ctx.only = parseProviders(opts.pos[0]).join()
      await runSteps(ctx, [providers], 'tiller login')
      notes()
      return 0
    case 'hooks':
      if (opts.pos.length) throw new Usage(`hooks takes no arguments: ${opts.pos.join(' ')}`)
      await runSteps(ctx, [hook], 'tiller hooks')
      notes()
      return 0
    default:
      throw new Usage(`unknown command ${cmd}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  try {
    process.exitCode = await main(argv)
  } catch (e) {
    if (e instanceof Usage) { console.error(`tiller: ${e.message}`); process.exitCode = 2 }
    else if (e instanceof NeedsAnswer) {
      console.error(`tiller: needs an answer and there is no terminal to ask on: ${e.message}`)
      console.error('  rerun on a terminal, with --yes for every default, or with --answers <file.json>')
      process.exitCode = 4
    } else if (e instanceof StepFailed) {
      console.error(`tiller: ${e.message}`)
      console.error(`  resume: ${e.resume || `tiller ${argv[0]}`}`)
      process.exitCode = 1
    } else throw e
  }
  lines?.return?.()
  process.stdin.destroy()
}
