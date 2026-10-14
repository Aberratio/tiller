// `tiller apply`: resolve the layers, plan every native file, show the diff, settle drift, then
// write with backups and record ownership. Nothing is written until every file has been planned.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probe } from '../machine/probe.mjs'
import { claudeTargets, legacyHooks, withoutLegacyHooks, BLOCK_HEADER } from '../adapters/claude.mjs'
import { copilotEnvLines, copilotTargets } from '../adapters/copilot.mjs'
import { readLayers, resolve } from './layers.mjs'
import { hashValue, loadManifest, saveManifest } from './manifest.mjs'
import { InvalidNativeFile, plan, resolveDrift, writeAtomic } from './merge.mjs'

const ADAPTERS = { claude: claudeTargets, copilot: copilotTargets }
const KNOWN = ['claude', 'copilot']

const readText = f => (existsSync(f) ? readFileSync(f, 'utf8') : null)
const show = v => (v === undefined ? '(absent)' : JSON.stringify(v))

function readMachine(stateHome) {
  const text = readText(join(stateHome, 'machine.json'))
  if (text == null) return {}
  try { return JSON.parse(text) } catch (e) { throw new Error(`${join(stateHome, 'machine.json')}: ${e.message}`) }
}

function chooseAgents(requested, p, out) {
  const wanted = requested ?? KNOWN.filter(a => p.agents[a]?.bin || p.agents[a]?.configDirExists)
  const unknown = wanted.filter(a => !KNOWN.includes(a))
  if (unknown.length) return { error: `unknown agent: ${unknown.join(', ')}` }
  for (const a of wanted.filter(a => !ADAPTERS[a])) {
    if (requested) return { error: `${a}: not supported yet` }
    out(`${a}: not supported yet, skipped\n`)
  }
  const agents = wanted.filter(a => ADAPTERS[a])
  return agents.length ? { agents } : { error: 'no supported agent detected (use --agents claude,copilot)' }
}

function printPlan(file, out) {
  out(`${file.agent}: ${file.target.path}\n`)
  const block = file.target.kind === 'block'
  for (const c of file.p.changes) {
    if (c.op === 'set') out(`  ${c.before === undefined ? '+' : '~'} ${c.id}${block ? '' : ` = ${show(c.after)}`}\n`)
    else if (c.op === 'remove') out(`  - ${c.id}\n`)
    else out(`  = ${c.id} (taken over, no write)\n`)
  }
  for (const d of file.p.drift) out(`  ! ${driftLine(d)}\n`)
  if (!file.p.changes.length && !file.p.drift.length) out('  (no change)\n')
}

const driftLine = d => `${d.id} drifted (${d.reason}): current ${show(d.current)}, desired ${show(d.desired)}`

function ask(prompt, question, valid) {
  for (let i = 0; i < 3; i++) {
    const answer = prompt(question)
    if (answer == null) return null
    const key = String(answer).trim().toLowerCase()[0]
    if (valid.includes(key)) return key
  }
  return null
}

// Adopting writes the current native value into the personal layer, so the next apply desires it.
// Claude's /env pointers come from the neutral env; every other pointer is the agent's native key.
function adoptInto(personalDir, adopted) {
  const file = join(personalDir, 'harness.json')
  const layer = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  for (const { agent, id, value } of adopted) {
    if (id === 'block') {
      const body = String(value ?? '').replace(new RegExp(`^${BLOCK_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`), '')
      writeAtomic(join(personalDir, 'instructions.md'), body ? body + '\n' : '')
      continue
    }
    const segs = id.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node = agent === 'claude' && segs[0] === 'env' ? layer : ((layer.native ??= {})[agent] ??= {})
    for (const s of segs.slice(0, -1)) node = node[s] ??= {}
    if (value === undefined) delete node[segs.at(-1)]
    else node[segs.at(-1)] = value
  }
  writeAtomic(file, JSON.stringify(layer, null, 2) + '\n')
}

export function runApply({ tillerHome, home, env, platform, stateHome, personalDir, agents, yes, dryRun, isTTY, prompt, out }) {
  const machineProbe = probe({ platform, env, home })
  const chosen = chooseAgents(agents, machineProbe, out)
  if (chosen.error) return { status: 'refused', reason: chosen.error, files: [] }

  const desired = resolve(readLayers({ tillerHome, personalDir, stateHome }), { vars: { TILLER_HOME: tillerHome, HOME: home } })
  const manifest = loadManifest(stateHome)
  const interactive = Boolean(isTTY && prompt)
  let files = []
  const invalid = []
  for (const agent of chosen.agents) {
    for (const target of ADAPTERS[agent](desired, { configDir: machineProbe.agents[agent].configDir, tillerHome })) {
      const current = readText(target.path)
      try {
        files.push({ agent, target, current, p: plan(target, current, manifest.files[target.path], manifest.released[target.path]) })
      } catch (e) {
        if (!(e instanceof InvalidNativeFile)) throw e
        invalid.push(e)
      }
    }
  }
  // An unparseable file is never written; in a terminal the user may leave it alone and apply the rest.
  for (const e of invalid) {
    if (dryRun || !interactive) return { status: 'refused', reason: e.message, files: [] }
    if (ask(prompt, `${e.message}; tiller will not write it. [s]kip this file / [q]uit? `, 'sq') !== 's') {
      return { status: 'refused', reason: `not applied: ${e.path}`, files: [] }
    }
  }

  for (const f of files) printPlan(f, out)
  const legacy = new Map()
  for (const f of files.filter(f => f.agent === 'claude' && f.target.kind === 'json' && f.current != null)) {
    const cmds = legacyHooks(f.current)
    if (cmds.length) legacy.set(f, cmds)
    for (const cmd of cmds) {
      out(`warning: ${f.target.path} also holds a hand-merged private-access hook (${cmd}); the check will run twice until that entry is removed\n`)
    }
  }
  if (chosen.agents.includes('copilot')) {
    const lines = copilotEnvLines(desired)
    if (lines.length) out(`copilot: hooks get their env per entry; for the shell, add to your profile:\n${lines.map(l => `  ${l}\n`).join('')}`)
  }
  if (dryRun) return { status: 'dry-run', files: [] }

  // A file that exists but was never tiller's is asked about before anything in it changes; --yes merges.
  const firstContact = new Set(files.filter(f => f.current != null && !manifest.files[f.target.path] && (f.p.write || f.p.drift.length)))
  if (interactive && !yes) {
    for (const f of firstContact) {
      const ids = [...f.p.changes.filter(c => c.op !== 'own'), ...f.p.drift].map(c => c.id).join(', ')
      const key = ask(prompt, `${f.target.path} exists and tiller has not managed it before; it would change: ${ids}. [m]erge / [s]kip / [q]uit? `, 'msq')
      if (key === 's') files = files.filter(x => x !== f)
      else if (key !== 'm') return { status: 'refused', reason: `not applied: ${f.target.path}`, files: [] }
    }
  }

  const drifted = files.flatMap(f => f.p.drift.map(d => ({ f, d })))
  if (drifted.length) {
    if (!isTTY || !prompt) {
      return { status: 'refused', reason: `drift needs a decision in a terminal: ${drifted.map(x => x.d.id).join(', ')}`, files: [] }
    }
    for (const f of files) {
      const choices = {}
      for (const d of f.p.drift) {
        // Hook entries are rendered from the neutral hooks list, so there is no layer key to adopt into.
        const fixed = d.id.startsWith('hook:') || (f.agent === 'copilot' && f.target.kind === 'json')
        const canAdopt = Boolean(personalDir) && !fixed
        const options = canAdopt ? '[a]dopt / [o]verwrite / [r]elease' : '[o]verwrite / [r]elease'
        const key = ask(prompt, `${f.target.path} ${driftLine(d)}. ${options}? `, canAdopt ? 'aor' : 'or')
        if (!key) return { status: 'refused', reason: `no decision for ${d.id}`, files: [] }
        choices[d.id] = { a: 'adopt', o: 'overwrite', r: 'release' }[key]
      }
      if (Object.keys(choices).length) f.p = resolveDrift(f.p, choices)
    }
  }

  if (interactive && !yes) {
    for (const [f, cmds] of legacy) {
      if (!files.includes(f)) continue
      if (ask(prompt, `${f.target.path}: remove the hand-merged private-access hook (${cmds.join('; ')})? [y/N] `, 'yn') !== 'y') continue
      f.p = { ...f.p, write: true, next: { ...f.p.next, text: withoutLegacyHooks(f.p.next.text) } }
    }
  }

  const writing = files.filter(f => f.p.write)
  const adopted = files.flatMap(f => f.p.adopted.map(a => ({ ...a, agent: f.agent })))
  if ((writing.length || adopted.length) && !yes) {
    if (!isTTY || !prompt) return { status: 'refused', reason: 'no terminal to confirm; re-run with --yes', files: [] }
    if (ask(prompt, 'Apply these changes? [y/N] ', 'yn') !== 'y') return { status: 'refused', reason: 'not confirmed', files: [] }
  }

  if (adopted.length) adoptInto(personalDir, adopted)
  const backupDir = join(stateHome, 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  const next = structuredClone(manifest)
  for (const f of files) {
    const prev = manifest.files[f.target.path]
    let backup = null
    if (f.p.write) backup = writeAtomic(f.target.path, f.p.next.text, { backupDir })
    if (f.p.write && firstContact.has(f)) out(`merged into existing ${f.target.path}; backup ${backup}\n`)
    next.files[f.target.path] = {
      agent: f.agent,
      kind: f.target.kind,
      items: f.p.next.items,
      writtenHash: f.p.write ? hashValue(f.p.next.text) : prev?.writtenHash ?? null,
      backup: prev?.backup ?? backup,
      created: prev ? prev.created : f.current == null,
    }
    if (f.p.next.released.length) next.released[f.target.path] = f.p.next.released
    else delete next.released[f.target.path]
  }
  const manifestChanged = JSON.stringify(next) !== JSON.stringify(manifest) || !existsSync(join(stateHome, 'owned.json'))
  if (manifestChanged) saveManifest(stateHome, next)

  const machine = readMachine(stateHome)
  if (JSON.stringify(machine.probe) !== JSON.stringify(machineProbe)) {
    writeAtomic(join(stateHome, 'machine.json'), JSON.stringify({ ...machine, probe: machineProbe }, null, 2) + '\n')
  }

  const written = writing.map(f => f.target.path)
  return { status: written.length || adopted.length ? 'written' : 'unchanged', files: written }
}
