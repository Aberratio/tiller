#!/usr/bin/env node
// Contract validator for the harness.
//
//   node lib/contract/validate.mjs                          self-check: kinds, exit codes, schemas, fixtures
//   node lib/contract/validate.mjs <schema> [file|-] [--exit N]
//                                                           validate one document; prints one script-result line
//
// Schemas use a closed subset of JSON Schema (KEYWORDS below). A schema that needs more is a
// contract change, not a validator patch: the same schemas are handed to agents as output
// schemas, and a smaller vocabulary keeps them under the size threshold.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitingRules, isQuotedRefusal } from './awaiting.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMAS = join(HERE, 'schemas')
const FIXTURES = join(HERE, 'fixtures')
const KEYWORDS = new Set([
  '$id', 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'pattern', 'minimum', 'description',
])

const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
export const kinds = readJson(join(HERE, 'kinds.json'))
export const loadSchema = name => readJson(join(SCHEMAS, `${name}.json`))
export const schemaNames = () => readdirSync(SCHEMAS).filter(f => f.endsWith('.json')).map(f => basename(f, '.json')).sort()

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const typeOk = (want, v) => {
  const t = typeOf(v)
  return [].concat(want).some(w => w === t || (w === 'number' && t === 'integer'))
}

export function checkSchemaKeywords(schema, at = '$') {
  const bad = []
  for (const k of Object.keys(schema)) if (!KEYWORDS.has(k)) bad.push(`${at}: unsupported keyword "${k}"`)
  for (const [k, v] of Object.entries(schema.properties || {})) bad.push(...checkSchemaKeywords(v, `${at}.${k}`))
  if (schema.items) bad.push(...checkSchemaKeywords(schema.items, `${at}[]`))
  return bad
}

export function validate(schema, doc, at = '$') {
  const errs = []
  if (schema.type && !typeOk(schema.type, doc)) return [`${at}: expected ${[].concat(schema.type).join('|')}, got ${typeOf(doc)}`]
  if (schema.enum && !schema.enum.includes(doc)) errs.push(`${at}: ${JSON.stringify(doc)} not in enum`)
  if (schema.pattern && typeof doc === 'string' && !new RegExp(schema.pattern).test(doc)) errs.push(`${at}: does not match ${schema.pattern}`)
  if (schema.minimum !== undefined && typeof doc === 'number' && doc < schema.minimum) errs.push(`${at}: below ${schema.minimum}`)
  if (typeOf(doc) === 'object') {
    const props = schema.properties || {}
    for (const r of schema.required || []) if (!(r in doc)) errs.push(`${at}: missing "${r}"`)
    for (const [k, v] of Object.entries(doc)) {
      if (props[k]) errs.push(...validate(props[k], v, `${at}.${k}`))
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`)
    }
  }
  if (typeOf(doc) === 'array' && schema.items) doc.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)))
  return errs
}

// Rules a JSON Schema subset cannot express. They carry the two guarantees the harness depends
// on most: a script's status and kind agree with its exit code, and a harness block is never
// shaped as a question someone could answer.
function waitingItem(item, at, fromLane = false) {
  const errs = []
  if (item.kind === 'harness-blocked') {
    if ((item.options || []).length) errs.push(`${at}: harness-blocked carries no options; nobody is asked`)
    if (fromLane && !isQuotedRefusal(item.why, awaitingRules())) errs.push(`${at}: harness-blocked needs the refused tool call quoted literally in "why"; anything else is a note`)
  } else if (!(item.violations || []).length) {
    if ((item.options || []).length < 2) errs.push(`${at}: needs at least two options`)
    for (const f of ['recommendation', 'reversalCost']) if (!item[f]) errs.push(`${at}: missing "${f}"`)
  }
  return errs
}

// A decision either carries a request that passed the linter or lists the rules its fields broke.
function decision(doc) {
  const errs = []
  if (doc.request && doc.violations) errs.push('$: a request that passed the linter carries no violations')
  if (doc.violations && !doc.violations.length) errs.push('$.violations: empty; omit it')
  if (doc.request) errs.push(...check('hitl-request', doc.request).map(e => e.replace(/^\$/, '$.request')))
  return errs
}

function hitlRequest(doc, at) {
  const errs = []
  const n = (doc.options || []).length
  if (n < 2 || n > 4) errs.push(`${at}.options: ${n} options, needs 2 to 4`)
  const keys = (doc.options || []).map(o => o && o.key)
  if (new Set(keys).size !== keys.length) errs.push(`${at}.options: option keys repeat`)
  if (!(doc.links || []).length) errs.push(`${at}.links: needs at least one link`)
  for (const [k, v] of Object.entries(doc.glossary || {})) if (typeof v !== 'string') errs.push(`${at}.glossary.${k}: expected string`)
  if (doc.kind !== undefined && !kinds.kinds[doc.kind]) errs.push(`${at}.kind: "${doc.kind}" not in kinds.json`)
  const dk = doc.ifNoAnswer && doc.ifNoAnswer.defaultKey
  if (dk && !keys.includes(dk)) errs.push(`${at}.ifNoAnswer.defaultKey: "${dk}" is not an option key`)
  return errs
}

export function semantic(name, doc, exitCode) {
  const errs = []
  if (name === 'hitl-request') errs.push(...hitlRequest(doc, '$'))
  if (name === 'script-result') {
    const code = kinds.statuses[doc.status]
    if (exitCode !== undefined && exitCode !== code) errs.push(`$.status: "${doc.status}" means exit ${code}, got ${exitCode}`)
    if (!['ok', 'pending'].includes(doc.status) && !doc.kind) errs.push(`$: status "${doc.status}" needs a kind`)
    if (doc.kind) {
      const k = kinds.kinds[doc.kind]
      if (k && k.exit === null) errs.push(`$.kind: "${doc.kind}" is never a script outcome`)
      else if (k && k.exit !== code) errs.push(`$.kind: "${doc.kind}" exits ${k.exit}, status "${doc.status}" exits ${code}`)
    }
  }
  if (name === 'decision') errs.push(...waitingItem(doc, '$'), ...decision(doc))
  if (name.startsWith('lane-') && Array.isArray(doc.awaiting)) doc.awaiting.forEach((a, i) => errs.push(...waitingItem(a, `$.awaiting[${i}]`, true)))
  if (name === 'lane-owner-proxy') {
    if (doc.action === 'act' && (!doc.mandate || doc.parkReason)) errs.push('$: act needs a mandate and no parkReason')
    if (doc.action === 'park' && (doc.mandate || !doc.parkReason)) errs.push('$: park needs a parkReason and no mandate')
    if (doc.action === 'act' && (doc.conditions || []).some(c => c.met === false)) errs.push('$: act with an unmet condition')
  }
  if (name === 'lane-resolver' && doc.park === false && doc.inviolable) errs.push('$: an inviolable touched means park')
  if (name === 'lane-exec' && doc.ran === false && !doc.denial) errs.push('$: ran=false needs the literal denial')
  if (name === 'lane-exec' && doc.ran === true && doc.exitCode === null) errs.push('$: ran=true needs an exitCode')
  return errs
}

export function check(name, doc, exitCode) {
  return [...validate(loadSchema(name), doc), ...semantic(name, doc, exitCode)]
}

// ---------------------------------------------------------------- self-check

// Every failure class named in the plan's fallback and loop tables. Removing one from kinds.json
// breaks a consumer somewhere; the list makes that a test failure instead.
const REQUIRED_KINDS = [
  'usage-limit', 'rate-limit', 'quota', 'context-exhaustion', 'schema', 'ci-red', 'ci-infra', 'ci-timeout',
  'conflict', 'harness-blocked', 'ready-to-sign', 'claim-mismatch', 'premise', 'run-died', 'split',
  'confidence-cap', 'ceiling', 'no-progress', 'duplicate', 'budget-exhausted',
]
const VOCAB = {
  kind: Object.keys(kinds.kinds), phase: kinds.phases, lastPhase: kinds.phases, lane: kinds.lanes, tier: kinds.tiers,
  outcome: kinds.callOutcomes, authority: kinds.authorities, state: kinds.gateStates,
  mandate: ['', ...kinds.mandates], parkReason: ['', ...kinds.parkReasons],
}

function enumChecks(name, schema) {
  const errs = []
  const walk = (node, at) => {
    for (const [k, v] of Object.entries(node.properties || {})) {
      if (v.enum && VOCAB[k]) {
        const stray = v.enum.filter(e => !VOCAB[k].includes(e))
        if (stray.length) errs.push(`${at}.${k}: ${stray.join(', ')} not in kinds.json`)
      }
      walk(v, `${at}.${k}`)
      if (v.items) walk(v.items, `${at}.${k}[]`)
    }
  }
  walk(schema, '$')
  if (name === 'script-result' && JSON.stringify(schema.properties.status.enum) !== JSON.stringify(Object.keys(kinds.statuses)))
    errs.push('$.status: enum differs from kinds.json statuses')
  if (name.startsWith('lane-') && name !== 'lane-exec') {
    const want = Object.keys(kinds.kinds).filter(k => kinds.kinds[k].agentMayEmit).sort()
    const got = [...(schema.properties.awaiting?.items?.properties?.kind?.enum || [])].sort()
    if (JSON.stringify(want) !== JSON.stringify(got)) errs.push(`$.awaiting.kind: enum ${got} differs from agentMayEmit ${want}`)
  }
  return errs
}

function kindChecks(k) {
  const codes = Object.values(k.statuses)
  const errs = []
  for (const [name, v] of Object.entries(k.kinds)) {
    if (v.exit !== null && !codes.includes(v.exit)) errs.push(`${name}: exit ${v.exit} unknown`)
    if (!k.escalate[v.escalate]) errs.push(`${name}: escalate "${v.escalate}" unknown`)
    if (v.retry.cap && !k.caps[v.retry.cap]) errs.push(`${name}: cap "${v.retry.cap}" unknown`)
    if (v.escalate === 'never' && v.ceiling) errs.push(`${name}: never escalated yet counted toward the ceiling`)
  }
  const hb = k.kinds['harness-blocked'] || {}
  const usage = k.kinds['usage-limit'] || {}
  return [
    ['kinds cover every plan failure class', REQUIRED_KINDS.filter(n => !k.kinds[n]).map(n => `missing ${n}`)],
    ['every kind names a known exit, escalation and cap', errs],
    ['harness-blocked: never escalated, outside the ceiling, one identical retry', [
      hb.escalate !== 'never' && 'escalate must be never', hb.ceiling !== false && 'ceiling must be false',
      (hb.retry?.mode !== 'identical' || hb.retry?.max !== 1) && 'retry must be identical x1', hb.exit !== k.statuses.blocked && 'exit must be blocked',
    ].filter(Boolean)],
    ['ready-to-sign and quota sit outside the ceiling', ['ready-to-sign', 'quota'].filter(n => k.kinds[n]?.ceiling !== false).map(n => `${n} counted`)],
    ['usage-limit is a pause, never a park', usage.escalate === 'never' && usage.exit === k.statuses['paused-usage'] ? [] : ['usage-limit must exit paused-usage and never escalate']],
  ]
}

function selfCheck() {
  const results = []
  const t = (label, errs) => results.push({ label, errs })

  const md = readFileSync(join(HERE, 'exit-codes.md'), 'utf8')
  const table = Object.fromEntries([...md.matchAll(/^\|\s*(\d+)\s*\|\s*`([a-z-]+)`\s*\|/gm)].map(m => [m[2], Number(m[1])]))
  t('exit-codes.md table equals kinds.json statuses', JSON.stringify(table) === JSON.stringify(kinds.statuses) ? [] : [`md ${JSON.stringify(table)}`])

  for (const [label, errs] of kindChecks(kinds)) t(label, errs)
  // The invariants must bite: each mutation below has to make kindChecks fail.
  const mutations = {
    'harness-blocked escalated to the chain': k => { k.kinds['harness-blocked'].escalate = 'chain' },
    'harness-blocked counted toward the ceiling': k => { k.kinds['harness-blocked'].ceiling = true },
    'usage-limit removed': k => { delete k.kinds['usage-limit'] },
    'usage-limit made a park': k => { k.kinds['usage-limit'].escalate = 'chain' },
    'ready-to-sign counted toward the ceiling': k => { k.kinds['ready-to-sign'].ceiling = true },
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const copy = structuredClone(kinds)
    mutate(copy)
    t(`mutation caught: ${label}`, kindChecks(copy).some(([, e]) => e.length) ? [] : ['not caught'])
  }

  const self = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'script-result', '-'], { input: '{"status":"blocked"}' })
  let line
  try { line = JSON.parse(String(self.stdout)) } catch { line = null }
  t('validate.mjs follows the script contract when it refuses', line ? check('script-result', line, self.status) : ['stdout is not one JSON line'])

  const facts = readFileSync(join(HERE, '..', 'profile-facts.sh'), 'utf8').match(/^MANDATES='([^']*)'/m)
  t('profile-facts.sh mandates equal kinds.json mandates', facts && facts[1].split(' ').join() === kinds.mandates.join() ? [] : ['differ'])

  const names = schemaNames()
  t('every lane has a schema', kinds.lanes.filter(l => !names.includes(`lane-${l}`)).map(l => `missing lane-${l}.json`))
  const limit = kinds.caps.schemaBytes.default
  for (const name of names) {
    const schema = loadSchema(name)
    const bytes = Buffer.byteLength(JSON.stringify(schema))
    t(`${name}: ${bytes} B < ${limit} B, subset keywords, vocabulary`, [
      ...(bytes >= limit ? [`${bytes} B`] : []), ...checkSchemaKeywords(schema), ...(schema.$id !== name ? ['$id differs from file name'] : []),
      ...enumChecks(name, schema),
    ])
    const dir = join(FIXTURES, name)
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : []
    const valid = files.filter(f => f.startsWith('valid-')), invalid = files.filter(f => f.startsWith('invalid-'))
    t(`${name}: has valid and invalid fixtures`, valid.length && invalid.length ? [] : [`valid ${valid.length}, invalid ${invalid.length}`])
    for (const f of valid) t(`${name}/${f} passes`, check(name, readJson(join(dir, f))))
    for (const f of invalid) t(`${name}/${f} is rejected`, check(name, readJson(join(dir, f))).length ? [] : ['accepted'])
  }

  const failed = results.filter(r => r.errs.length)
  for (const r of results) {
    console.log(`${r.errs.length ? 'FAIL' : 'ok  '} ${r.label}`)
    for (const e of r.errs) console.log(`       ${e}`)
  }
  console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} checks failed` : `PASS: ${results.length} checks`)
  process.exit(failed.length ? 1 : 0)
}

function cli(argv) {
  const out = (code, obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(code) }
  const exitAt = argv.indexOf('--exit')
  const exitCode = exitAt >= 0 ? Number(argv.splice(exitAt, 2)[1]) : undefined
  const [name, file = '-'] = argv
  if (!schemaNames().includes(name)) out(4, { status: 'refused', kind: 'policy', reason: `unknown schema "${name}"` })
  let doc
  try {
    doc = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))
  } catch (e) {
    out(4, { status: 'refused', kind: 'policy', reason: `unreadable JSON: ${e.message}` })
  }
  const errors = check(name, doc, exitCode)
  if (errors.length) out(4, { status: 'refused', kind: 'policy', reason: 'schema violation', errors })
  out(0, { status: 'ok', schema: name })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.argv.length > 2 ? cli(process.argv.slice(2)) : selfCheck()
}
