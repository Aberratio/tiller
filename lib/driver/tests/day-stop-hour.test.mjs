// runPolicy.stopHour in the day driver: from that local hour no new chunk starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDayArgs, makeSim, runDayDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { check } from '../../contract/validate.mjs'
import { exitOf, stopHourOf } from '../day.mjs'

const at = hour => new Date(2026, 8, 28, hour, 30)

function day(tag, { stopHour, clock, queue = [['ABC-1', 'ABC-2', 'ABC-3']] }) {
  const root = tmpRoot(tag)
  const base = buildDayArgs(root, { queue })
  const args = { ...base, facts: { ...base.facts, runPolicy: { ...base.facts.runPolicy, stopHour } } }
  const sim = makeSim(root, args)
  const launched = []
  const launch = async entry => {
    launched.push(entry.ticket)
    clock.onLaunch?.()
    return { status: 'merged', reason: null, prUrl: null }
  }
  return { root, launched, run: () => runDayDriver(sim, { launch, now: () => clock.now }) }
}

test('stopHourOf reads "HH" and "HH:MM", and nothing else', () => {
  assert.equal(stopHourOf({ stopHour: '19:00' }), 19)
  assert.equal(stopHourOf({ stopHour: '7' }), 7)
  assert.equal(stopHourOf({ stopHour: 0 }), 0)
  assert.equal(stopHourOf({ stopHour: null }), null)
  assert.equal(stopHourOf({}), null)
  assert.equal(stopHourOf({ stopHour: '25:00' }), null)
  assert.equal(stopHourOf({ stopHour: 'evening' }), null)
})

test('a day launched at or after the stop hour starts nothing and ends stop-hour', async () => {
  const d = day('stop-hour-before-start', { stopHour: '19:00', clock: { now: at(19) } })
  const r = await d.run()
  assert.deepEqual(d.launched, [])
  assert.equal(r.status, 'stop-hour', JSON.stringify(r))
  assert.match(r.reason, /stop hour 19:00 reached; not started: ABC-1, ABC-2, ABC-3/)
  assert.match(readFileSync(join(d.root, 'state.md'), 'utf8'), /stopped: stop hour 19:00/)
  assert.doesNotMatch(readFileSync(join(d.root, 'state.md'), 'utf8'), /supervisor: done/)
})

test('the stop hour reached during a chunk stops the next chunk, not the running one', async () => {
  const clock = { now: at(18) }
  clock.onLaunch = () => { clock.now = at(19) }
  const d = day('stop-hour-mid-day', { stopHour: '19', clock })
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2'])
  assert.equal(r.status, 'stop-hour')
  assert.match(r.reason, /not started: ABC-3/)
})

test('before the stop hour, and with none set, the whole queue runs', async () => {
  for (const stopHour of ['23:00', null]) {
    const d = day(`stop-hour-room-${stopHour}`, { stopHour, clock: { now: at(10) } })
    const r = await d.run()
    assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'], JSON.stringify(r))
    assert.notEqual(r.status, 'stop-hour')
  }
})

test('the CLI line for a stop hour is blocked/stop-hour, exit 3, and passes the contract', () => {
  const [code, head] = exitOf({ status: 'stop-hour' }, null)
  assert.equal(code, 3)
  assert.deepEqual(check('script-result', { ...head, dayStatus: 'stop-hour', reason: 'stop hour 19:00 reached', results: [], record: '/r/day-result.json', journal: '/r/j.jsonl' }, code), [])
  assert.deepEqual(exitOf({ status: 'done' }, null), [0, { status: 'ok' }])
  assert.equal(exitOf({ status: 'done' }, new Error('x'))[0], 1)
})
