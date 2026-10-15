// Own minimal tool loop over any OpenAI-compatible `POST /v1/chat/completions` (vLLM, llama.cpp, Ollama,
// LM Studio, hosted). The harness owns everything a CLI would: tools, confinement, budget, schema.
// Tools are read-only by construction: read_file, list_files, search, and an allowlisted shell run
// without a shell interpreter. There is no dispatch tool and no MCP client.

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { exec } from '../proc.mjs'
import { budgetGuard } from './budget.mjs'
import { schemaFallback } from './fallback.mjs'
import { parseTool } from './tools.mjs'

const RUNTIME = 'openai-compat'
const OUT_MAX = 20000
const RAW_MAX = 20000
const PATTERN_MAX = 1000
const SEARCH_TIMEOUT_MS = 10000

// Commands, or "command subcommand" pairs, a lane may run. Override with OPENAI_COMPAT_SHELL_ALLOW (comma list).
const DEFAULT_SHELL_ALLOW = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'git status', 'git log', 'git diff', 'git show', 'git rev-parse', 'git ls-files', 'git blame']
// Flags that make an allowlisted read command write a file or run another program.
const DENY_ARG = /^(--output|--ext-diff|--pre\b|-exec|-execdir|-delete|-ok\b)/

const TOOL_DEFS = {
  read_file: { description: 'Read a text file inside the working directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  list_files: { description: 'List a directory inside the working directory.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  search: { description: 'Search file lines by regular expression under a directory inside the working directory.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  shell: { description: 'Run one allowlisted command, given as an argv array, in the working directory. No shell: pipes, redirects and ";" are plain arguments.', parameters: { type: 'object', properties: { argv: { type: 'array', items: { type: 'string' } } }, required: ['argv'] } },
}
const BY_KIND = { read: ['read_file'], search: ['list_files', 'search'], shell: ['shell'] }

class Denied extends Error {}

function toolNames(role) {
  if (!role) return ['read_file', 'list_files', 'search', 'shell']
  const names = []
  for (const t of role.tools || []) {
    const p = parseTool(t)
    if (!BY_KIND[p.kind]) throw new Error(`tool "${t}" has no ${RUNTIME} implementation (no MCP client, no web tool)`)
    for (const n of BY_KIND[p.kind]) if (!names.includes(n)) names.push(n)
  }
  return names
}

function confine(root, p) {
  const abs = resolve(root, String(p ?? '.'))
  let real
  try { real = realpathSync(abs) } catch { real = abs }
  if (real !== root && !real.startsWith(root + sep)) throw new Denied(`outside the working directory: ${p}`)
  return real
}

function shellAllowed(env, argv) {
  const allow = env.OPENAI_COMPAT_SHELL_ALLOW ? env.OPENAI_COMPAT_SHELL_ALLOW.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SHELL_ALLOW
  return allow.includes(argv[0]) || (argv.length > 1 && allow.includes(`${argv[0]} ${argv[1]}`))
}

const cap = s => (s.length > OUT_MAX ? s.slice(0, OUT_MAX) + `\n[truncated at ${OUT_MAX} chars]` : s)

async function runTool(name, args, { root, env }) {
  if (name === 'read_file') return cap(readFileSync(confine(root, args.path), 'utf8'))
  if (name === 'list_files') {
    const dir = confine(root, args.path)
    return readdirSync(dir, { withFileTypes: true }).map(e => e.name + (e.isDirectory() ? '/' : '')).sort().join('\n')
  }
  if (name === 'search') {
    const base = confine(root, args.path)
    const pattern = String(args.pattern ?? '')
    if (!pattern || pattern.length > PATTERN_MAX) throw new Denied(`search pattern must be 1-${PATTERN_MAX} chars`)
    // A model-written pattern runs in grep's ERE engine under a timeout, never in this process's regex engine.
    const r = await exec(['grep', '-rnHIE', '--exclude-dir=.git', '--exclude-dir=node_modules', '-e', pattern, '--', relative(root, base) || '.'], { cwd: root, timeoutMs: SEARCH_TIMEOUT_MS, env: { LANG: 'C' } })
    if (r.timedOut) return `search timed out after ${SEARCH_TIMEOUT_MS}ms`
    if (r.exitCode > 1) return `search failed: ${r.stderr.trim()}`
    const hits = r.stdout.split('\n').filter(Boolean).slice(0, 200).map(l => l.replace(/^(?:\.\/)?([^:]*):(\d+):/, '$1:$2: '))
    return cap(hits.join('\n')) || 'no matches'
  }
  if (name === 'shell') {
    const argv = Array.isArray(args.argv) ? args.argv.map(String) : []
    if (!argv.length || !shellAllowed(env, argv)) throw new Denied('command not in the shell allowlist')
    for (const a of argv.slice(1)) {
      if (DENY_ARG.test(a)) throw new Denied(`argument not allowed: ${a}`)
      // Every operand may name a path; a symlink inside cwd can still point out of it.
      const v = a.startsWith('-') ? (a.includes('=') ? a.slice(a.indexOf('=') + 1) : '') : a
      if (v) confine(root, v)
    }
    const r = await exec(argv, { cwd: root, timeoutMs: 30000, env: { PATH: env.PATH || process.env.PATH, HOME: env.HOME || process.env.HOME, LANG: 'C' } })
    return cap(`exit ${r.exitCode}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`)
  }
  throw new Denied('tool not granted to this lane')
}

const denialArg = (name, args) => (name === 'shell' && Array.isArray(args.argv) ? args.argv.join(' ') : args.path ?? args.pattern ?? JSON.stringify(args))

function classifyHttp(status, text) {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate_limit'
  return 'runtime_error'
}

const REJECTS_FORMAT = /response_format|json_schema/i

export default {
  name: RUNTIME,
  capabilities: { nativeSchema: true, usdBudget: false, turnCap: true, toolAllowlist: true, mcp: false, subagents: false, skills: false, instructionFile: null, denials: true, denyTools: false },

  async run(req) {
    const env = { ...process.env, ...(req.env || {}) }
    const started = Date.now()
    const base = { structured: null, model: req.model, denials: [], raw: '' }
    const zero = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, costSource: 'computed' }
    const fail = (exitClass, message, extra = {}) => ({ ...base, usage: zero, durationMs: Date.now() - started, exitClass, message, ...extra })

    const url = String(env.OPENAI_COMPAT_BASE_URL || '').replace(/\/+$/, '')
    if (!url) return fail('runtime_error', 'OPENAI_COMPAT_BASE_URL is not set')
    let names, guard
    try {
      names = toolNames(req.role)
      guard = budgetGuard({ runtime: RUNTIME, model: req.model, budgetUsd: req.budgetUsd, maxTurns: req.maxTurns, wallClockMs: req.timeoutMs })
    } catch (e) { return fail('runtime_error', e.message) }
    const root = realpathSync(req.cwd || process.cwd())
    const nativeFormat = env.OPENAI_COMPAT_RESPONSE_FORMAT !== 'off'
    let estimated = false, raw = '', served = null
    const denials = []
    const messages = req.role && req.role.systemPrompt ? [{ role: 'system', content: req.role.systemPrompt }] : []

    const usageNow = () => ({ ...guard.usage(), ...(estimated ? { costSource: 'estimated' } : {}) })
    const stopped = () => { const b = guard.breach(); return { exitClass: b.exitClass, message: b.reason } }

    async function complete(body) {
      if (guard.turn()) return stopped()
      const ctl = new AbortController()
      const payload = JSON.stringify({ model: req.model, ...body })
      const timer = setTimeout(() => ctl.abort(), Math.max(0, guard.remainingMs()))
      let res, text
      try {
        res = await fetch(`${url}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(env.OPENAI_COMPAT_API_KEY ? { authorization: `Bearer ${env.OPENAI_COMPAT_API_KEY}` } : {}) },
          body: payload,
          signal: ctl.signal,
        })
        text = await res.text()
      } catch (e) {
        if (ctl.signal.aborted) { guard.check(); return { exitClass: 'timeout', message: `wall clock: no response within ${Math.round(guard.remainingMs() + (Date.now() - started))}ms` } }
        return { exitClass: 'runtime_error', message: `${RUNTIME} request failed: ${e.cause?.code || e.message}` }
      } finally { clearTimeout(timer) }
      raw = text.slice(0, RAW_MAX)
      if (!res.ok) return { exitClass: classifyHttp(res.status, text), status: res.status, message: `${RUNTIME} HTTP ${res.status}: ${text.slice(0, 500)}` }
      let json
      try { json = JSON.parse(text) } catch { return { exitClass: 'runtime_error', message: `${RUNTIME} returned non-JSON: ${text.slice(0, 200)}` } }
      served = json.model || served
      const u = json.usage
      const message = json.choices?.[0]?.message
      // A server that omits usage is still charged: about four characters per token each way.
      if (!u) estimated = true
      const cached = u?.prompt_tokens_details?.cached_tokens || 0
      const spent = u
        ? { in: (u.prompt_tokens || 0) - cached, out: u.completion_tokens || 0, cacheRead: cached }
        : { in: Math.ceil(payload.length / 4), out: Math.ceil(((message?.content || '') + (message?.tool_calls ? JSON.stringify(message.tool_calls) : '')).length / 4), cacheRead: 0 }
      if (guard.add(spent)) return stopped()
      if (!message) return { exitClass: 'runtime_error', message: `${RUNTIME} response has no choices[0].message` }
      return { exitClass: 'ok', message }
    }

    async function loop() {
      const tools = names.map(n => ({ type: 'function', function: { name: n, ...TOOL_DEFS[n] } }))
      for (;;) {
        const r = await complete(tools.length ? { messages, tools } : { messages })
        if (r.exitClass !== 'ok') return r
        const m = r.message
        messages.push({ role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) })
        if (!m.tool_calls?.length) return { exitClass: 'ok', text: m.content ?? '' }
        for (const tc of m.tool_calls) {
          const name = tc.function?.name
          let args = {}, content
          try { args = JSON.parse(tc.function?.arguments || '{}') } catch { content = 'error: arguments are not valid JSON' }
          if (content === undefined) {
            try {
              if (!names.includes(name)) throw new Denied('tool not granted to this lane')
              content = await runTool(name, args, { root, env })
            } catch (e) {
              if (e instanceof Denied) {
                denials.push({ tool: String(name), input: args, text: `Permission denied: ${name}(${denialArg(name, args)})` })
                content = `denied: ${e.message}`
              } else content = `error: ${e.message}`
            }
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content })
        }
        if (guard.check()) return stopped()
      }
    }

    // The repair turn continues the same conversation, tool-free, constrained by response_format when the
    // server accepts it; a server that rejects the field gets the same turn without it.
    async function repair(prompt) {
      messages.push({ role: 'user', content: prompt })
      const format = { response_format: { type: 'json_schema', json_schema: { name: 'lane_result', schema: req.schema, strict: true } } }
      let r = await complete(nativeFormat ? { messages, ...format } : { messages })
      if (nativeFormat && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 429 && REJECTS_FORMAT.test(r.message)) {
        r = await complete({ messages })
      }
      if (r.exitClass !== 'ok') return r
      messages.push({ role: 'assistant', content: r.message.content ?? '' })
      return { exitClass: 'ok', text: r.message.content ?? '' }
    }

    let calls = 0, before = usageNow()
    const turn = async prompt => {
      const r = calls++ === 0 ? (messages.push({ role: 'user', content: prompt }), await loop()) : await repair(prompt)
      const after = usageNow()
      const delta = { ...after }
      for (const k of ['in', 'out', 'cacheRead', 'cacheCreate', 'costUsd']) delta[k] = after[k] - before[k]
      before = after
      return { ...r, usage: delta }
    }

    const out = await schemaFallback({ prompt: req.prompt, schema: req.schema, turn })
    const { status, text, ...rest } = out
    return { ...base, ...rest, model: served || req.model, denials, raw, durationMs: Date.now() - started }
  },
}
