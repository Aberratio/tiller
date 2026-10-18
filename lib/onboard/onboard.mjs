#!/usr/bin/env node
// Onboard a project into the harness: detect what scripts can read, ask a human the rest, render
// the profile, and later report where the profile drifted from the repos.
//
//   onboard.mjs new <name> <repo-dir>... [--project "<Name>"] [--glob <glob>]... [--no-network] [--force]
//   onboard.mjs questions <name> [--json] [--all]
//   onboard.mjs answer <name> <question-id> <value>...
//   onboard.mjs ask <name>                      interactive, in the terminal, no model involved
//   onboard.mjs render <name> [--refresh] [--no-network]
//   onboard.mjs drift <name> [--no-network] [--stale-days N]
//
// `new` scaffolds profiles/<name>/ with lib/new-profile.sh, then writes profile.md, detected.json and
// answers.json in it, and cases.json while nobody has edited it. TILLER_PROFILES_DIR replaces the
// profiles directory, for tests.
// Exit: 0 done (render: launch-safe), 2 usage, 3 refused, 4 profile still refused by profile-facts,
// 5 drift found (a difference between profile and repos, or a stale date; TODOs and facts that
// could not be compared are printed as notes and do not fail).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { detect } from './detect.mjs'
import { questions, render, secretIn, siblingValues } from './profile.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROFILES = process.env.TILLER_PROFILES_DIR || join(ROOT, 'profiles')
const TEMPLATE = join(ROOT, 'profiles', '_template')
const MARKER = /^onboarding: generated/m
const today = () => process.env.ONBOARD_TODAY || new Date().toISOString().slice(0, 10)

const NAME = /^[a-z0-9][a-z0-9-]*$/
function paths(name) {
  if (!NAME.test(name || '')) die(2, 'profile name: lowercase letters, digits and dashes')
  const dir = join(PROFILES, name)
  return { name, dir, md: join(dir, 'profile.md'), detected: join(dir, 'detected.json'), answers: join(dir, 'answers.json'), cases: join(dir, 'cases.json') }
}
const readJson = (p, dflt) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt)
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
function die(code, msg) { console.error(`onboard: ${msg}`); process.exit(code) }
// A refused answer; `ask` re-asks it, the `answer` subcommand turns it into an exit code.
class Refusal extends Error { constructor(code, msg) { super(msg); this.code = code } }
// The untouched copy new-profile.sh leaves is not hand-written: onboarding may fill it.
const freshTemplate = (name) => readFileSync(join(TEMPLATE, 'profile.md'), 'utf8').replace(/^profile: <name>$/m, `profile: ${name}`)
const handWritten = (p) => existsSync(p.md) && !MARKER.test(readFileSync(p.md, 'utf8')) && readFileSync(p.md, 'utf8') !== freshTemplate(p.name)

// A flag that takes a value must not swallow the next flag: `--stale-days --no-network` would
// otherwise set the days to `--no-network` and quietly turn the network back on.
const takes = (flag, v) => (v === undefined || v.startsWith('--') ? die(2, `${flag} needs a value`) : v)

function parse(argv) {
  const flags = { glob: [] }
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x === '--glob') flags.glob.push(takes(x, argv[++i]))
    else if (x === '--project' || x === '--stale-days') flags[x.slice(2)] = takes(x, argv[++i])
    else if (x.startsWith('--')) flags[x.slice(2)] = true
    else pos.push(x)
  }
  return { flags, pos }
}

function siblings(exceptName) {
  const texts = readdirSync(PROFILES).filter(f => !f.startsWith('_') && f !== exceptName && existsSync(join(PROFILES, f, 'profile.md')))
    .map(f => readFileSync(join(PROFILES, f, 'profile.md'), 'utf8'))
  return siblingValues(texts)
}

function check(mdPath) {
  const r = spawnSync('bash', [join(ROOT, 'lib', 'profile-facts.sh'), '--check', '--profile', mdPath], { encoding: 'utf8' })
  // A spawn failure or a signal leaves status null, and exit(null) would read as launch-safe.
  return { code: typeof r.status === 'number' ? r.status : 4, out: (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : '') }
}

// What the last render left in each section. The marker line says a render overwrites the file, so
// a hand edit under it is not refused - but it is named before it goes, section by section.
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
function sectionDigests(text) {
  const out = {}
  for (const part of text.split(/^(?=## )/m)) out[(/^## (.*)$/m.exec(part) || [, 'front matter'])[1]] = digest(part)
  return out
}
function warnOverwrite(md, was) {
  if (!was || !existsSync(md)) return
  const now = sectionDigests(readFileSync(md, 'utf8'))
  const changed = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(k => now[k] !== was[k])
  if (changed.length) console.error(`${md}: hand edits are being overwritten in ${changed.join(', ')}; delete the \`onboarding: generated\` line first to keep them`)
}

function writeProfile(name, { quiet = false } = {}) {
  const p = paths(name)
  const stored = readJson(p.detected, null)
  if (!stored) die(3, `no ${p.detected}; run \`new\` first`)
  if (handWritten(p)) die(3, `${p.md} is hand-written now (no \`onboarding: generated\` line); use \`drift ${name}\``)
  const answers = readJson(p.answers, {})
  // answers.json is a file a hand or a model can edit between two renders; it is re-checked here.
  const all = allQuestions(stored.repos, answers)
  for (const [id, value] of Object.entries(strip(answers))) {
    const q = all.find(x => x.id === id)
    if (!q) continue // a question the current tracker answer closed; render ignores it too
    try { validate(q, id, value, { tty: (answers._tty || []).includes(id) }) }
    catch (e) { if (!(e instanceof Refusal)) throw e; die(3, `${p.answers}: ${e.message}`) }
  }
  let text
  try { text = render({ name, project: stored.project, globs: stored.globs, dets: stored.repos, answers: strip(answers), today: today(), template: readFileSync(join(TEMPLATE, 'profile.md'), 'utf8'), toolRoles: toolRoles() }) }
  catch (e) { die(3, e.message) }
  const leak = secretIn(text)
  if (leak) die(3, `refusing to write a profile containing what looks like a credential (${leak})`)
  const headings = text.match(/^## .*$/gm) || []
  const twice = headings.find((h, i) => headings.indexOf(h) !== i)
  if (twice) die(3, `refusing to write a profile with \`${twice}\` twice; profile-facts would read both as one section`)
  warnOverwrite(p.md, stored.renderedSections)
  writeFileSync(p.md, text)
  stored.renderedSections = sectionDigests(text)
  writeCases(p, stored, strip(answers).mergeAuthority || 'unconfirmed')
  writeDetected(p.detected, stored)
  const c = check(p.md)
  const open = questions(stored.repos, strip(answers), siblings(name)).filter(q => q.required && !q.answered)
  if (!quiet) {
    console.log(`wrote ${p.md}`)
    console.log(c.out.split('\n').filter(l => /MISSING|Launch-safe|refused/.test(l)).join('\n'))
    if (open.length) console.log(`\n${open.length} decision(s) open: ${open.map(q => q.id).join(', ')}\n  answer: onboard.mjs ask ${name}   (or: onboard.mjs questions ${name})`)
  }
  return c.code
}

// Roles a profile's `## tools` may set; the tracker's kind lives in `## tracker`.
const toolRoles = () => Object.keys(readJson(join(ROOT, 'config', 'tool-kinds.json'), { roles: {} }).roles).filter(r => r !== 'tracker')

// cases.json pins a path to the authority the profile gives it. The template's example and the
// file a previous render wrote follow the answer; a file someone edited since is theirs.
function writeCases(p, stored, who) {
  const now = existsSync(p.cases) ? readFileSync(p.cases, 'utf8') : null
  if (now !== null && now !== readFileSync(join(TEMPLATE, 'cases.json'), 'utf8') && digest(now) !== stored.casesDigest) return
  const text = JSON.stringify({ cases: [{ path: 'README.md', who }] }, null, 2) + '\n'
  writeFileSync(p.cases, text)
  stored.casesDigest = digest(text)
}

const strip = (answers) => Object.fromEntries(Object.entries(answers).filter(([k]) => !k.startsWith('_')))

function cmdNew(name, dirs, flags) {
  const p = paths(name)
  if (!dirs.length) die(2, 'name at least one repo directory')
  if (handWritten(p)) die(3, `${p.md} exists and is hand-written; use \`drift ${name}\``)
  if (!flags.force) {
    for (const d of dirs) {
      const r = spawnSync('bash', [join(ROOT, 'lib', 'resolve-profile.sh'), resolve(d)], { encoding: 'utf8', env: { ...process.env, TILLER_PROFILE: '', TILLER_OVERLAY: '', TILLER_PROFILES_DIR: PROFILES } })
      if (r.status === 0 && basename(dirname(r.stdout.trim())) !== name) die(3, `${d} already resolves to ${r.stdout.trim()}; use \`drift\` on that profile, or --force`)
      // 1 is "no profile matches"; anything else (a .tiller-profile naming a missing profile) is a claim to look at.
      if (r.status !== 0 && r.status !== 1) die(3, `${d}: ${r.stderr.trim()}; fix it, or --force`)
    }
  }
  // Answers carry merge authority and gates; they move to a different set of repos only on purpose.
  const prior = readJson(p.detected, null)
  const kept = Object.keys(strip(readJson(p.answers, {})))
  if (!prior && kept.length && !flags.force) {
    die(3, `${name} has ${kept.length} answer(s) (${kept.join(', ')}) but no ${p.detected} to say which repos they were made for; delete ${p.answers}, or --force to keep them`)
  }
  if (prior && kept.length && !flags.force) {
    const was = prior.repos.map(r => r.path).sort().join('\n')
    const now = dirs.map(d => spawnSync('git', ['-C', resolve(d), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim() || resolve(d)).sort().join('\n')
    if (was !== now) die(3, `${name} already has ${kept.length} answer(s) for other repos (${prior.repos.map(r => r.name).join(', ')}); pick another name, or --force to keep them`)
  }
  if (kept.length) console.error(`keeping ${kept.length} earlier answer(s): ${kept.join(', ')}`)
  const repos = dirs.map(d => {
    console.error(`detecting ${d} ...`)
    // A directory that is not a readable clone is a refusal with its reason, not a stack trace.
    try { return detect(resolve(d), { network: !flags['no-network'], today: today() }) }
    catch (e) { die(3, `${d}: ${e.message}`) }
  })
  // Parent and clone name, as the existing profiles write them: `*/api` alone would claim every clone called api.
  if (!existsSync(p.dir)) {
    const r = spawnSync('bash', [join(ROOT, 'lib', 'new-profile.sh'), name], { encoding: 'utf8', env: { ...process.env, TILLER_PROFILES_DIR: PROFILES } })
    if (r.status !== 0) die(3, `new-profile.sh: ${(r.stderr || r.error?.message || '').trim()}`)
  }
  const globs = flags.glob.length ? flags.glob : repos.map(r => `*/${basename(dirname(r.path))}/${basename(r.path)}`)
  writeDetected(p.detected, { project: flags.project || name, globs, repos, renderedSections: prior?.renderedSections, casesDigest: prior?.casesDigest })
  if (!existsSync(p.answers)) writeJson(p.answers, { _dates: {} })
  process.exit(writeProfile(name))
}

function writeDetected(path, stored) {
  const leak = secretIn(JSON.stringify(stored))
  if (leak) die(3, `refusing to write ${path}: a detected value looks like a credential (${leak})`)
  writeJson(path, stored)
}

const CLOSED = ['identity.kind', 'tracker.kind', 'branching.integrateMain', 'mergeAuthority', 'commits']

// Every rule an answer must satisfy, wherever it came from: the `answer` and `ask` subcommands
// check it before storing, and a render checks it again, so a hand-edited answers.json is held to
// the same rules as a typed answer.
function validate(q, id, value, { tty = false } = {}) {
  const values = Array.isArray(value) ? value : [value]
  const leak = secretIn(values.join(' '))
  if (leak) throw new Refusal(3, `that answer looks like a credential (${leak}); a profile names where a secret lives, never its value`)
  // A newline would let one answer write a second `## owner proxy` or `## merge authority` section.
  if (values.some(v => /[\x00-\x1f\x7f]/.test(v))) throw new Refusal(2, `${id}: one line per value, no control characters`)
  if (id !== 'inviolables' && values.some(v => /[`|]/.test(v))) throw new Refusal(2, `${id}: no backticks or | — the value lands in a code span or a table cell`)
  if (Boolean(q.multi) !== Array.isArray(value)) throw new Refusal(2, `${id}: ${q.multi ? 'a list of values' : 'a single value'}`)
  if (CLOSED.includes(id) && !q.options.some(o => o.value === value)) throw new Refusal(2, `${id}: one of ${q.options.map(o => o.value).join(', ')}`)
  // Handing merges to the agent is typed by a human at a terminal, never relayed by a model.
  if (id === 'mergeAuthority' && value === 'agent' && !tty) throw new Refusal(3, 'mergeAuthority: agent is set only by a human running `ask` in a terminal')
  if (id === 'gates' && value.some(v => !/^(check|bot|command): \S/.test(v))) throw new Refusal(2, 'gates: each value is `check: <name>`, `check: *`, `bot: <login>` or `command: <cmd>`')
  if (id === 'identity.jiraKey' && !/^[A-Z][A-Z0-9]+$/.test(value)) throw new Refusal(2, 'identity.jiraKey: an uppercase project key, e.g. ABC')
  if (/runPolicy\./.test(id) && !/^[1-9]\d*$/.test(value)) throw new Refusal(2, `${id}: a positive integer`)
  if (id === 'tracker.qaStatuses' && value.length > 1 && value.includes('none')) throw new Refusal(2, 'tracker.qaStatuses: statuses, or the single value none')
  if (id === 'inviolables' && value.join('') !== 'none' && value.some(v => !/source:/i.test(v))) throw new Refusal(2, 'inviolables: each item ends with "Source: <where it is written>", or the single value none')
}

// Questions as setAnswer and writeProfile both need them: every id reachable, not only the ones
// the current tracker answer leaves open.
const allQuestions = (repos, answers) => questions(repos, { ...strip(answers), 'tracker.kind': answers['tracker.kind'] ?? 'jira' })

function setAnswer(name, id, values, { tty = false } = {}) {
  const p = paths(name)
  const stored = readJson(p.detected, null)
  if (!stored) die(3, `no ${p.detected}; run \`new\` first`)
  if (handWritten(p)) die(3, `${p.md} is hand-written now; edit it by hand`)
  const answers = readJson(p.answers, { _dates: {} })
  const all = allQuestions(stored.repos, answers)
  const q = all.find(x => x.id === id)
  if (!q) throw new Refusal(2, `unknown question ${id}; one of: ${all.map(x => x.id).join(', ')}`)
  const value = q.multi ? values : values.join(' ')
  validate(q, id, value, { tty })
  answers[id] = value
  answers._dates = { ...(answers._dates || {}), [id]: today() }
  // Which answers a human typed at a terminal: the only provenance a later render can read. It sits
  // in the file it polices, so it records provenance rather than enforcing it - a hand that can add
  // an id here can also delete the `onboarding: generated` marker and write the merge table itself.
  answers._tty = [...new Set([...(answers._tty || []).filter(x => x !== id), ...(tty ? [id] : [])])]
  writeJson(p.answers, answers)
}

function cmdQuestions(name, flags) {
  const p = paths(name)
  const stored = readJson(p.detected, null)
  if (!stored) die(3, `no ${p.detected}; run \`new\` first`)
  const qs = questions(stored.repos, strip(readJson(p.answers, {})), siblings(name)).filter(q => flags.all || !q.answered)
  if (flags.json) { console.log(JSON.stringify(qs, null, 2)); return }
  for (const q of qs) {
    console.log(`${q.required ? '*' : ' '} ${q.id}${q.multi ? ' (several)' : ''}: ${q.question}`)
    for (const o of q.options) console.log(`    - ${o.value}  ${o.description || ''}`)
  }
  if (!qs.length) console.log('nothing open')
}

async function cmdAsk(name) {
  const p = paths(name)
  const stored = readJson(p.detected, null)
  if (!stored) die(3, `no ${p.detected}; run \`new\` first`)
  const rl = createInterface({ input: process.stdin })
  // An iterator, not rl.question: piped lines that arrive between two questions are kept.
  const lines = rl[Symbol.asyncIterator]()
  const skipped = new Set()
  // The project kind is chosen before onboarding (by `answer` or the setup wizard): asked here it
  // would come first and change every existing code walk-through.
  for (;;) {
    const q = questions(stored.repos, strip(readJson(p.answers, {})), siblings(name)).find(x => !x.answered && !skipped.has(x.id) && x.prompted !== false)
    if (!q) break
    console.log(`\n${q.required ? '[required] ' : ''}${q.question}`)
    q.options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label} — ${o.description || ''}`))
    const hint = q.multi ? 'numbers separated by commas, or text items separated by " ;; "' : 'a number or your own value'
    process.stdout.write(`  (${hint}; empty = skip for now) > `)
    const next = await lines.next()
    if (next.done) break
    const raw = next.value.trim()
    if (!raw) { console.log('  skipped — it stays TODO'); skipped.add(q.id); continue }
    const pickOne = (s) => (/^\d+$/.test(s) && q.options[+s - 1] ? q.options[+s - 1].value : s)
    const values = q.multi ? (raw.includes(';;') ? raw.split(';;') : raw.split(',')).map(s => pickOne(s.trim())).filter(Boolean) : [pickOne(raw)]
    try { setAnswer(name, q.id, values, { tty: Boolean(process.stdin.isTTY) }) } catch (e) { if (!(e instanceof Refusal)) throw e; console.log(`  ${e.message} — asked again`); continue }
    writeProfile(name, { quiet: true })
  }
  rl.close()
  process.exit(writeProfile(name))
}

// Every `<pm> run <script>` in one `&&` chain, with the directory it actually runs in: a `cd` moves
// only the steps after it, so `cd a && npm run x && cd b && npm run y` is two scripts in two
// packages. A step the profile cannot resolve to a literal directory, or that names a workspace
// member rather than the directory it stands in, comes back with a reason instead of a base.
function runSteps(span, start) {
  const out = []
  let base = start || null
  let unresolved = null
  for (const step of span.replace(/^`|`$/g, '').split('&&').map(x => x.trim())) {
    const cd = /^cd (?:"([^"]*)"|'([^']*)'|(\S+))$/.exec(step)
    if (cd) {
      const raw = cd[1] ?? cd[2] ?? cd[3]
      const to = raw.replace(/^(~|\$HOME)(?=\/|$)/, process.env.HOME || '')
      // `cd $REPO/web` is a variable this reader cannot expand; joining it literally would compare
      // a directory that does not exist and call it drift.
      if (/[$`*?]/.test(to)) { unresolved = raw; continue }
      if (isAbsolute(to)) { base = to; unresolved = null }
      else if (!unresolved) base = base && join(base, to)
      continue
    }
    const m = /^(?:npm|pnpm|yarn|bun) run\b(.*)$/.exec(step)
    if (!m) continue
    const { script, workspace } = runArgs(m[1])
    if (unresolved) out.push({ reason: `\`cd ${unresolved}\` is not a literal path` })
    else if (workspace) out.push({ reason: 'it runs in a workspace member, not in the directory it stands in' })
    else if (!script) continue // bare `npm run` lists the scripts, it calls none
    else if (!base) out.push({ reason: 'no repo to run it in' })
    else out.push({ base, script })
  }
  return out
}

// The script name among a run's arguments: the first word that is not a flag, and not a flag's
// value. `npm run -w pkg build` named `-w` as the script before this looked at the flags.
function runArgs(rest) {
  const words = rest.trim().split(/\s+/).filter(Boolean)
  let script = null
  let workspace = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === '--') break // everything after is the script's own argv
    if (!w.startsWith('-')) { script ??= w; continue }
    if (/^(--workspace|--filter|-w|-F)$/.test(w)) { workspace = true; i++ } // takes the next word
    else if (/^(--workspaces?|--filter)(=|$)/.test(w)) workspace = true
  }
  return { script, workspace }
}

// Where the profile and the repos disagree now. Reads only; a finding is a line to act on.
function cmdDrift(name, flags) {
  const md = existsSync(name) && statSync(name).isFile() ? resolve(name) : paths(name).md
  if (!existsSync(md)) die(3, `no profile ${md}`)
  const text = readFileSync(md, 'utf8')
  const findings = []
  const notes = []
  const section = (h) => (new RegExp(`^## ${h}\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm').exec(text) || [])[1] || ''
  // Same rows profile-facts.sh reads: every table line after the header, separator skipped.
  const repoRows = section('repos').split('\n').filter(l => /^\|/.test(l) && !/^\|[ :|-]*-[ :|-]*\|$/.test(l)).slice(1).map(l => l.split('|').map(c => c.trim().replace(/`/g, '')))
  // `Number('soon')` is NaN and every comparison against it is false, which would turn the
  // staleness gate off instead of refusing the flag.
  if (flags['stale-days'] !== undefined && !/^\d+$/.test(flags['stale-days'])) die(2, '--stale-days: a whole number of days')
  const staleDays = Number(flags['stale-days'] ?? 90)
  const dates = [...text.matchAll(/measured (\d{4}-\d{2}-\d{2})/g)].map(x => x[1])
  const old = dates.filter(d => (Date.parse(today()) - Date.parse(d)) / 864e5 > staleDays)
  if (old.length) findings.push(`stale: ${old.length} fact(s) measured more than ${staleDays} days ago (oldest ${old.sort()[0]})`)
  const commands = text.match(/`(?:cd [^`]*&& )?(?:npm|pnpm|yarn|bun|bundle|uv|poetry|go|cargo)[^`]*`/g) || []
  // The Source cell of the gates table, exactly: `check: build` must not be answered by a declared
  // `check: build-and-test`.
  const gateSources = new Set(section('gates').split('\n').filter(l => /^\|/.test(l))
    .map(l => (l.split('|')[2] || '').trim().replace(/`/g, '')).filter(Boolean))
  // Nothing compared is not "no drift": an unreadable table fails like a difference.
  if (!repoRows.length) findings.push('no repo rows parsed from `## repos` (expected `| repo | path | role | main |`); no repo was compared')
  const repoDirs = []
  const repoByName = new Map()
  for (const row of repoRows) {
    const [, repo, path, , main] = row
    const dir = path.replace(/^~/, process.env.HOME)
    if (!existsSync(dir)) { findings.push(`${repo}: local path ${path} does not exist`); continue }
    repoDirs.push(dir)
    // Rows elsewhere name a repo by its full slug or by its clone name.
    repoByName.set(repo, dir)
    repoByName.set(repo.split('/').pop(), dir)
    let d
    try { d = detect(dir, { network: !flags['no-network'], today: today() }) } catch (e) { findings.push(`${repo}: ${e.message}`); continue }
    // A prose cell ("staging, then main") is a human's description, not one branch to compare.
    if (d.mainBranch.value && /^[\w./-]+$/.test(main) && main !== 'TODO' && main !== 'n/a' && main !== d.mainBranch.value) findings.push(`${repo}: main is ${d.mainBranch.value} on origin/HEAD, profile says ${main}`)
    if (d.mainBranch.value && main === 'TODO') notes.push(`${repo}: fill main with \`${d.mainBranch.value}\` (origin/HEAD)`)
    if (!d.mainBranch.value) notes.push(`${repo}: main branch not compared — ${d.mainBranch.reason}`)
    // An unread forge is "not compared", never "no difference": it is printed, but does not fail.
    if (!d.forge?.available) notes.push(`${repo}: required checks and review bots not compared — ${d.forge?.reason || 'forge not read'}`)
    else for (const [k, label] of [['requiredChecks', 'required checks'], ['reviewBots', 'review bots']]) if (d.forge[k]?.value == null) notes.push(`${repo}: ${label} not compared — ${d.forge[k]?.reason || 'not read'}`)
    for (const req of d.forge?.requiredChecks?.value || []) {
      if (!gateSources.has('check: *') && !gateSources.has(`check: ${req}`)) findings.push(`${repo}: required check \`${req}\` on ${d.mainBranch.value} is not a declared gate`)
    }
    for (const b of d.forge?.reviewBots?.value || []) {
      const login = b.login.replace(/\[bot\]$/, '')
      if (b.prs >= 3 && !gateSources.has(`bot: ${login}`)) findings.push(`${repo}: review bot \`${login}\` active on ${b.prs} recent PRs is not a declared gate`)
    }
    for (const p of d.toolchain.packages) {
      for (const [, cmd] of [...p.test, ...p.static]) {
        const core = cmd.replace(/^cd [^&]*&& /, '')
        if (!commands.some(c => c.includes(core))) findings.push(`${repo}: detected \`${cmd}\` is not in the profile`)
      }
    }
    for (const [glob] of d.toolchain.generated) if (!section('generated files').includes(glob)) findings.push(`${repo}: lockfile \`${glob}\` is not in ## generated files`)
  }
  // A relative `cd` is relative to the repo the table row names, or to the profile's only repo —
  // its only repo, not its only readable clone: with one of two clones missing the surviving one
  // must not inherit the other's commands.
  const onlyRepo = () => (repoRows.length === 1 ? repoDirs[0] : null)
  for (const line of text.split('\n')) {
    const rowRepo = (/^\| `([^`]+)`/.exec(line) || [])[1]
    for (const [c] of line.matchAll(/`(?:cd [^`]*&& )?(?:npm|pnpm|yarn|bun)[^`]*`/g)) {
      for (const run of runSteps(c, repoByName.get(rowRepo) || onlyRepo())) {
        if (run.reason) { notes.push(`command ${c} not compared — ${run.reason}`); continue }
        const pkg = join(run.base, 'package.json')
        if (!existsSync(pkg)) findings.push(`command ${c} runs in ${tildePath(run.base)}, which has no package.json`)
        else if (!(readJson(pkg, {}).scripts || {})[run.script]) findings.push(`command ${c} calls a script ${run.script} that ${tildePath(pkg)} no longer has`)
      }
    }
  }
  const todos = (text.match(/TODO/g) || []).length
  if (todos) notes.push(`${todos} TODO(s) left in the profile`)
  console.log(findings.length ? findings.map(f => `- ${f}`).join('\n') : notes.length ? 'no drift in what was compared' : 'no drift')
  if (notes.length) console.log(notes.map(n => `  note: ${n}`).join('\n'))
  process.exit(findings.length ? 5 : 0)
}
const tildePath = (p) => p.replace(process.env.HOME, '~')

const [cmd, ...rest] = process.argv.slice(2)
const { flags, pos } = parse(rest)
switch (cmd) {
  case 'new': cmdNew(pos[0], pos.slice(1), flags); break
  case 'questions': cmdQuestions(pos[0], flags); break
  case 'answer':
    if (pos.length < 3) die(2, 'answer <name> <question-id> <value>...')
    try { setAnswer(pos[0], pos[1], pos.slice(2)) } catch (e) { if (e instanceof Refusal) die(e.code, e.message); throw e }
    process.exit(writeProfile(pos[0]))
  case 'ask': await cmdAsk(pos[0]); break
  case 'render': {
    const p = paths(pos[0])
    if (handWritten(p)) die(3, `${p.md} is hand-written now; use drift`)
    if (flags.refresh) {
      const stored = readJson(p.detected, null)
      if (!stored) die(3, `no ${p.detected}`)
      try { stored.repos = stored.repos.map(r => detect(r.path, { network: !flags['no-network'], today: today() })) }
      catch (e) { die(3, `--refresh: ${e.message}`) }
      writeDetected(p.detected, stored)
    }
    process.exit(writeProfile(pos[0]))
  }
  case 'drift': cmdDrift(pos[0], flags); break
  default: die(2, 'usage: onboard.mjs new|questions|answer|ask|render|drift — see the header of this file')
}
