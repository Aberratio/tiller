// Real side effects of the driver: lib scripts run directly from an argv array, judgment lanes run
// through a runtime adapter (lib/driver/adapters, `claude -p` by default), and a capped fan-out.
// Everything above this file is plain logic over these three.

import { basename } from 'node:path'
import { adapter } from './adapters/index.mjs'
import { CORE_ROOT, roleSpec } from './agents.mjs'
import { gitCommonDir } from './proc.mjs'

export { exec, gitCommonDir, laneSandbox } from './proc.mjs'

export function parseScriptResult(stdout, script) {
  const last = String(stdout || '').trimEnd().split('\n').pop()
  try {
    const doc = JSON.parse(last)
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc
  } catch {}
  return { status: 'error', kind: 'script-error', reason: `no script-result line from ${basename(String(script))}` }
}

function laneError(message, extra) {
  return Object.assign(new Error(message), extra)
}

const driverUsage = u => ({ input: u.in, output: u.out, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate })

// The driver's lane contract: a result, or a throw carrying whatever spend the runtime accounted for.
// `denials` is the runtime's own record of refused tool calls; an adapter that cannot report them leaves it undefined.
export async function lane({ name, label, prompt, model, schema, budgetUsd, cwd, agentType, profileTools, disallowedTools = [], runtime = 'claude', maxTurns, timeoutMs }) {
  const a = adapter(runtime)
  const role = agentType ? roleSpec(agentType, CORE_ROOT, profileTools) : null
  const common = cwd ? gitCommonDir(cwd) : null
  // A role agent runs the core's own scripts through Bash, so a repo's denyRead ["~/"] must not hide the core.
  const readPaths = [...(role ? [CORE_ROOT] : []), ...(common ? [common] : [])]
  const env = role && !process.env.TILLER_HOME ? { TILLER_HOME: CORE_ROOT } : {}
  const r = await a.run({ prompt, schema, model, budgetUsd, maxTurns, timeoutMs, cwd, role, agentType, disallowedTools, readPaths, env })
  const denials = a.capabilities.denials ? r.denials : undefined
  const context = { lane: name, label, exitCode: r.exitCode, durationMs: r.durationMs, exitClass: r.exitClass, denials }
  if (r.usage.costSource === 'unknown' && r.exitClass !== 'ok') throw laneError(r.message, context)
  const usage = driverUsage(r.usage)
  if (r.exitClass !== 'ok') throw laneError(r.message, { ...context, subtype: r.subtype, usage, costUsd: r.usage.costUsd, model: r.model })
  return { result: r.structured, usage, costUsd: r.usage.costUsd, durationMs: r.durationMs, model: r.model, denials }
}

export function pool(limit) {
  const cap = Math.max(1, limit | 0)
  return async thunks => {
    const out = new Array(thunks.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < thunks.length) {
        const i = next++
        try { out[i] = await thunks[i]() } catch { out[i] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(cap, thunks.length) }, worker))
    return out
  }
}
