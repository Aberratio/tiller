// `claude -p --output-format json` prints one envelope: `structured_output` holds the --json-schema
// result, `is_error` + `subtype` (e.g. "error_max_budget_usd") + `errors[]` describe a failure, and
// the process exits 1 with the envelope still on stdout. On a budget stop the top-level `usage` is all
// zeros while `modelUsage` keeps the real per-model counts, so usage is summed from `modelUsage`.

import { readFileSync } from 'node:fs'
import { exec, laneSandbox } from '../proc.mjs'
import { parseTool } from './tools.mjs'

const BASIC = { shell: ['Bash'], read: ['Read'], search: ['Grep', 'Glob'], web: ['WebFetch', 'WebSearch'] }
const MCP_SERVERS = JSON.parse(readFileSync(new URL('../../../config/mcp-servers.json', import.meta.url), 'utf8')).claude

// The premise lane once dispatched a subagent ("mine + a dispatched Explore agent") despite the
// driver's no-dispatch rule, multiplying its cache-read. Prose alone (c.NO_DISPATCH) does not stop a
// lane from reaching for the tool, so every lane's own tool pool is narrowed here, unconditionally -
// no routing entry marks a lane as allowed to dispatch, and none should.
const DISPATCH_DENY = ['Agent', 'Task', 'Workflow']

// Without StructuredOutput in an allowlist, `--json-schema` returns success with no structured_output.
const ALWAYS = ['StructuredOutput']

// MCP tools are deferred in Claude Code: ToolSearch is what loads them, so it travels with any of them.
export function claudeTools(logical, overrides = {}) {
  const servers = { ...MCP_SERVERS, ...overrides }
  const out = []
  let searchAdded = false
  for (const name of logical) {
    const t = parseTool(name)
    if (t.kind !== 'mcp') { out.push(...BASIC[t.kind]); continue }
    const server = servers[t.server]
    if (!server) throw new Error(`no claude name for MCP server "${t.server}"`)
    if (!searchAdded) { out.push('ToolSearch'); searchAdded = true }
    out.push(`mcp__${server}__${t.tool}`)
  }
  return out
}

// A disallow-list entry: `mcp:<server>` names the whole server, which Claude Code matches by prefix.
export function claudeToolName(logical, overrides = {}) {
  const servers = { ...MCP_SERVERS, ...overrides }
  const m = /^mcp:([a-z0-9][a-z0-9-]*)(?:\.([A-Za-z0-9_-]+))?$/.exec(String(logical))
  if (!m) throw new Error(`"${logical}" is not an mcp:<server>[.<tool>] name`)
  if (!servers[m[1]]) throw new Error(`no claude name for MCP server "${m[1]}"`)
  return m[2] ? `mcp__${servers[m[1]]}__${m[2]}` : `mcp__${servers[m[1]]}`
}

export function claudeAgent(role, servers) {
  const tools = claudeTools(role.tools, servers)
  return {
    description: role.description,
    prompt: role.systemPrompt,
    tools: [...tools, ...ALWAYS.filter(t => !tools.includes(t))],
    ...(role.model ? { model: role.model } : {}),
  }
}

function spend(envelope) {
  const per = Object.entries(envelope.modelUsage || {})
  if (per.length) {
    const sum = k => per.reduce((n, [, u]) => n + (u[k] || 0), 0)
    const model = per.sort(([, a], [, b]) => (b.costUSD || 0) - (a.costUSD || 0))[0][0]
    return { model, usage: { in: sum('inputTokens'), out: sum('outputTokens'), cacheRead: sum('cacheReadInputTokens'), cacheCreate: sum('cacheCreationInputTokens') } }
  }
  const u = envelope.usage || {}
  return { usage: { in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0 } }
}

function denialText(tool, input) {
  const i = input && typeof input === 'object' ? input : {}
  const arg = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? JSON.stringify(i)
  return `Permission denied: ${tool}(${arg})`
}

export function denials(envelope) {
  return (Array.isArray(envelope.permission_denials) ? envelope.permission_denials : []).map(d => ({
    tool: String(d.tool_name), input: d.tool_input ?? {}, text: denialText(d.tool_name, d.tool_input),
  }))
}

const RATE = /rate.?limit|\b429\b|overloaded/i
const AUTH = /invalid api key|\/login|unauthori[sz]ed|\b401\b|authentication/i
const byText = text => (RATE.test(text) ? 'rate_limit' : AUTH.test(text) ? 'auth' : 'runtime_error')
const RAW_MAX = 20000
const UNKNOWN = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, costSource: 'unknown' }

export function argv(req) {
  const deny = [...new Set([...(req.disallowedTools || []), ...DISPATCH_DENY])]
  const a = ['claude', '-p', '--model', req.model, '--output-format', 'json', '--json-schema', JSON.stringify(req.schema), '--max-budget-usd', String(req.budgetUsd), '--permission-mode', 'auto']
  if (req.maxTurns) a.push('--max-turns', String(req.maxTurns))
  a.push('--settings', JSON.stringify(laneSandbox({ read: req.readPaths || [] }).settings))
  if (req.role) a.push('--agents', JSON.stringify({ [req.agentType]: claudeAgent(req.role, req.mcpServers) }))
  if (req.agentType) a.push('--agent', req.agentType)
  // Variadic: it must stay last or it swallows the flags after it.
  a.push('--disallowedTools', ...deny)
  return a
}

export default {
  name: 'claude',
  capabilities: { nativeSchema: true, usdBudget: true, turnCap: true, toolAllowlist: true, mcp: true, subagents: true, skills: true, instructionFile: 'CLAUDE.md', denials: true, denyTools: true },

  async run(req) {
    const r = await exec(argv(req), { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, env: { PATH: laneSandbox().PATH, ...(req.env || {}) } })
    const base = { structured: null, model: req.model, durationMs: r.durationMs, denials: [], raw: r.stdout.slice(0, RAW_MAX), exitCode: r.exitCode }

    let envelope
    try { envelope = JSON.parse(r.stdout) } catch {}
    if (!envelope || typeof envelope !== 'object') {
      const message = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n') || `claude exited ${r.exitCode} with no output`
      return { ...base, usage: { ...UNKNOWN }, exitClass: r.timedOut ? 'timeout' : byText(message), message }
    }

    const { model, usage } = spend(envelope)
    const accounted = { ...base, subtype: envelope.subtype, model: model || req.model, usage: { ...usage, costUsd: envelope.total_cost_usd ?? 0, costSource: 'reported' }, denials: denials(envelope) }
    if (envelope.is_error || r.exitCode !== 0) {
      const message = (envelope.errors || []).join('\n') || (typeof envelope.result === 'string' && envelope.result) || r.stderr.trim() || `claude exited ${r.exitCode} (${envelope.subtype || 'no subtype'})`
      const exitClass = r.timedOut ? 'timeout'
        : envelope.subtype === 'error_max_budget_usd' ? 'budget'
          : envelope.subtype === 'error_max_turns' ? 'turns'
            : byText(message) === 'runtime_error' && accounted.denials.length ? 'tool_denied' : byText(message)
      return { ...accounted, exitClass, message }
    }
    if (envelope.structured_output === undefined || envelope.structured_output === null) {
      return { ...accounted, exitClass: 'schema', message: `no structured_output in claude envelope (subtype ${envelope.subtype}): ${String(envelope.result ?? '').slice(0, 500)}` }
    }
    return { ...accounted, structured: envelope.structured_output, exitClass: 'ok' }
  },
}
