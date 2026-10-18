#!/usr/bin/env node
// The guided setup behind `tiller setup` and its single-step commands. Every step checks the world
// first and is skipped with one `ok` line when it is done; there is no state file.
//
//   wizard.mjs setup [--yes] [--answers <file.json>]
//   wizard.mjs login [claude|codex] [--yes] [--answers <file.json>]
//   wizard.mjs personal [new [<owner>] | clone <git-url|account> [<owner>]]
//   wizard.mjs project [new <name> <repo-dir|git-url> | clone <git-url> [<name>] | ask <name>]
//   wizard.mjs hooks
//
// Answers come from the answers file (one object keyed by step id), then --yes (every default),
// then a terminal prompt. No terminal and nothing else to answer with is exit 4, as in prereqs.sh.
// TILLER_INTERACTIVE=1 prompts on piped input too. TILLER_HELM_DIR replaces where the helm is
// looked for, for tests.
// Exit: 0 done, 1 a step failed (the command that repeats it is printed), 2 usage, 4 an answer is
// needed and there is no terminal to ask it on.

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, delimiter, dirname, join, resolve, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class StepFailed extends Error {
  constructor(message, resume) { super(message); this.resume = resume }
}
class NeedsAnswer extends Error {}

// On Windows an npm-installed CLI is only a .cmd shim, and Node spawns a shim only through cmd.exe.
export function launch(cmd, args, { platform = process.platform, path = process.env.PATH || '', exists = existsSync } = {}) {
  if (platform !== 'win32') return { cmd, args, shell: false }
  const dirs = path.split(';').filter(Boolean)
  const found = exts => dirs.some(d => exts.some(x => exists(win32.join(d, cmd + x))))
  if (found(['.exe', '.com']) || !found(['.cmd', '.bat'])) return { cmd, args, shell: false }
  return { cmd, args: args.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)), shell: true }
}

function spawn(cmd, args, opts) {
  const l = launch(cmd, args)
  return spawnSync(l.cmd, l.args, { ...opts, shell: l.shell })
}
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
let lines, reader
function readLine() {
  reader ??= createInterface({ input: process.stdin })
  lines ??= reader[Symbol.asyncIterator]()
  return lines.next().then(n => (n.done ? null : n.value.trim()))
}
// A sub-tool that asks its own questions needs the terminal to itself.
function closeReader() {
  reader?.close()
  reader = lines = undefined
}

export function context(opts) {
  const interactive = Boolean(process.stdin.isTTY) || process.env.TILLER_INTERACTIVE === '1'
  const ctx = {
    root: ROOT,
    interactive,
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
      const r = spawn(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', env: { ...process.env, ...env } })
      return { code: typeof r.status === 'number' ? r.status : 1, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' }
    },
  }
  return ctx
}

const prereqs = (ctx, ...args) => ctx.sh('bash', [join(ctx.root, 'lib', 'setup', 'prereqs.sh'), ...args], { capture: true })

export const tools = {
  id: 'tools',
  title: 'Tools',
  purpose: 'Installs the command-line tools tiller runs on: Node, git, jq, gh and Claude Code. Required.',
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
    const r = spawn('claude', ['auth', 'status'], { encoding: 'utf8' })
    try { v = JSON.parse(r.stdout).loggedIn === true } catch { v = null }
  } else v = spawn('codex', ['login', 'status'], { stdio: 'ignore' }).status === 0
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
  title: 'Agents',
  purpose: "Links tiller's skills into Claude Code, Codex or both, and signs you in. Required.",
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
  title: 'Private-access hook',
  purpose: "Adds a Claude Code hook that keeps a session out of other projects' profiles and notes. Required for Claude Code.",
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

// --- backup --------------------------------------------------------------------------------------

// A directory the wizard just created is offered a private GitHub repository. Nothing here stops
// the run: a refusal or a failed push leaves a note with the command to repeat by hand.
async function backup(ctx, step, dir, repoName, { gitignore = false } = {}) {
  const git = (...args) => ctx.sh('git', ['-C', dir, ...args], { capture: true })
  if (existsSync(join(dir, '.git')) && git('remote', 'get-url', 'origin').code === 0) return
  const later = account => `gh repo create ${account}/${repoName} --private --source ${dir} --push`
  // gh missing and gh signed out both fail here.
  if (ctx.sh('gh', ['auth', 'status'], { capture: true }).code !== 0) {
    ctx.notes.push(`back up ${dir} once gh is signed in: ${later('<account>')}`)
    return
  }
  if (!(await ctx.ask('backup', step, `Back up ${dir} to a private GitHub repository ${repoName}?`, true))) return
  // secrets.env sits next to the profile; only the .gitignore keeps it out of the push.
  if (gitignore) {
    const file = join(dir, '.gitignore')
    const listed = existsSync(file) && readFileSync(file, 'utf8').split('\n').some(l => l.trim() === 'secrets.env')
    if (!listed) {
      ctx.notes.push(`no backup: ${file} does not list secrets.env, so a push could carry a secret`)
      return
    }
  }
  const account = ctx.sh('gh', ['api', 'user', '--jq', '.login'], { capture: true }).stdout.trim()
  if (!existsSync(join(dir, '.git')) && git('init', '-q').code !== 0) return void ctx.notes.push(`git init in ${dir} failed; then ${later(account)}`)
  if (git('rev-parse', '--verify', '-q', 'HEAD').code !== 0) {
    if (git('add', '-A').code !== 0 || git('commit', '-qm', 'Initial commit').code !== 0) {
      return void ctx.notes.push(`commit ${dir}, then ${later(account)}`)
    }
  }
  if (ctx.sh('gh', ['repo', 'create', `${account}/${repoName}`, '--private', '--source', dir, '--push']).code !== 0) ctx.notes.push(later(account))
}

// --- personal --------------------------------------------------------------------------------------

const personalRoot = ctx => process.env.TILLER_PERSONAL_ROOT || join(ctx.root, 'personal')
const loginName = () => process.env.USER || process.env.USERNAME || userInfo().username
const owner = ctx => ctx.answers.personal?.owner || loginName()
// Personal skills go wherever the providers step linked tiller's own; with none chosen, Claude Code.
const targets = ctx => { const t = chosen(ctx); return t.length ? t : ['claude'] }
const target = ctx => (targets(ctx).length > 1 ? 'all' : targets(ctx)[0])
const skillsIn = dir => (existsSync(dir) ? readdirSync(dir).filter(s => existsSync(join(dir, s, 'SKILL.md'))) : [])
const isUrl = v => /[:/]/.test(v)

export const personal = {
  id: 'personal',
  title: 'Personal skills',
  purpose: 'Skills that belong to you rather than to a project, kept in personal/<you>/. Optional.',
  done(ctx) {
    const dir = join(personalRoot(ctx), owner(ctx), 'skills')
    if (!existsSync(dir)) return null
    const skills = skillsIn(dir)
    return targets(ctx).every(p => skills.every(s => exists(join(skillsDir(p), s)))) ? `personal/${owner(ctx)}: ${skills.length} skills linked` : null
  },
  resume(ctx) {
    const a = ctx.answers.personal || {}
    return a.mode === 'clone' ? `tiller personal clone ${a.url} ${owner(ctx)}` : `tiller personal new ${owner(ctx)}`
  },
  async run(ctx) {
    const who = owner(ctx)
    const dir = join(personalRoot(ctx), who)
    const install = ['bash', [join(ctx.root, 'install.sh'), '--target', target(ctx), '--personal', who, 'all']]
    if (existsSync(join(dir, 'skills'))) {
      if (ctx.sh(...install).code !== 0) throw new StepFailed(`linking personal/${who} failed`, `tiller install --personal ${who} all`)
      return
    }
    const mode = await ctx.ask('personal', 'mode', 'Personal skills: new, or clone an existing repository (new/clone)', 'new')
    ctx.answers.personal = { ...ctx.answers.personal, mode }
    if (mode === 'clone') {
      const given = await ctx.ask('personal', 'url', 'GitHub account or git URL of your personal repository', who)
      ctx.answers.personal.url = given
      const url = isUrl(given) ? given : `https://github.com/${given}/tiller-personal-${who}.git`
      if (ctx.sh('git', ['clone', url, dir]).code !== 0) throw new StepFailed(`cloning ${url} failed`, personal.resume(ctx))
      if (ctx.sh(...install).code !== 0) throw new StepFailed(`linking personal/${who} failed`, `tiller install --personal ${who} all`)
      return
    }
    if (mode !== 'new') throw new Usage(`personal.mode is new or clone, not ${mode}`)
    // The generator asks its own questions; without a terminal they come from the nested block.
    const generate = ctx.answers.personal?.generate
    const args = [join(ctx.root, 'install.sh'), '--target', target(ctx), '--setup-personal', who]
    let tmp
    if (generate) {
      tmp = join(mkdtempSync(join(tmpdir(), 'tiller-')), 'generate.json')
      writeFileSync(tmp, JSON.stringify(generate))
      args.push('--answers', tmp)
    } else if (!ctx.interactive) throw new NeedsAnswer('personal.generate: the answers for lib/personal/generate.mjs')
    else closeReader()
    try {
      if (ctx.sh('bash', args).code !== 0) throw new StepFailed(`generating personal/${who} failed`, personal.resume(ctx))
    } finally { if (tmp) rmSync(dirname(tmp), { recursive: true, force: true }) }
    await backup(ctx, 'personal', dir, `tiller-personal-${who}`)
  },
}

// --- project ---------------------------------------------------------------------------------------

const profilesRoot = ctx => process.env.TILLER_PROFILES_ROOT || process.env.TILLER_PROFILES_DIR || join(ctx.root, 'profiles')
const profileNames = ctx => {
  const root = profilesRoot(ctx)
  return existsSync(root) ? readdirSync(root).filter(n => !/^[._]/.test(n) && existsSync(join(root, n, 'profile.md'))).sort() : []
}
const facts = (ctx, name) => ctx.sh('bash', [join(ctx.root, 'lib', 'profile-facts.sh'), '--check', '--profile', join(profilesRoot(ctx), name, 'profile.md')], { capture: true })
const onboard = (ctx, args, opts) => ctx.sh('node', [join(ctx.root, 'lib', 'onboard', 'onboard.mjs'), ...args], opts)

function launchSafe(ctx, name) {
  const r = facts(ctx, name)
  if (r.code === 0) return true
  ctx.refusal = r.out
  return false
}

// Links the profile's skills when it ships any, then the gate: launch-safe or stop with ask.
function finishProfile(ctx, name) {
  if (skillsIn(join(profilesRoot(ctx), name, 'skills')).length) {
    const r = ctx.sh('bash', [join(ctx.root, 'install.sh'), '--target', target(ctx), '--profile', name, 'all'])
    if (r.code !== 0) throw new StepFailed(`linking the skills of profiles/${name} failed`, `tiller install --profile ${name} all`)
  }
  if (!launchSafe(ctx, name)) {
    console.log(ctx.refusal.trimEnd())
    throw new StepFailed(`profiles/${name} is not launch-safe yet`, `tiller project ask ${name}`)
  }
}

// secrets.env from the example when absent, at 600; the keys it leaves empty are the person's.
function seedSecrets(ctx, name) {
  const dir = join(profilesRoot(ctx), name)
  const file = join(dir, 'secrets.env')
  if (existsSync(file) || !existsSync(join(dir, 'secrets.env.example'))) return
  const text = readFileSync(join(dir, 'secrets.env.example'), 'utf8')
  writeFileSync(file, text, { mode: 0o600 })
  chmodSync(file, 0o600)
  const empty = text.split('\n').map(l => l.match(/^([A-Za-z_][A-Za-z0-9_]*)=\s*$/)?.[1]).filter(Boolean)
  if (empty.length) ctx.notes.push(`fill in profiles/${name}/secrets.env: ${empty.join(', ')}`)
}

const KINDS = ['code', 'document', 'notes']

async function newProfile(ctx) {
  const kind = await ctx.ask('project', 'kind', 'What is the project: code (an application), document (prose in git) or notes (no git procedure)', 'code')
  if (!KINDS.includes(kind)) throw new Usage(`project.kind is code, document or notes, not ${kind}`)
  ctx.answers.project.kind = kind
  const name = await ctx.ask('project', 'name', 'Project name (a short slug, e.g. the repository name)', undefined)
  if (!name) throw new NeedsAnswer('project.name: Project name')
  ctx.answers.project.name = name
  if (kind === 'notes') return notesBrain(ctx, name)
  let repo = await ctx.ask('project', 'repo', 'Repository directory, or a git URL to clone', process.cwd())
  if (!existsSync(repo)) {
    const into = resolve(process.cwd(), basename(repo).replace(/\.git$/, ''))
    if (ctx.sh('git', ['clone', repo, into]).code !== 0) throw new StepFailed(`cloning ${repo} failed`, `tiller project new ${name} ${repo}`)
    repo = into
  }
  repo = resolve(repo)
  // A repository root is one repository unless the answers say otherwise; only a plain directory is ambiguous.
  const folder = existsSync(join(repo, '.git')) && !Object.hasOwn(ctx.answers.project, 'folder') ? false
    : await ctx.ask('project', 'folder', `Is ${repo} a project folder holding several repositories?`, false)
  const repos = folder ? readdirSync(repo).sort().map(c => join(repo, c)).filter(d => existsSync(join(d, '.git'))) : [repo]
  if (!repos.length) throw new StepFailed(`${repo} holds no git repository yet; clone one into it first`, `tiller project new ${name} ${repo}`)
  // The resolver reads .tiller-profile at a repository root; a folder is covered by its glob instead.
  const marker = folder ? false : await ctx.ask('project', 'marker', `Write "${name}" to ${join(repo, '.tiller-profile')} so tiller finds the profile from there?`, true)
  const answers = kind === 'document'
    ? { 'identity.kind': 'document', 'tracker.kind': 'none', mergeAuthority: await ctx.ask('project', 'merge', 'Who may click merge: human or unconfirmed', 'human'), ...ctx.answers.project.answers }
    : ctx.answers.project.answers || {}
  const glob = folder ? ['--glob', `*/${basename(dirname(repo))}/${basename(repo)}`] : []
  if (![0, 4].includes(onboard(ctx, ['new', name, ...repos, ...glob]).code)) throw new StepFailed(`onboarding ${repo} failed`, `tiller project new ${name} ${repo}`)
  for (const [id, value] of Object.entries(answers)) {
    const r = onboard(ctx, ['answer', name, id, ...(Array.isArray(value) ? value.map(String) : [String(value)])], { capture: true })
    if (![0, 4].includes(r.code)) throw new StepFailed(`project.answers.${id}: ${r.out.trim()}`, `tiller project ask ${name}`)
  }
  if (ctx.interactive && !launchSafe(ctx, name)) { closeReader(); onboard(ctx, ['ask', name]) }
  if (marker) {
    writeFileSync(join(repo, '.tiller-profile'), `${name}\n`)
    ctx.notes.push(`${join(repo, '.tiller-profile')} is yours to commit`)
  }
  finishProfile(ctx, name)
  await backup(ctx, 'project', join(profilesRoot(ctx), name), `tiller-profiles-${name}`, { gitignore: true })
  ctx.next = `cd ${repo} && claude`
}

const brainsHome = ctx => process.env.TILLER_BRAINS_HOME || ctx.root
const LEVELS = ['none', 'read', 'write']
// The `_none` row of the access matrix: what every folder without a profile may use.
function granted(ctx, name) {
  try { return JSON.parse(readFileSync(join(brainsHome(ctx), 'brains', 'access.json'), 'utf8'))._none?.[name] || 'none' } catch { return 'none' }
}

function notesDone(ctx, name, p) {
  const stop = 'flow-* skills stop in its folder by design'
  if (p.brain === false) return `${name}: notes, no profile and no brain; ${stop}`
  const has = granted(ctx, name)
  if (!existsSync(join(brainsHome(ctx), 'brains', name)) || LEVELS.indexOf(has) < LEVELS.indexOf(p.access || 'read')) return null
  return `${name}: notes, no profile; brains/${name} is granted ${has} to folders without a profile; ${stop}`
}

// Notes want no git procedure: no profile, a brain instead, granted only through brain-access.sh.
async function notesBrain(ctx, name) {
  const want = await ctx.ask('project', 'brain', `Make a brain for ${name} (a local vault under brains/${name}, from brains/_template)?`, true)
  ctx.answers.project.brain = want
  if (!want) return
  const level = await ctx.ask('project', 'access', `What may folders without a profile do with brains/${name}: read or write`, 'read')
  if (!['read', 'write'].includes(level)) throw new Usage(`project.access is read or write, not ${level}`)
  ctx.answers.project.access = level
  const home = brainsHome(ctx)
  const dir = join(home, 'brains', name)
  if (!existsSync(dir)) {
    cpSync(join(ctx.root, 'brains', '_template'), dir, { recursive: true })
    if (ctx.sh('git', ['init', '-q', dir]).code !== 0) throw new StepFailed(`git init ${dir} failed`, `git init ${dir}`)
  }
  const r = ctx.sh('bash', [join(ctx.root, 'lib', 'brain-access.sh'), '--set', '_none', name, level], { env: { TILLER_HOME: home } })
  if (r.code !== 0) throw new StepFailed(`granting brains/${name} failed`, `TILLER_HOME=${home} lib/brain-access.sh --set _none ${name} ${level}`)
}

async function cloneProfile(ctx) {
  const url = await ctx.ask('project', 'url', 'Git URL of the profile repository', undefined)
  if (!url) throw new NeedsAnswer('project.url: Git URL of the profile repository')
  const name = ctx.answers.project.name || basename(url).replace(/\.git$/, '').replace(/^tiller-profiles-/, '')
  ctx.answers.project = { ...ctx.answers.project, url, name }
  const dir = join(profilesRoot(ctx), name)
  if (!existsSync(join(dir, 'profile.md')) && ctx.sh('git', ['clone', url, dir]).code !== 0) {
    throw new StepFailed(`cloning ${url} failed`, `tiller project clone ${url} ${name}`)
  }
  seedSecrets(ctx, name)
  finishProfile(ctx, name)
}

export const project = {
  id: 'project',
  title: 'Project',
  purpose: 'A profile for one project: its repositories, tracker and gates, so the flow skills know how to work there. Needed before working on a project.',
  done(ctx) {
    const p = ctx.answers.project || {}
    const names = profileNames(ctx)
    const want = p.name
    if (want && (p.kind === 'notes' || (!p.kind && !names.includes(want) && existsSync(join(brainsHome(ctx), 'brains', want))))) return notesDone(ctx, want, p)
    const ok = want ? names.includes(want) && launchSafe(ctx, want) : names.some(n => launchSafe(ctx, n))
    return ok ? `profiles: ${names.join(', ')}` : null
  },
  resume: ctx => (ctx.answers.project?.name && ctx.answers.project.kind !== 'notes' ? `tiller project ask ${ctx.answers.project.name}` : 'tiller project'),
  async run(ctx) {
    ctx.answers.project ??= {}
    const mode = await ctx.ask('project', 'mode', 'Project profile: new, or clone an existing profile repository (new/clone)', 'new')
    ctx.answers.project.mode = mode
    if (mode === 'new') return newProfile(ctx)
    if (mode === 'clone') return cloneProfile(ctx)
    throw new Usage(`project.mode is new or clone, not ${mode}`)
  },
}

export const optional = {
  id: 'optional',
  title: 'Helm',
  purpose: 'A private notes repository cloned into helm/. Optional.',
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
  for (const [i, step] of steps.entries()) {
    const before = step.done(ctx)
    if (before) { console.log(`ok       ${step.id.padEnd(10)} ${before}`); continue }
    console.log(`\nStep ${i + 1}/${steps.length}: ${step.title}\n${step.purpose}`)
    const result = await step.run(ctx)
    if (result === 'skip') continue
    const after = step.done(ctx)
    if (!after) throw new StepFailed(`${step.id} is still not done`, step.resume?.(ctx) || resume)
    console.log(`done     ${step.id.padEnd(10)} ${after}`)
  }
}

export const SETUP = [tools, providers, hook, personal, project, optional]

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
    case 'personal': {
      const [mode, ...args] = opts.pos
      const a = (ctx.answers.personal ??= {})
      if (mode === 'new') {
        if (args.length > 1) throw new Usage('personal new takes at most one owner')
        Object.assign(a, { mode }, args[0] && { owner: args[0] })
      } else if (mode === 'clone') {
        if (args.length < 1 || args.length > 2) throw new Usage('personal clone takes a git URL or GitHub account, then an optional owner')
        Object.assign(a, { mode, url: args[0] }, args[1] && { owner: args[1] })
      } else if (mode !== undefined) throw new Usage(`personal takes new or clone, not ${mode}`)
      await runSteps(ctx, [personal], 'tiller personal')
      notes()
      return 0
    }
    case 'project': {
      const [mode, ...args] = opts.pos
      const a = (ctx.answers.project ??= {})
      if (mode === 'ask') {
        if (args.length !== 1) throw new Usage('project ask takes one profile name')
        return onboard(ctx, ['ask', args[0]]).code
      }
      if (mode === 'new') {
        if (args.length !== 2) throw new Usage('project new takes a name and a repository directory or git URL')
        Object.assign(a, { mode, name: args[0], repo: args[1] })
      } else if (mode === 'clone') {
        if (args.length < 1 || args.length > 2) throw new Usage('project clone takes a git URL, then an optional name')
        Object.assign(a, { mode, url: args[0] }, args[1] && { name: args[1] })
      } else if (mode !== undefined) throw new Usage(`project takes new, clone or ask, not ${mode}`)
      await runSteps(ctx, [project], 'tiller project')
      notes()
      if (ctx.next) console.log(`\nNext: ${ctx.next}`)
      return 0
    }
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
  closeReader()
  process.stdin.destroy()
}
