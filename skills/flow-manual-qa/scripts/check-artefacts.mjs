#!/usr/bin/env node
// Proves that the evidence an agent cites for `observed-by-agent` exists, was written by this run,
// and holds something. A cited file that is missing, empty, or older than the run start proves
// nothing about this run.
//
//   check-artefacts.mjs --since <ISO-8601 run start> <path> [<path> ...]
//
// stdout: one JSON line. A completed check is status `ok` whether or not every artefact passed;
// `pass` and `failures` carry the result. Bad usage is status `error`, kind `script-error`.

import { statSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STDOUT_CAP = 4096

export function checkArtefacts(paths, sinceMs) {
  const failures = []
  for (const p of paths) {
    let st
    try {
      st = statSync(p)
    } catch {
      failures.push({ path: p, problem: 'missing' })
      continue
    }
    if (!st.isFile()) failures.push({ path: p, problem: 'not-a-file' })
    else if (st.size === 0) failures.push({ path: p, problem: 'empty' })
    else if (st.mtimeMs < sinceMs) failures.push({ path: p, problem: 'older-than-run', mtime: st.mtime.toISOString() })
  }
  return { checked: paths.length, pass: failures.length === 0, failures }
}

export function parseArgs(argv) {
  const paths = []
  let since = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') {
      since = argv[++i] ?? null
      continue
    }
    paths.push(argv[i])
  }
  if (!since) return { error: 'usage: check-artefacts.mjs --since <ISO-8601 run start> <path> [<path> ...]' }
  const sinceMs = Date.parse(since)
  if (Number.isNaN(sinceMs)) return { error: `--since is not a timestamp: ${since}` }
  if (paths.length === 0) return { error: 'no artefact paths given' }
  return { since: new Date(sinceMs).toISOString(), sinceMs, paths }
}

export function run(argv) {
  const args = parseArgs(argv)
  if (args.error) return { doc: { status: 'error', kind: 'script-error', reason: args.error }, code: 1 }
  const result = checkArtefacts(args.paths.map(p => resolve(p)), args.sinceMs)
  let doc = { status: 'ok', since: args.since, ...result }
  if (JSON.stringify(doc).length >= STDOUT_CAP) {
    const file = join(mkdtempSync(join(tmpdir(), 'check-artefacts-')), 'result.json')
    writeFileSync(file, JSON.stringify(doc, null, 2))
    doc = { status: 'ok', since: args.since, checked: result.checked, pass: result.pass, failureCount: result.failures.length, artifact: file }
  }
  return { doc, code: 0 }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { doc, code } = run(process.argv.slice(2))
  if (doc.reason) process.stderr.write(`${doc.reason}\n`)
  process.stdout.write(`${JSON.stringify(doc)}\n`)
  process.exit(code)
}
