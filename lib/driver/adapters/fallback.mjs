// Schema fallback (F) for a runtime without native structured output: ask for one JSON object, extract
// it, validate it with the contract validator, allow one repair call, else exitClass 'schema'.

import { validate } from '../../contract/validate.mjs'

export function schemaInstruction(schema) {
  return '\n\nYour final message must be ONE JSON object matching this JSON Schema, with no prose and no code fences:\n' + JSON.stringify(schema)
}

function lastFence(text) {
  const fences = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  return fences.length ? fences[fences.length - 1][1] : null
}

// Scans backwards for each `}` and forwards from each `{` before it; the first span that parses wins.
function lastBalanced(text) {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      const span = balancedFrom(text, start)
      if (span !== null && start + span.length - 1 === end) {
        try { return JSON.parse(span) } catch {}
      }
    }
  }
  return null
}

function balancedFrom(text, start) {
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export function extractJson(text) {
  const s = String(text ?? '')
  const fenced = lastFence(s)
  if (fenced !== null) {
    try {
      const v = JSON.parse(fenced)
      return isObject(v) ? v : null
    } catch { return null }
  }
  const v = lastBalanced(s)
  return isObject(v) ? v : null
}

const SOURCES = ['reported', 'computed', 'estimated', 'unknown']

export function sumUsage(list) {
  const out = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0, costSource: 'reported' }
  for (const u of list.filter(Boolean)) {
    for (const k of ['in', 'out', 'cacheRead', 'cacheCreate', 'costUsd']) out[k] += u[k] || 0
    if (SOURCES.indexOf(u.costSource) > SOURCES.indexOf(out.costSource)) out.costSource = u.costSource
  }
  return out
}

function check(schema, text) {
  const doc = extractJson(text)
  if (!doc) return { errors: ['no JSON object found in the final message'] }
  const errors = validate(schema, doc)
  return errors.length ? { errors } : { doc }
}

// `turn(prompt)` is one runtime call: { exitClass, text, usage, ...rest }. Anything but 'ok' passes through.
export async function schemaFallback({ prompt, schema, turn }) {
  const first = await turn(prompt + schemaInstruction(schema))
  if (first.exitClass !== 'ok') return { ...first, structured: null }
  const a = check(schema, first.text)
  if (a.doc) return { ...first, structured: a.doc }

  const repair = `${prompt}${schemaInstruction(schema)}\n\nYour previous final message was:\n${String(first.text ?? '').slice(0, 8000)}\n\nIt was rejected:\n${a.errors.join('\n')}\nAnswer again with the corrected JSON object only.`
  const second = await turn(repair)
  const usage = sumUsage([first.usage, second.usage])
  const durationMs = (first.durationMs || 0) + (second.durationMs || 0)
  if (second.exitClass !== 'ok') return { ...second, usage, durationMs, structured: null }
  const b = check(schema, second.text)
  if (b.doc) return { ...second, usage, durationMs, structured: b.doc }
  return { ...second, usage, durationMs, structured: null, exitClass: 'schema', message: `schema fallback failed twice: ${b.errors.join('; ')}` }
}
