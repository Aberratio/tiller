// `tiller apply --adopt`: what an agent's native files hold that the layers do not, and the writer
// that puts adopted values into the personal layer. Drift adopt shares the writer.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { BLOCK_HEADER, claudeTargets, leaves } from '../adapters/claude.mjs'
import { copilotTargets } from '../adapters/copilot.mjs'
import { skillRoots } from '../adapters/skills.mjs'
import { probe } from '../machine/probe.mjs'
import { JsoncError, parseJsonc } from './jsonc.mjs'
import { readLayers, resolve } from './layers.mjs'
import { hashValue } from './manifest.mjs'
import { InvalidNativeFile, openNative, writeAtomic } from './merge.mjs'

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Folds this machine's paths back into their variables so the layer applies on another machine.
// A match must end at a path boundary, so `/home/sam` does not claim `/home/samuel`.
export function portable(value, vars, platform = process.platform) {
  if (typeof value !== 'string') return value
  const forms = Object.entries(vars).flatMap(([k, path]) => {
    const out = [[path, k]]
    if (platform === 'win32') out.push([path.replace(/\\/g, '/'), k])
    return out
  }).filter(([path]) => path).sort((a, b) => b[0].length - a[0].length)
  let s = value
  for (const [path, k] of forms) s = s.replace(new RegExp(`${escapeRe(path)}(?=$|[/\\\\])`, 'g'), `\${${k}}`)
  return s
}

const portableDeep = (v, vars, platform) =>
  Array.isArray(v) ? v.map(e => portableDeep(e, vars, platform))
    : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, portableDeep(e, vars, platform)]))
      : portable(v, vars, platform)

// Claude's /env pointers come from the neutral env; every other pointer is the agent's native key.
export function writeLayer(personalDir, adopted, { vars, platform = process.platform }) {
  mkdirSync(personalDir, { recursive: true })
  const file = join(personalDir, 'harness.json')
  const layer = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const written = new Set()
  for (const { agent, id, value: raw } of adopted) {
    const value = portableDeep(raw, vars, platform)
    if (id === 'block') {
      const body = String(value ?? '').replace(new RegExp(`^${escapeRe(BLOCK_HEADER)}\\n?`), '')
      const target = join(personalDir, 'instructions.md')
      writeAtomic(target, body ? body + '\n' : '')
      written.add(target)
      continue
    }
    const segs = id.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node = agent === 'claude' && segs[0] === 'env' ? layer : ((layer.native ??= {})[agent] ??= {})
    for (const s of segs.slice(0, -1)) node = node[s] ??= {}
    if (value === undefined) delete node[segs.at(-1)]
    else node[segs.at(-1)] = value
    written.add(file)
  }
  if (written.has(file)) writeAtomic(file, JSON.stringify(layer, null, 2) + '\n')
  return [...written]
}

function parseDoc(path, kind, text) {
  if (text == null) return {}
  let doc
  try {
    doc = kind === 'jsonc' ? parseJsonc(text).value : JSON.parse(text)
  } catch (e) {
    if (kind === 'jsonc' && !(e instanceof JsoncError)) throw e
    throw new InvalidNativeFile(path, `invalid JSON${kind === 'jsonc' ? ' with comments' : ''} (${e.message})`)
  }
  if (!isPlain(doc)) throw new InvalidNativeFile(path, 'not a JSON object')
  return doc
}

const isTillerHook = entry => Array.isArray(entry?.hooks) && entry.hooks.every(h => String(h?.command ?? '').startsWith('TILLER_HOOK='))

// Hooks are rendered from the neutral list and have no layer key, so user entries stay where they are.
function hookLines(path, id, value) {
  const entries = (Array.isArray(value) ? value : [value]).filter(e => !isTillerHook(e))
  if (!entries.length) return []
  const n = entries.length
  return [{ path, what: `${id.slice(1).replace(/\//g, '.')}: ${n} user ${n === 1 ? 'entry' : 'entries'} stay${n === 1 ? 's' : ''} native` }]
}

export function adoptable(agent, targets, currents) {
  const items = [], left = []
  let same = 0
  for (const target of targets) {
    const { path, kind } = target
    const current = currents.get(path) ?? null
    if (kind === 'block') {
      const body = openNative(path, kind, current).get()
      if (body === undefined) { if (current != null) left.push({ path, what: 'no managed block' }); continue }
      if (hashValue(body) === hashValue(target.body)) same++
      else items.push({ path, id: 'block', value: body, op: 'set' })
      continue
    }
    // Copilot's only JSON target is tiller's own hooks file.
    if (agent === 'copilot' && kind === 'json') continue
    const rendered = new Map(target.items.map(i => [i.id, hashValue(i.value)]))
    for (const { id, value } of leaves(parseDoc(path, kind, current))) {
      if (agent === 'claude' && id.startsWith('/hooks/')) { left.push(...hookLines(path, id, value)); continue }
      if (rendered.get(id) === hashValue(value)) same++
      else items.push({ path, id, value, op: 'set' })
    }
  }
  return { items, same, left }
}

// --- foreign skills and agent files ---------------------------------------------------------------

const under = (path, root) => { const r = relative(root, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }
const real = p => { try { return realpathSync(p) } catch { return null } }
const names = dir => (existsSync(dir) ? readdirSync(dir) : []).filter(n => existsSync(join(dir, n, 'SKILL.md')))

// Skills the agent sees that tiller did not link: proposed for copy into the personal layer. A link
// into tiller's own trees is tiller's doing and is not reported.
export function adoptableSkills(agent, { configDir, home, tillerHome, personalDir }) {
  const copy = [], left = []
  const tracked = new Set(names(join(tillerHome, 'skills')))
  const personal = new Set(names(join(personalDir, 'skills')))
  const own = [tillerHome, personalDir].map(real).filter(Boolean)
  const seen = new Map()
  for (const root of skillRoots(agent, { configDir, home })) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name)
      if (lstatSync(path).isSymbolicLink()) {
        const target = real(path)
        if (target == null) { left.push({ path, what: 'dangling symlink' }); continue }
        if (own.some(o => under(target, o))) continue
      }
      if (!statSync(path).isDirectory() || !existsSync(join(path, 'SKILL.md'))) continue
      if (tracked.has(name)) left.push({ path, what: "would shadow tiller's skill" })
      else if (personal.has(name)) left.push({ path, what: 'already in the personal layer' })
      else if (seen.has(name)) left.push({ path, what: `same name as ${seen.get(name)}` })
      else { seen.set(name, path); copy.push({ name, from: path, to: join(personalDir, 'skills', name) }) }
    }
  }
  return { copy, left }
}

const GENERATED = /generated by (tiller apply|lib\/agents\/(install-agents|generate)\.mjs)/
const AGENT_SUFFIX = { claude: '.md', copilot: '.agent.md' }

// Agent files tiller would not render: a role it does not desire, or a desired role written by hand.
export function foreignAgents(agent, { configDir, desiredAgents }) {
  const dir = join(configDir, 'agents'), suffix = AGENT_SUFFIX[agent]
  const out = []
  for (const entry of (existsSync(dir) ? readdirSync(dir) : []).sort()) {
    const path = join(dir, entry)
    if (!entry.endsWith(suffix) || !statSync(path).isFile()) continue
    const name = entry.slice(0, -suffix.length)
    if (!desiredAgents.includes(name)) out.push({ path, what: 'not a tiller role' })
    else if (!GENERATED.test(readFileSync(path, 'utf8'))) out.push({ path, what: 'no generated marker' })
  }
  return out
}

export function copySkills(copy) {
  for (const { from, to } of copy) {
    if (existsSync(to)) throw new Error(`${to} exists`)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, dereference: true })
  }
}

// --- `tiller apply --adopt <agent>` -----------------------------------------------------------------

const ADAPTERS = { claude: claudeTargets, copilot: copilotTargets }

export function ask(prompt, question, valid) {
  for (let i = 0; i < 3; i++) {
    const answer = prompt(question)
    if (answer == null) return null
    const key = String(answer).trim().toLowerCase()[0]
    if (valid.includes(key)) return key
  }
  return null
}

const readText = f => (existsSync(f) ? readFileSync(f, 'utf8') : null)

export function runAdopt({ tillerHome, home, env, platform, stateHome, personalDir, agent, yes, dryRun, isTTY, prompt, out, probeMachine = probe }) {
  if (!ADAPTERS[agent]) return { status: 'refused', reason: `unknown agent: ${agent}`, files: [] }
  const machineProbe = probeMachine({ platform, env, home })
  const { configDir, configDirExists } = machineProbe.agents[agent]
  if (!configDirExists) return { status: 'unchanged', reason: `${configDir}: nothing to adopt`, files: [] }

  const vars = { TILLER_HOME: tillerHome, HOME: home }
  let desired = resolve(readLayers({ tillerHome, personalDir, stateHome }), { vars })
  // Hooks are never adopted, and rendering one on Windows without Git Bash would throw.
  if (platform === 'win32' && !machineProbe.shell) desired = { ...desired, hooks: [] }
  const targets = ADAPTERS[agent](desired, { configDir, tillerHome, platform, shell: machineProbe.shell })
  let found
  try {
    found = adoptable(agent, targets, new Map(targets.map(t => [t.path, readText(t.path)])))
  } catch (e) {
    if (!(e instanceof InvalidNativeFile)) throw e
    return { status: 'refused', reason: e.message, files: [] }
  }
  const skills = adoptableSkills(agent, { configDir, home, tillerHome, personalDir })
  const agents = foreignAgents(agent, { configDir, desiredAgents: desired.agents ?? [] })

  for (const t of targets) {
    const items = found.items.filter(i => i.path === t.path), left = found.left.filter(l => l.path === t.path)
    if (!items.length && !left.length) continue
    out(`${agent}: ${t.path}\n`)
    const rendered = new Set((t.items ?? []).map(i => i.id))
    for (const i of items) {
      const mark = i.id === 'block' ? (desired.instructions?.body ? '~' : '+') : rendered.has(i.id) ? '~' : '+'
      out(`  ${mark} ${i.id}${i.id === 'block' ? '' : ` = ${JSON.stringify(i.value)}`}\n`)
    }
    for (const l of left) out(`  left: ${l.what}\n`)
  }
  if (skills.copy.length || skills.left.length) {
    out(`${agent}: skills\n`)
    for (const s of skills.copy) out(`  + skill ${s.name} -> ${s.to}\n`)
    for (const l of skills.left) out(`  left: ${l.path}: ${l.what}\n`)
  }
  if (agents.length) {
    out(`${agent}: agents\n`)
    for (const l of agents) out(`  left: ${l.path}: ${l.what}\n`)
  }
  if (found.same) out(`${found.same} already reproduced\n`)

  if (dryRun) return { status: 'dry-run', files: [] }
  if (!found.items.length && !skills.copy.length) return { status: 'unchanged', files: [] }
  if (!yes) {
    if (!isTTY || !prompt) return { status: 'refused', reason: 'writing the personal layer needs --yes or a terminal', files: [] }
    if (ask(prompt, `Write the personal layer at ${personalDir}? [y/N] `, 'yn') !== 'y') return { status: 'refused', reason: 'not adopted', files: [] }
  }
  const files = writeLayer(personalDir, found.items.map(i => ({ agent, id: i.id, value: i.value })), { vars, platform })
  copySkills(skills.copy)
  return { status: 'written', files, skills: skills.copy.length, gitHint: !existsSync(join(personalDir, '.git')) }
}
