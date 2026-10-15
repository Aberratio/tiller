#!/usr/bin/env node
// Gate evaluator: merge authority over the touched paths plus the profile's declared gates.
//
//   node lib/gates/evaluate.mjs <input.json | ->
//
// Input:  { facts: {mergeAuthority, gates}, headSha, files: [path],
//           observations: { <gate name>: {state, headSha, evidence} },
//           preconditions: { <precondition text>: {met, evidence} } }
// Output: one script-result line whose payload is a gate-result (lib/contract/schemas).
//         Exit 0 whenever the evaluation ran, whatever it concluded; 1 on unusable input.
//
// Everything above the CLI section is dependency-free on purpose: the driver imports these
// functions as a plain module, and nothing in them touches the filesystem.

const RANK = { agent: 0, human: 1, unconfirmed: 2 }
const stricter = (a, b) => (RANK[a] >= RANK[b] ? a : b)

export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '')
  if (g === '**') return /^.*$/
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      // `dir/**` covers the directory's descendants; `**/x` covers x at any depth.
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Literal characters only: the row naming a path more precisely wins over "everything else".
const specificity = glob => glob.replace(/\*+|\?/g, '').length

export function unlistedAuthority(mergeAuthority) {
  return (mergeAuthority || []).reduce((acc, row) => stricter(acc, row.who), 'human')
}

// The row that governs one file, or null when no row lists it.
export function governingRow(file, mergeAuthority) {
  let best = null
  for (const row of mergeAuthority || []) {
    for (const glob of row.globs || []) {
      if (!globToRegExp(glob).test(file)) continue
      const s = specificity(glob)
      if (!best || s > best.s || (s === best.s && RANK[row.who] > RANK[best.row.who])) best = { row, s }
    }
  }
  return best ? best.row : null
}

export function authorityOf(file, mergeAuthority) {
  const row = governingRow(file, mergeAuthority)
  return row ? row.who : unlistedAuthority(mergeAuthority)
}

export function evaluate({ facts, headSha, files, observations = {}, preconditions = {} }) {
  const mergeAuthority = facts.mergeAuthority || []
  const gates = facts.gates || []
  const touched = Array.isArray(files) ? files : []

  // Authority is derived from the touched paths, so without them it cannot be agent.
  let authority = touched.length ? 'agent' : Object.keys(RANK).reduce(stricter)
  const humanPaths = []
  const pending = new Map()
  for (const file of touched) {
    const row = governingRow(file, mergeAuthority)
    const who = row ? row.who : unlistedAuthority(mergeAuthority)
    authority = stricter(authority, who)
    if (who !== 'agent') humanPaths.push(file)
    else if (row.precondition) {
      const list = pending.get(row.precondition) || []
      list.push(file)
      pending.set(row.precondition, list)
    }
  }

  const conditions = gates.map(gate => {
    const source = `${gate.source.type}: ${gate.source.ref}`
    const o = observations[gate.name]
    if (!o) return { name: gate.name, state: 'blocked', source, evidence: 'no observation' }
    if (!['green', 'red', 'blocked'].includes(o.state))
      return { name: gate.name, state: 'blocked', source, evidence: `unreadable state ${JSON.stringify(o.state)}` }
    if (o.headSha !== headSha)
      return { name: gate.name, state: 'blocked', source, evidence: `observed on ${o.headSha || 'no sha'}, head is ${headSha}` }
    return { name: gate.name, state: o.state, source, evidence: String(o.evidence || '') }
  })

  for (const [text, paths] of pending) {
    const p = preconditions[text]
    conditions.push({
      name: `precondition: ${text}`,
      state: p && p.met === true ? 'green' : 'blocked',
      source: 'merge authority',
      evidence: p && p.met === true ? String(p.evidence || '') : `not confirmed; touched ${paths.join(', ')}`,
    })
  }

  if (!touched.length)
    conditions.push({
      name: 'touched-paths',
      state: 'blocked',
      source: 'merge authority',
      evidence: `no changed files ${Array.isArray(files) ? 'listed' : 'known'}; authority cannot be derived from the paths, so it is ${authority} (signature required)`,
    })

  const allGreen = gates.length > 0 && conditions.every(c => c.state === 'green')
  return {
    headSha,
    authority,
    conditions,
    humanPaths,
    mergeAllowed: authority === 'agent' && allGreen,
    readyToSign: authority !== 'agent' && allGreen,
  }
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const { readFileSync } = await import('node:fs')
  const { check } = await import('../contract/validate.mjs')
  const fail = reason => {
    process.stdout.write(JSON.stringify({ status: 'error', kind: 'script-error', reason }) + '\n')
    process.exit(1)
  }
  if (argv.length !== 1) fail('usage: evaluate.mjs <input.json | ->')
  let input
  try { input = JSON.parse(readFileSync(argv[0] === '-' ? 0 : argv[0], 'utf8')) } catch (e) { fail(`input: ${e.message}`) }
  if (!input || !input.facts || !Array.isArray(input.facts.mergeAuthority)) fail('input.facts.mergeAuthority missing')
  if (!Array.isArray(input.facts.gates) || input.facts.gates.length === 0) fail('input.facts.gates missing or empty')
  if (!Array.isArray(input.files) || input.files.length === 0) fail('input.files missing or empty')
  const result = evaluate(input)
  const errs = check('gate-result', result)
  if (errs.length) fail(`gate-result invalid: ${errs.join('; ')}`)
  process.stdout.write(JSON.stringify({ status: 'ok', ...result }) + '\n')
}

import { fileURLToPath } from 'node:url'
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2))
