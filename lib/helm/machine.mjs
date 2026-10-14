import { parseFrontmatter } from './events.mjs'

export function machineName(env, host) {
  return String(env.TILLER_MACHINE || host.split('.')[0] || 'machine').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

const list = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : [])

export function parseMachine(text) {
  const f = parseFrontmatter(text).fields
  const clones = {}
  for (const [k, v] of Object.entries(f)) if (k.startsWith('clone.')) clones[k.slice(6)] = v
  return { machine: f.machine, last_seen: f.last_seen, profiles: list(f.profiles), capabilities: list(f.capabilities), clones }
}

export function formatMachine(m) {
  const lines = [`machine: ${m.machine}`, `last_seen: ${m.last_seen}`, `profiles: ${m.profiles.join(', ')}`, `capabilities: ${m.capabilities.join(', ')}`]
  for (const k of Object.keys(m.clones).sort()) lines.push(`clone.${k}: ${m.clones[k]}`)
  return `---\n${lines.join('\n')}\n---\n`
}

// Clones are learned from sessions, because repo_globs are match patterns, not paths.
export function refreshMachine(prev, { name, today, profiles, caps, row, clone }, exists) {
  const clones = { ...(prev?.clones ?? {}) }
  if (row && row !== '_none' && clone) clones[row] = clone
  for (const k of Object.keys(clones)) if (!exists(clones[k])) delete clones[k]
  return { machine: name, last_seen: today, profiles: [...profiles].sort(), capabilities: [...new Set(caps)].sort(), clones }
}
