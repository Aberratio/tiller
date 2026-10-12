// The neutral tool vocabulary of config/agents.json. Each adapter translates it into its own runtime's
// names; MCP server ids are logical too, because connector names differ per runtime and environment.
// `role:<role>.<op>` names a capability, not a vendor: config/tool-kinds.json and the profile's
// `## tools` resolve it to `mcp:<server>.<tool>` before any adapter sees it.

import { readFileSync } from 'node:fs'

const BASIC = new Set(['read', 'search', 'shell', 'web'])
const MCP = /^mcp:([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+)$/
const ROLE = /^role:([a-z][a-z-]*)(?:\.([a-z][a-z0-9-]*))?$/

export const TOOL_KINDS = JSON.parse(readFileSync(new URL('../../../config/tool-kinds.json', import.meta.url), 'utf8')).roles

// The kind and server each role resolves to: the profile's choice where it made one, else the default.
export function roleBindings(profileTools = {}, kinds = TOOL_KINDS) {
  const out = {}
  for (const [role, def] of Object.entries(kinds)) {
    const chosen = profileTools[role] || {}
    const kind = chosen.kind || def.default
    if (kind === 'none') { out[role] = { kind, server: null, ops: {} }; continue }
    const k = def.kinds[kind]
    if (!k) throw new Error(`role "${role}" has no kind "${kind}" in config/tool-kinds.json`)
    out[role] = { kind, server: chosen.server || k.server, ops: k.ops }
  }
  return out
}

// `role:<role>.<op>` -> `mcp:<server>.<tool>`; `role:<role>` -> `mcp:<server>` (the whole server);
// a role bound to `none` resolves to null. Any other name passes through.
export function resolveRoleTool(name, bindings = roleBindings()) {
  const m = ROLE.exec(String(name))
  if (!m) return name
  const [, role, op] = m
  const b = bindings[role]
  if (!b) throw new Error(`"${name}" names unknown role "${role}"`)
  if (b.kind === 'none') return null
  if (!b.server) throw new Error(`"${name}": role "${role}" kind "${b.kind}" has no MCP server`)
  if (op === undefined) return `mcp:${b.server}`
  const tool = b.ops[op]
  if (!tool) throw new Error(`"${name}": kind "${b.kind}" of role "${role}" has no op "${op}"`)
  return `mcp:${b.server}.${tool}`
}

export function resolveTools(names, profileTools = {}) {
  const bindings = roleBindings(profileTools)
  return names.map(n => resolveRoleTool(n, bindings)).filter(n => n !== null)
}

export function parseTool(name) {
  if (BASIC.has(name)) return { kind: name }
  const resolved = resolveRoleTool(name)
  const m = MCP.exec(String(resolved))
  if (m) return { kind: 'mcp', server: m[1], tool: m[2] }
  throw new Error(`"${name}" is not a logical tool name (read, search, shell, web, mcp:<server>.<tool>, role:<role>.<op>)`)
}
