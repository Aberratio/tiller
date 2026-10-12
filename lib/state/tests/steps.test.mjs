import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSteps } from '../steps.mjs'

const newRoot = () => mkdtempSync(join(tmpdir(), 'flow-steps-'))
const logPath = root => join(root, 'tickets', 'ABC-1', 'steps.jsonl')
const lines = root => existsSync(logPath(root)) ? readFileSync(logPath(root), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
const open = (root, runId = 'run-1') => openSteps({ root, ticket: 'ABC-1', runId })
const tick = ms => new Promise(r => setTimeout(r, ms))

function counted(value) {
  const f = async () => { f.calls++; return typeof value === 'function' ? value() : value }
  f.calls = 0
  return f
}

test('a completed step replays its recorded result on resume without calling fn', async () => {
  const root = newRoot()
  const first = open(root)
  assert.deepEqual(await first.step('plan', { argv: ['a'] }, async () => ({ steps: 3 })), { steps: 3 })
  assert.equal(first.stats.live, 1)

  const again = open(root)
  const fn = counted({ steps: 99 })
  assert.deepEqual(await again.step('plan', { argv: ['a'] }, fn), { steps: 3 })
  assert.equal(fn.calls, 0)
  assert.equal(again.stats.replayed, 1)
  assert.equal(lines(root).length, 1)
})

test('the input hash ignores key order but not values', async () => {
  const root = newRoot()
  await open(root).step('x', { a: 1, b: { c: 2, d: 3 } }, async () => 'r')
  const fn = counted('live')
  assert.equal(await open(root).step('x', { b: { d: 3, c: 2 }, a: 1 }, fn), 'r')
  assert.equal(fn.calls, 0)
})

test('a different input hash invalidates that record and every later line, then runs live', async () => {
  const root = newRoot()
  const first = open(root)
  await first.step('one', 1, async () => 'r1')
  await first.step('two', 2, async () => 'r2')
  await first.step('three', 3, async () => 'r3')

  const again = open(root)
  const one = counted('x1'); const two = counted('x2'); const three = counted('x3')
  assert.equal(await again.step('one', 1, one), 'r1')
  assert.equal(await again.step('two', 'changed', two), 'x2')
  assert.equal(await again.step('three', 3, three), 'x3')
  assert.deepEqual([one.calls, two.calls, three.calls], [0, 1, 1])
  assert.equal(again.stats.invalidated, 1)
  const log = lines(root)
  assert.deepEqual(log[3], { runId: 'run-1', invalidateFrom: 1 })

  const third = open(root)
  const fns = [counted('y1'), counted('y2'), counted('y3')]
  assert.deepEqual([await third.step('one', 1, fns[0]), await third.step('two', 'changed', fns[1]), await third.step('three', 3, fns[2])], ['r1', 'x2', 'x3'])
  assert.deepEqual(fns.map(f => f.calls), [0, 0, 0])
})

test('fn throwing writes nothing', async () => {
  const root = newRoot()
  const s = open(root)
  await assert.rejects(s.step('boom', {}, async () => { throw new Error('usage limit') }), /usage limit/)
  assert.deepEqual(lines(root), [])
  const fn = counted('ok')
  assert.equal(await open(root).step('boom', {}, fn), 'ok')
  assert.equal(fn.calls, 1)
})

test('fce21ea: a retried counter increment is not counted twice on resume', async () => {
  const root = newRoot()
  let fixRounds = 0
  const increment = async (s, failFirst) => {
    let attempts = 0
    for (;;) {
      try {
        return await s.step('counter-inc', { argv: ['counter', 'ABC-1', 'fixRounds', '--inc'] }, async () => {
          if (failFirst && attempts++ === 0) throw new Error('transient')
          return ++fixRounds
        })
      } catch (e) { if (e.message !== 'transient') throw e }
    }
  }
  const first = open(root)
  assert.equal(await increment(first, true), 1)
  const resumed = open(root)
  assert.equal(await increment(resumed, false), 1)
  assert.equal(fixRounds, 1)
  assert.equal(resumed.stats.replayed, 1)
})

test('the record is on disk before step() resolves', async () => {
  const root = newRoot()
  const s = open(root)
  const seen = await s.step('pr', { argv: ['open'] }, async () => ({ url: 'u' })).then(() => lines(root))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].step, 'pr#1')
  assert.deepEqual(seen[0].result, { url: 'u' })
  assert.equal(seen[0].runId, 'run-1')
  assert.match(seen[0].inputHash, /^[0-9a-f]{64}$/)
  assert.ok(seen[0].at)
})

test('repeated calls of one name in one scope get consecutive numbers under the scope path', async () => {
  const root = newRoot()
  const s = open(root)
  await s.withScope('review', async () => {
    await s.step('fix', 1, async () => 'a')
    await s.step('fix', 2, async () => 'b')
    await s.withScope('axis:spec', () => s.step('fix', 3, async () => 'c'))
  })
  await s.withScope('review', () => s.step('fix', 4, async () => 'd'))
  assert.deepEqual(lines(root).map(l => l.step), ['review/fix#1', 'review/fix#2', 'review/axis:spec/fix#1', 'review/fix#3'])
})

test('fan-out branches keep separate counters and a kill mid fan-out replays finished branches only', async () => {
  const root = newRoot()
  const axes = ['standards', 'spec', 'security']
  const branch = (s, axis, fns, killAt) => s.withScope(`axis:${axis}`, async () => {
    const out = []
    for (let i = 0; i < 3; i++) {
      await tick((axes.indexOf(axis) * 7 + i * 3) % 5)
      if (killAt === i) throw new Error('killed')
      out.push(await s.step('lane', { axis, i }, fns[i]))
    }
    return out
  })
  const fnsFor = tag => Object.fromEntries(axes.map(a => [a, [0, 1, 2].map(i => counted(`${tag}:${a}:${i}`))]))

  const first = open(root)
  const run1 = fnsFor('run1')
  const settled = await first.withScope('review', () => Promise.allSettled(axes.map(a => branch(first, a, run1[a], a === 'security' ? 2 : undefined))))
  assert.deepEqual(settled.map(r => r.status), ['fulfilled', 'fulfilled', 'rejected'])
  const names = lines(root).map(l => l.step).sort()
  assert.deepEqual(names, [
    'review/axis:security/lane#1', 'review/axis:security/lane#2',
    'review/axis:spec/lane#1', 'review/axis:spec/lane#2', 'review/axis:spec/lane#3',
    'review/axis:standards/lane#1', 'review/axis:standards/lane#2', 'review/axis:standards/lane#3',
  ])

  const resumed = open(root)
  const run2 = fnsFor('run2')
  const results = await resumed.withScope('review', () => Promise.all(axes.map(a => branch(resumed, a, run2[a]))))
  assert.deepEqual(results[0], ['run1:standards:0', 'run1:standards:1', 'run1:standards:2'])
  assert.deepEqual(results[1], ['run1:spec:0', 'run1:spec:1', 'run1:spec:2'])
  assert.deepEqual(results[2], ['run1:security:0', 'run1:security:1', 'run2:security:2'])
  assert.deepEqual(axes.flatMap(a => run2[a].map(f => f.calls)), [0, 0, 0, 0, 0, 0, 0, 0, 1])
  assert.equal(resumed.stats.replayed, 8)
  assert.equal(resumed.stats.live, 1)
})

test('a volatile step always runs live but is still logged', async () => {
  const root = newRoot()
  const first = open(root)
  assert.equal(await first.step('resume', { argv: ['resume'] }, async () => 'running', { volatile: true }), 'running')
  const again = open(root)
  const fn = counted('paused')
  assert.equal(await again.step('resume', { argv: ['resume'] }, fn, { volatile: true }), 'paused')
  assert.equal(fn.calls, 1)
  assert.equal(again.stats.replayed, 0)
  assert.deepEqual(lines(root).map(l => [l.step, l.result]), [['resume#1', 'running'], ['resume#1', 'paused']])
})

test('lines of another runId are ignored', async () => {
  const root = newRoot()
  await open(root, 'run-old').step('plan', 1, async () => 'old')
  const s = open(root, 'run-new')
  const fn = counted('new')
  assert.equal(await s.step('plan', 1, fn), 'new')
  assert.equal(fn.calls, 1)
  const old = counted('x')
  assert.equal(await open(root, 'run-old').step('plan', 1, old), 'old')
  assert.equal(old.calls, 0)
})

test('an invalidation in one runId does not kill the records of another', async () => {
  const root = newRoot()
  await open(root, 'run-a').step('plan', 1, async () => 'a')
  await open(root, 'run-b').step('plan', 1, async () => 'b')
  await open(root, 'run-b').step('plan', 2, async () => 'b2')
  const fn = counted('x')
  assert.equal(await open(root, 'run-a').step('plan', 1, fn), 'a')
  assert.equal(fn.calls, 0)
})

test('a torn last line from a kill mid-write is skipped and does not swallow the next record', async () => {
  const root = newRoot()
  await open(root).step('one', 1, async () => 'r1')
  const { appendFileSync } = await import('node:fs')
  appendFileSync(logPath(root), '{"runId":"run-1","step":"two#1","inpu')
  const s = open(root)
  assert.equal(await s.step('two', 2, async () => 'r2'), 'r2')
  const fn = counted('x')
  assert.equal(await open(root).step('two', 2, fn), 'r2')
  assert.equal(fn.calls, 0)
})

test('an unsafe ticket or a missing runId is refused', () => {
  assert.throws(() => openSteps({ root: newRoot(), ticket: '../x', runId: 'r' }), /ticket/)
  assert.throws(() => openSteps({ root: newRoot(), ticket: 'ABC-1' }), /runId/)
})
