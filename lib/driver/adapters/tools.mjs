// The neutral tool vocabulary of config/agents.json. Each adapter translates it into its own runtime's
// names; MCP server ids are logical too, because connector names differ per runtime and environment.

const BASIC = new Set(['read', 'search', 'shell', 'web'])
const MCP = /^mcp:([a-z0-9][a-z0-9-]*)\.([A-Za-z0-9_-]+)$/

export function parseTool(name) {
  if (BASIC.has(name)) return { kind: name }
  const m = MCP.exec(String(name))
  if (m) return { kind: 'mcp', server: m[1], tool: m[2] }
  throw new Error(`"${name}" is not a logical tool name (read, search, shell, web, mcp:<server>.<tool>)`)
}
