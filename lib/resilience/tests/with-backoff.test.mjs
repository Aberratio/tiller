import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withBackoff } from '../with-backoff.mjs'

const rateLimited = { status: 'blocked', kind: 'rate-limit' }
const ok = { status: 'ok' }

function fakeClock() {
  const sleeps = []
  return { sleep: async ms => { sleeps.push(ms) }, sleeps }
}

test('retries a rate-limited call until it succeeds, with increasing sleeps', async () => {
  const { sleep, sleeps } = fakeClock()
  let calls = 0
  const call = async () => {
    calls++
    return { result: calls <= 3 ? rateLimited : ok, exitCode: calls <= 3 ? 3 : 0 }
  }
  const outcome = await withBackoff(call, { sleep, jitter: ms => ms })

  assert.equal(calls, 4)
  assert.equal(outcome.attempts, 4)
  assert.deepEqual(outcome.result, ok)
  assert.equal(sleeps.length, 3)
  assert.ok(sleeps[0] < sleeps[1] && sleeps[1] < sleeps[2], `sleeps did not increase: ${sleeps}`)
})

test('gives up at the attempt cap and returns the last blocked result without an extra sleep', async () => {
  const { sleep, sleeps } = fakeClock()
  let calls = 0
  const call = async () => { calls++; return { result: rateLimited, exitCode: 3 } }
  const outcome = await withBackoff(call, { attempts: 5, sleep, jitter: ms => ms })

  assert.equal(calls, 5)
  assert.equal(outcome.attempts, 5)
  assert.equal(outcome.result.kind, 'rate-limit')
  assert.equal(sleeps.length, 4, 'no sleep after the final, exhausted attempt')
})

test('a non-rate-limit result is returned immediately, no retry', async () => {
  const { sleep, sleeps } = fakeClock()
  let calls = 0
  const call = async () => { calls++; return { result: { status: 'blocked', kind: 'harness-blocked' }, exitCode: 3 } }
  const outcome = await withBackoff(call, { sleep, jitter: ms => ms })

  assert.equal(calls, 1)
  assert.equal(sleeps.length, 0)
})

test('delay is capped at maxMs and never grows past it', async () => {
  const { sleep, sleeps } = fakeClock()
  let calls = 0
  const call = async () => { calls++; return { result: calls <= 6 ? rateLimited : ok, exitCode: calls <= 6 ? 3 : 0 } }
  await withBackoff(call, { attempts: 7, firstMs: 1000, maxMs: 4000, sleep, jitter: ms => ms })

  assert.deepEqual(sleeps, [1000, 2000, 4000, 4000, 4000, 4000])
})
