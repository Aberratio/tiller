import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { budgetGuard, priceFor } from '../adapters/budget.mjs'
import { exec } from '../proc.mjs'

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PRICES = { models: { 'codex/gpt-x': { in: 2, out: 8, cacheRead: 0.5, cacheCreate: 0 }, 'openai-compat/*': { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 } }, limits: { maxTokens: 1000, maxTurns: 3, wallClockMs: 60000 } }
const use = (i, o = 0) => ({ in: i, out: o, cacheRead: 0, cacheCreate: 0 })
let TMP
before(() => { TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-budget-'))) })
after(() => rmSync(TMP, { recursive: true, force: true }))

test('config/prices.json is in USD per million tokens, and the self-hosted endpoint is priced at zero', () => {
  const p = JSON.parse(readFileSync(join(CORE, 'config', 'prices.json'), 'utf8'))
  assert.deepEqual(priceFor(p, 'openai-compat', 'qwen3-coder'), { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 })
  for (const k of ['maxTokens', 'maxTurns', 'wallClockMs']) assert.ok(p.limits[k] > 0, k)
})

test('an exact runtime/model price wins over the runtime wildcard; no entry is null, never a guessed price', () => {
  const p = { models: { 'openai-compat/*': { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 }, 'openai-compat/hosted-big': { in: 1, out: 1, cacheRead: 0, cacheCreate: 0 } } }
  assert.equal(priceFor(p, 'openai-compat', 'hosted-big').in, 1)
  assert.equal(priceFor(p, 'openai-compat', 'local').in, 0)
  assert.equal(priceFor(p, 'codex', 'gpt-unknown'), null)
})

test('a paid model is capped in USD computed from tokens: the add that crosses budgetUsd is a breach', () => {
  const g = budgetGuard({ runtime: 'codex', model: 'gpt-x', budgetUsd: 0.01, prices: { ...PRICES, limits: {} } })
  assert.equal(g.add(use(2000, 500)), null)
  assert.equal(g.usage().costUsd, 0.008)
  assert.equal(g.usage().costSource, 'computed')
  assert.match(g.add(use(2000)), /budget/)
  assert.equal(g.breach().exitClass, 'budget')
})

test('a self-hosted model at price zero is capped by tokens, by turns and by wall clock instead', () => {
  const t = budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd: 5, prices: PRICES })
  assert.equal(t.add(use(600)), null)
  assert.match(t.add(use(600)), /tokens/)
  assert.equal(t.breach().exitClass, 'budget')

  const turns = budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd: 5, prices: PRICES })
  for (let i = 0; i < 3; i++) assert.equal(turns.turn(), null)
  assert.match(turns.turn(), /turns/)
  assert.equal(turns.breach().exitClass, 'turns')

  let now = 0
  const clock = budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd: 5, prices: PRICES, now: () => now })
  now = 60001
  assert.match(clock.check(), /wall clock/)
  assert.equal(clock.breach().exitClass, 'timeout')
})

test('the lane\'s own maxTurns and maxTokens tighten the defaults', () => {
  const g = budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd: 5, prices: PRICES, maxTurns: 1, maxTokens: 10 })
  assert.equal(g.turn(), null)
  assert.match(g.turn(), /turns/)
})

test('a model with no price cannot honour a USD budget: the guard refuses before any call', () => {
  assert.throws(() => budgetGuard({ runtime: 'codex', model: 'gpt-unknown', budgetUsd: 1, prices: PRICES }), /no price for codex\/gpt-unknown/)
})

test('exec: onLine returning a reason kills the child and its process group, and the reason comes back', async () => {
  const script = join(TMP, 'spender.js')
  writeFileSync(script, `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('node:fs').writeFileSync(${JSON.stringify(join(TMP, 'gc.pid'))}, String(grandchild.pid))
let n = 0
setInterval(() => console.log(JSON.stringify({ usage: { in: 400, out: 0 }, n: n++ })), 5)
`)
  const g = budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd: 5, prices: PRICES })
  const started = Date.now()
  const r = await exec([process.execPath, script], { onLine: line => g.add({ ...use(0), ...JSON.parse(line).usage }), timeoutMs: 10000 })
  assert.ok(Date.now() - started < 5000)
  assert.match(r.stopped, /tokens/)
  const gc = Number(readFileSync(join(TMP, 'gc.pid'), 'utf8'))
  await new Promise(res => setTimeout(res, 200))
  assert.throws(() => process.kill(gc, 0), /ESRCH/, 'the grandchild outlived the breach')
})

test('a budget that is not a finite non-negative number is refused, never read as no cap', () => {
  for (const budgetUsd of [undefined, null, 'abc', '1', NaN, Infinity, -1]) {
    assert.throws(() => budgetGuard({ runtime: 'openai-compat', model: 'local', budgetUsd, prices: PRICES }), /budgetUsd/, String(budgetUsd))
  }
})
