#!/usr/bin/env node
// The guided setup behind `tiller setup` and its single-step commands. Every step checks the world
// first and is skipped with one `ok` line when it is done; there is no state file.
//
//   wizard.mjs setup [--yes] [--answers <file.json>]
//
// Answers come from the answers file (one object keyed by step id), then --yes (every default),
// then a terminal prompt. No terminal and nothing else to answer with is exit 4, as in prereqs.sh.
// TILLER_INTERACTIVE=1 prompts on piped input too. TILLER_HELM_DIR replaces where the helm is
// looked for, for tests.
// Exit: 0 done, 1 a step failed (the command that repeats it is printed), 2 usage, 4 an answer is
// needed and there is no terminal to ask it on.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
      return { code: typeof r.status === 'number' ? r.status : 1, out: (r.stdout || '') + (r.stderr || '') }
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
    if (!after) throw new StepFailed(`${step.id} is still not done`, resume)
    console.log(`done     ${step.id.padEnd(10)} ${after}`)
  }
}

export const SETUP = [tools, optional]

async function main(argv) {
  const [cmd, ...rest] = argv
  const opts = parse(rest)
  const ctx = context(opts)
  switch (cmd) {
    case 'setup':
      await runSteps(ctx, SETUP, 'tiller setup')
      verdict(ctx)
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
