#!/usr/bin/env node
// Classify raw tool/agent error text (plus an optional exit code) into a closed failure kind.
//
//   classify-failure.mjs <text-file> [--exit-code N]
//
// Reads the whole file as the error text (a shell argument would need re-escaping multiline
// text that already arrived pre-escaped from a tool result, so a file is the stable contract).
// Prints one script-result line and exits with that kind's own exit code from kinds.json. Text
// that matches nothing known is not a script error: it is a successful classification whose
// answer is "no known kind", so it exits 0.
//
// Detects only the kinds this repo has real transcript evidence for (docs/harness.md +
// 05-plan.md §4): harness-blocked, usage-limit, rate-limit, ci-infra. Everything else in
// kinds.json is derived by other scripts or the runner, never from free text here.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const patterns = JSON.parse(readFileSync(join(HERE, 'patterns.json'), 'utf8'))
export const kinds = JSON.parse(readFileSync(join(HERE, '..', 'contract', 'kinds.json'), 'utf8'))

const statusForExit = Object.fromEntries(Object.entries(kinds.statuses).map(([name, code]) => [code, name]))

// The first kind (in `order`) with a matching pattern wins. Patterns are disjoint by
// construction (checked by the self-test corpus), so order only matters for pathological text.
export function classify(text) {
  for (const kind of patterns.order) {
    for (const p of patterns.kinds[kind]) {
      if (new RegExp(p, 'i').test(text)) return { kind, pattern: p }
    }
  }
  return { kind: null, pattern: null }
}

// Best-effort reset time for a usage-limit hit: a full ISO timestamp in the text, or a bare
// "HH:MMZ" (the shape seen in transcripts, "resets 15:40Z") combined with today's UTC date.
// Ambiguous or missing text just means no `retryAfter`, never a guessed one.
function resetTime(text) {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/)
  if (iso) return iso[0]
  const bare = text.match(/\b(\d{2}):(\d{2})Z\b/)
  if (bare) return `${new Date().toISOString().slice(0, 10)}T${bare[1]}:${bare[2]}:00Z`
  return null
}

export function classifyResult(text, exitCode) {
  if (exitCode === 0) return { status: 'ok', matched: false, reason: 'exit code 0: not a failure' }
  const { kind, pattern } = classify(text)
  if (!kind) return { status: 'ok', matched: false, reason: 'no known failure pattern matched' }
  const exit = kinds.kinds[kind].exit
  const result = { status: statusForExit[exit], kind, matched: true, reason: `matched /${pattern}/i` }
  if (kind === 'usage-limit') {
    const retryAfter = resetTime(text)
    if (retryAfter) result.retryAfter = retryAfter
  }
  return result
}

function main() {
  const args = process.argv.slice(2)
  const exitFlagIdx = args.indexOf('--exit-code')
  const exitCode = exitFlagIdx >= 0 ? Number(args[exitFlagIdx + 1]) : undefined
  const file = exitFlagIdx >= 0 ? args.filter((_, i) => i !== exitFlagIdx && i !== exitFlagIdx + 1)[0] : args[0]
  if (!file) {
    process.stderr.write('usage: classify-failure.mjs <text-file> [--exit-code N]\n')
    process.exit(1)
  }
  const text = readFileSync(file, 'utf8')
  const result = classifyResult(text, exitCode)
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(kinds.statuses[result.status])
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
