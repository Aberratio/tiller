// `codex exec --json` prints JSONL events (thread.started, turn.started, item.*, turn.completed with
// token usage, turn.failed, error). The schema-constrained final message goes to the `-o` file. Codex
// reports no USD, so the cap is ours: tokens x config/prices.json, enforced on each turn.completed by
// killing the process group. Event and flag shapes are from docs only; see README.md in this directory.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validate } from '../../contract/validate.mjs'
import { exec } from '../proc.mjs'
import { budgetGuard, loadPrices } from './budget.mjs'
import { parseTool } from './tools.mjs'

// workspace-write stays refused until a codex write lane has been measured.
const SANDBOXES = ['read-only']
// Documented item types. Anything else may be a subagent dispatch, which codex cannot be told to refuse.
const KNOWN_ITEMS = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'todo_list', 'error'])
const RATE = /rate.?limit|\b429\b|overloaded/i
const AUTH = /invalid api key|unauthori[sz]ed|\b401\b|authentication|not logged in/i
const byText = t => (RATE.test(t) ? 'rate_limit' : AUTH.test(t) ? 'auth' : 'runtime_error')
const RAW_MAX = 20000

export function argv(req, { schemaFile, lastFile }) {
  const sandbox = req.sandbox || 'read-only'
  if (!SANDBOXES.includes(sandbox)) throw new Error(`codex sandbox "${sandbox}" is not allowed; use ${SANDBOXES.join(' or ')}`)
  return ['codex', 'exec', '--json', '--output-schema', schemaFile, '-o', lastFile, '-m', req.model, '--sandbox', sandbox, '-C', req.cwd,
    '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-']
}

function checkRole(role) {
  for (const t of (role && role.tools) || []) {
    const p = parseTool(t)
    if (p.kind === 'mcp' || p.kind === 'web') throw new Error(`tool "${t}" cannot be granted per tool in codex; a role needing it cannot run here`)
  }
}

export default {
  name: 'codex',
  capabilities: { nativeSchema: true, usdBudget: false, turnCap: false, toolAllowlist: false, mcp: false, subagents: false, skills: true, instructionFile: 'AGENTS.md', denials: false, denyTools: false },
  available: (env, { onPath }) => onPath('codex'),

  async run(req) {
    const started = Date.now()
    const zero = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, costSource: 'computed' }
    const base = { structured: null, model: req.model, denials: [], raw: '' }
    let guard, a
    const dir = mkdtempSync(join(tmpdir(), 'codex-lane-'))
    try {
      try {
        checkRole(req.role)
        guard = budgetGuard({ runtime: 'codex', model: req.model, budgetUsd: req.budgetUsd, prices: req.prices || loadPrices(), maxTurns: req.maxTurns, wallClockMs: req.timeoutMs })
        a = argv(req, { schemaFile: join(dir, 'schema.json'), lastFile: join(dir, 'last.txt') })
      } catch (e) { return { ...base, usage: zero, durationMs: Date.now() - started, exitClass: 'runtime_error', message: e.message } }
      writeFileSync(join(dir, 'schema.json'), JSON.stringify(req.schema))

      let failure = null, foreign = null
      const onLine = line => {
        let e
        try { e = JSON.parse(line) } catch { return null }
        if (e.type === 'turn.completed') {
          const u = e.usage || {}
          const cached = u.cached_input_tokens || 0
          // Reasoning tokens are added to output; whether codex already counts them there is unverified, and
          // the cap must not undercount.
          return guard.turn() || guard.add({ in: (u.input_tokens || 0) - cached, cacheRead: cached, out: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) })
        }
        if (e.type === 'turn.failed') failure = failure || (e.error && e.error.message) || 'turn.failed'
        if (e.type === 'error') failure = failure || e.message || 'error event'
        if ((e.type === 'item.started' || e.type === 'item.completed') && e.item && !KNOWN_ITEMS.has(e.item.type)) {
          foreign = `item type "${e.item.type}" is outside the known set; dispatch or an ungranted tool cannot be ruled out`
          return foreign
        }
        return guard.check()
      }

      const prompt = req.role && req.role.systemPrompt ? `${req.role.systemPrompt}\n\n${req.prompt}` : req.prompt
      const wall = Math.max(1, guard.remainingMs())
      const r = await exec(a, { cwd: req.cwd, input: prompt, timeoutMs: Number.isFinite(wall) ? wall : undefined, env: req.env, onLine })
      const out = { ...base, usage: guard.usage(), durationMs: r.durationMs, raw: r.stdout.slice(0, RAW_MAX), exitCode: r.exitCode }

      if (r.stopped) {
        if (foreign) return { ...out, exitClass: 'tool_denied', message: foreign }
        const b = guard.breach()
        return { ...out, exitClass: b ? b.exitClass : 'runtime_error', message: r.stopped }
      }
      if (r.timedOut) return { ...out, exitClass: 'timeout', message: `codex killed after ${wall}ms` }
      if (failure) return { ...out, exitClass: byText(failure), message: failure }
      if (r.exitCode !== 0) {
        const message = r.stderr.trim() || `codex exited ${r.exitCode}`
        return { ...out, exitClass: byText(message), message }
      }

      let doc
      try { doc = JSON.parse(readFileSync(join(dir, 'last.txt'), 'utf8')) } catch (e) { return { ...out, exitClass: 'schema', message: `codex -o output is not JSON: ${e.message}` } }
      const errors = validate(req.schema, doc)
      if (errors.length) return { ...out, exitClass: 'schema', message: `codex result fails the lane schema: ${errors.join('; ')}` }
      return { ...out, structured: doc, exitClass: 'ok' }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  },
}
