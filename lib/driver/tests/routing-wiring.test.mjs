import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { NO_TRACKER, buildArgs, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { createContext, Stop } from '../core.mjs'
import { exec, lane } from '../runtime.mjs'
import { journalPath, readJournal } from '../journal.mjs'
import { check } from '../../contract/validate.mjs'

let TMP, LOG, ORIGINAL_PATH, ARGS, WT
const LIMITS = JSON.parse(readFileSync(new URL('../../../config/prices.json', import.meta.url), 'utf8')).limits

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { ok: true, awaiting: [], questions: [] }, total_cost_usd: 0, duration_ms: 1, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {} }))
`

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'routing-wiring-'))
  const bin = join(TMP, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  LOG = join(TMP, 'argv.jsonl')
  process.env.FAKE_CLAUDE_LOG = LOG
  ORIGINAL_PATH = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${ORIGINAL_PATH}`
  WT = join(TMP, 'wt')
  mkdirSync(WT)
  writeFileSync(join(TMP, 'spec.md'), '# spec\n')
  ARGS = buildArgs(tmpRoot('routing-wiring'))
})
after(() => { process.env.PATH = ORIGINAL_PATH; rmSync(TMP, { recursive: true, force: true }) })

const calls = () => readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const roleOf = (args, name) => name === 'resolver' ? args.agents?.resolver : name === 'owner-proxy' ? args.agents?.ownerProxy : undefined

function context(args, runtime = {}) {
  const c = createContext(args, { lane, exec, log: () => {}, ...runtime })
  c.cur = 'plan'
  c.out.start = { branch: 'b' }
  c.wt = WT
  return c
}

test('args carry the router state: catalogue, lanes, launch time and runtime availability', () => {
  const r = ARGS.router
  assert.ok(r && r.catalogue && r.catalogue.models && r.lanes && r.lanes.lanes, JSON.stringify(Object.keys(ARGS)))
  assert.ok(!Number.isNaN(Date.parse(r.state.asOf)))
  assert.equal(r.state.runtimes.claude.available, true)
  assert.deepEqual(Object.keys(r.state.runtimes).sort(), ['claude', 'codex', 'openai-compat'])
})

test('a profile tier override survives routing: the overridden model is the lane\'s first candidate', async () => {
  const profile = join(TMP, 'override.md')
  writeFileSync(profile, readFileSync(NO_TRACKER, 'utf8').replace(/## model routing\n\nnone\n/, '## model routing\n\n| Lane | Tier |\n|---|---|\n| pr-description | T1 |\n'))
  const args = buildArgs(tmpRoot('routing-override'), { profile, spec: join(TMP, 'spec.md') })
  assert.equal(args.routing['pr-description'].tier, 'T1')
  writeFileSync(LOG, '')
  await context(args).lane('pr-description', 'p', null)
  assert.equal(calls()[0][calls()[0].indexOf('--model') + 1], args.tiers.T1)
})

test('under the Claude-only catalogue every lane runs with the argv of the tier routing it replaced', async () => {
  for (const [name, r] of Object.entries(ARGS.routing)) {
    const agentType = roleOf(ARGS, name)
    writeFileSync(LOG, '')
    const c = context(ARGS)
    const got = await c.lane(name, `prompt for ${name}`, null, { agentType, noEscalation: true })
    assert.ok(got, name)
    const [routed] = calls()
    writeFileSync(LOG, '')
    await lane({ name, label: 'legacy', prompt: `prompt for ${name}`, model: ARGS.tiers[r.tier], schema: ARGS.schemas[name],
      budgetUsd: ARGS.budgetsUsd[r.tier], cwd: WT, agentType, disallowedTools: ARGS.disallowedTools,
      maxTurns: LIMITS.maxTurns, timeoutMs: LIMITS.wallClockMs })
    const [legacy] = calls()
    assert.deepEqual(routed, legacy, name)
    assert.equal(JSON.stringify(routed), JSON.stringify(legacy), name)
  }
})

test('every lane call carries the turn and wall-clock limits of config/prices.json, and claude gets --max-turns', async () => {
  const seen = []
  await context(ARGS, { lane: async req => { seen.push(req); return { result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model: req.model } } }).lane('premise', 'p', null)
  assert.equal(seen[0].maxTurns, LIMITS.maxTurns)
  assert.equal(seen[0].timeoutMs, LIMITS.wallClockMs)
  writeFileSync(LOG, '')
  await context(ARGS).lane('premise', 'p', null)
  const [argv] = calls()
  assert.equal(argv[argv.indexOf('--max-turns') + 1], String(LIMITS.maxTurns))
})

test('the lane journal line carries a schema-valid route record', async () => {
  const root = tmpRoot('routing-wiring-journal')
  const args = { ...ARGS, stateRoot: root }
  await context(args).lane('premise', 'p', null)
  const [l] = readJournal(journalPath(root, args.ticket)).filter(x => x.lane === 'premise')
  assert.equal(l.route.lane, 'premise')
  assert.equal(l.route.model, ARGS.tiers.T2)
  assert.equal(l.route.runtime, 'claude')
  assert.equal(l.route.attempt, 1)
  assert.deepEqual(check('route-decision', l.route), [])
})

test('a dead T2 lane is retried once on the same model and then gives up, without climbing', async () => {
  const models = []
  const c = context(ARGS, { lane: async ({ model }) => { models.push(model); return { result: null, usage: {}, costUsd: 0, durationMs: 0, model } } })
  assert.equal(await c.lane('premise', 'p', null), null)
  assert.deepEqual(models, [ARGS.tiers.T2, ARGS.tiers.T2])
})

test('a schema failure is retried on the same model with the error appended, then climbs one candidate', async () => {
  const seen = []
  const c = context(ARGS, { lane: async ({ model, prompt, runtime }) => {
    seen.push({ model, prompt, runtime })
    if (seen.length < 3) throw Object.assign(new Error('no structured_output'), { exitClass: 'schema', usage: {}, costUsd: 0 })
    return { result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model }
  } })
  const r = await c.lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.deepEqual(seen.map(s => s.model), [ARGS.tiers.T2, ARGS.tiers.T2, ARGS.tiers.T3])
  assert.ok(seen[1].prompt.includes('no structured_output'))
  assert.ok(seen.every(s => s.runtime === 'claude'))
  const routes = readJournal(journalPath(ARGS.stateRoot, ARGS.ticket)).filter(l => l.lane === 'premise').slice(-3).map(l => l.route)
  assert.deepEqual(routes.map(x => x.attempt), [1, 2, 3])
  assert.equal(routes[2].escalatedFrom, ARGS.tiers.T2)
})

test('a lane whose runtime is down parks the run before any call', async () => {
  const args = structuredClone(ARGS)
  args.router.state.runtimes.claude.available = false
  let called = 0
  const c = context(args, { lane: async () => { called++ } })
  await assert.rejects(c.lane('premise', 'p', null), e => e instanceof Stop && e.status === 'parked' && /no-eligible-model/.test(e.reason))
  assert.equal(called, 0)
})

test('args without a router are refused', () => {
  const { router, ...rest } = ARGS
  assert.throws(() => createContext(rest, { lane, exec }), /args\.router is required/)
})

const failingWith = (message, exitClass, okAfter = Infinity) => {
  const seen = []
  const run = async ({ model, prompt }) => {
    seen.push({ model, prompt })
    if (seen.length <= okAfter) throw Object.assign(new Error(message), { exitClass, usage: {}, costUsd: 0 })
    return { result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model }
  }
  return { seen, run }
}

test('a rate-limited lane moves sideways to the next candidate at once, without a schema retry', async () => {
  process.env.FLOW_FAKE_SLEEP = '1'
  const f = failingWith('API Error: 429 rate_limit_error', 'rate_limit', 1)
  const r = await context(ARGS, { lane: f.run }).lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.deepEqual(f.seen.map(s => s.model), [ARGS.tiers.T2, ARGS.tiers.T3])
  assert.ok(!f.seen[1].prompt.includes('REJECTED'))
})

test('a transport failure moves sideways to the next candidate at once, without a schema retry', async () => {
  const f = failingWith('connect ECONNREFUSED 127.0.0.1:8000', 'runtime_error', 1)
  const r = await context(ARGS, { lane: f.run }).lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.deepEqual(f.seen.map(s => s.model), [ARGS.tiers.T2, ARGS.tiers.T3])
  assert.ok(!f.seen[1].prompt.includes('REJECTED'))
})

test('a rate limit on every candidate backs off on the last one up to the cap, then gives up', async () => {
  process.env.FLOW_FAKE_SLEEP = '1'
  const f = failingWith('API Error: 429 rate_limit_error', 'rate_limit')
  const r = await context(ARGS, { lane: f.run }).lane('premise', 'p', null)
  assert.equal(r, null)
  assert.deepEqual(f.seen.map(s => s.model), [ARGS.tiers.T2, ARGS.tiers.T3, ...Array(ARGS.caps.backoffAttempts).fill(ARGS.tiers.T3)])
})
