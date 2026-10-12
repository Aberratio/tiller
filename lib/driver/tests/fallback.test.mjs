import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, schemaFallback, schemaInstruction, sumUsage } from '../adapters/fallback.mjs'
import { loadSchema } from '../../contract/validate.mjs'

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, n: { type: 'integer' } }, required: ['verdict'], additionalProperties: false }
const use = (n, costUsd = 0, costSource = 'computed') => ({ in: n, out: n, cacheRead: 0, cacheCreate: 0, costUsd, costSource })

test('F2: the last fenced json block wins over an earlier one and over prose braces', () => {
  const text = 'first try:\n```json\n{"verdict":"fail"}\n```\nno wait, {not json}\n```json\n{"verdict":"pass"}\n```\ndone'
  assert.deepEqual(extractJson(text), { verdict: 'pass' })
})

test('F2: with no fence, the last balanced object is taken, braces inside strings do not end it', () => {
  assert.deepEqual(extractJson('I think {"a":1} then finally {"verdict":"pass","note":"a } inside"} ok'), { verdict: 'pass', note: 'a } inside' })
  assert.deepEqual(extractJson('outer {"verdict":"pass","inner":{"x":1}}'), { verdict: 'pass', inner: { x: 1 } })
})

test('F2: nothing parseable is null, never a partial guess', () => {
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson('{"verdict": "pass"'), null)
  assert.equal(extractJson('```json\n[1,2]\n```'), null)
})

test('F1: the instruction carries the schema verbatim and demands one bare object', () => {
  const s = schemaInstruction(SCHEMA)
  assert.ok(s.includes(JSON.stringify(SCHEMA)))
  assert.match(s, /ONE JSON object/)
})

test('F3: a valid first answer is one call, validated against the lane schema', async () => {
  const prompts = []
  const r = await schemaFallback({ prompt: 'judge', schema: SCHEMA, turn: async p => { prompts.push(p); return { exitClass: 'ok', text: '{"verdict":"pass"}', usage: use(10, 0.01) } } })
  assert.equal(r.exitClass, 'ok')
  assert.deepEqual(r.structured, { verdict: 'pass' })
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].startsWith('judge'))
  assert.ok(prompts[0].includes(JSON.stringify(SCHEMA)))
})

test('F4: one repair call carries the invalid output and the validator errors; usage is summed over both', async () => {
  const prompts = []
  const answers = ['{"verdict":"maybe"}', '{"verdict":"fail"}']
  const r = await schemaFallback({ prompt: 'judge', schema: SCHEMA, turn: async p => { prompts.push(p); return { exitClass: 'ok', text: answers[prompts.length - 1], usage: use(10, 0.01) } } })
  assert.equal(r.exitClass, 'ok')
  assert.deepEqual(r.structured, { verdict: 'fail' })
  assert.equal(prompts.length, 2)
  assert.ok(prompts[1].includes('{"verdict":"maybe"}'))
  assert.match(prompts[1], /not in enum/)
  assert.deepEqual(r.usage, use(20, 0.02))
})

test('F4: a second failure is exitClass schema, with no structured result and both calls counted; there is no third call', async () => {
  let calls = 0
  const r = await schemaFallback({ prompt: 'judge', schema: SCHEMA, turn: async () => { calls++; return { exitClass: 'ok', text: 'I refuse to answer in JSON', usage: use(5) } } })
  assert.equal(calls, 2)
  assert.equal(r.exitClass, 'schema')
  assert.equal(r.structured, null)
  assert.equal(r.usage.in, 10)
  assert.match(r.message, /no JSON object/)
})

test('a runtime failure on either call is passed through, never repaired', async () => {
  let calls = 0
  const r = await schemaFallback({ prompt: 'judge', schema: SCHEMA, turn: async () => { calls++; return { exitClass: 'budget', message: 'cap hit', usage: use(7) } } })
  assert.equal(calls, 1)
  assert.equal(r.exitClass, 'budget')
  assert.equal(r.message, 'cap hit')
})

test('additionalProperties:false is enforced, as the lane schemas rely on it', async () => {
  let calls = 0
  const r = await schemaFallback({ prompt: 'judge', schema: SCHEMA, turn: async () => { calls++; return { exitClass: 'ok', text: '{"verdict":"pass","extra":1}', usage: use(1) } } })
  assert.equal(r.exitClass, 'schema')
  assert.match(r.message, /unexpected "extra"/)
})

test('a real lane schema validates through the same contract validator', async () => {
  const schema = loadSchema('lane-premise')
  const r = await schemaFallback({ prompt: 'p', schema, turn: async () => ({ exitClass: 'ok', text: '{}', usage: use(1) }) })
  assert.equal(r.exitClass, 'schema')
  assert.match(r.message, /missing/)
})

test('sumUsage: an unknown source anywhere makes the sum unknown; reported plus computed is computed', () => {
  assert.equal(sumUsage([use(1, 0, 'reported'), use(1, 0, 'unknown')]).costSource, 'unknown')
  assert.equal(sumUsage([use(1, 0, 'reported'), use(1, 0, 'computed')]).costSource, 'computed')
  assert.equal(sumUsage([use(1, 0, 'computed'), use(1, 0, 'estimated')]).costSource, 'estimated')
  assert.equal(sumUsage([use(1, 0, 'estimated'), use(1, 0, 'unknown')]).costSource, 'unknown')
  assert.equal(sumUsage([use(1, 0, 'reported'), use(1, 0, 'reported')]).costSource, 'reported')
})
