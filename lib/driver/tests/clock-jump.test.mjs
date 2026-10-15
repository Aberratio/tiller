// A wall clock that jumps (sleep, a changed time) is journalled and the stop hour and day cap are
// evaluated again on the new time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDayArgs, makeSim, runDayDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { appendJournal, journalPath, laneLine, readJournal } from '../journal.mjs'
import { BATTERY_TICK_MS, CLOCK_JUMP_MS } from '../day.mjs'

const MIN = 60 * 1000
const events = root => readJournal(journalPath(root, 'day-2026-09-28')).filter(l => l.kind === 'event')

// wall and mono advance together unless a test moves only the wall clock.
function day(tag, { stopHour = null, budgets, onLaunch, runtime = {} } = {}) {
  const root = tmpRoot(tag)
  const base = buildDayArgs(root, { queue: [['ABC-1'], ['ABC-2'], ['ABC-3']] })
  const args = { ...base, facts: { ...base.facts, runPolicy: { ...base.facts.runPolicy, stopHour, maxParallel: 1 } },
    ...(budgets ? { budgetsUsd: { ...base.budgetsUsd, ...budgets } } : {}) }
  const clock = { wall: new Date(2026, 8, 28, 10, 0).getTime(), mono: 0 }
  const launched = []
  const launch = async entry => {
    launched.push(entry.ticket)
    clock.wall += MIN
    clock.mono += MIN
    onLaunch?.(entry, clock, root)
    return { status: 'merged', reason: null, prUrl: null }
  }
  const sim = makeSim(root, args)
  const run = () => runDayDriver(sim, { launch, now: () => new Date(clock.wall), monoMs: () => clock.mono, ...runtime })
  return { root, clock, launched, run }
}

test('steady clocks write no clock-jump event', async () => {
  const d = day('clock-steady')
  await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.deepEqual(events(d.root).filter(e => e.event === 'clock-jump'), [])
})

test('a jump under the threshold is ignored', async () => {
  const d = day('clock-small', { onLaunch: (e, clock) => { clock.wall += CLOCK_JUMP_MS - MIN } })
  await d.run()
  assert.deepEqual(events(d.root).filter(e => e.event === 'clock-jump'), [])
})

test('a sleep past the stop hour between chunks is journalled and stops the day before the next chunk', async () => {
  // The machine sleeps for three hours while ABC-1 runs: only the wall clock moves.
  const d = day('clock-sleep-stop', { stopHour: '12', onLaunch: (e, clock) => { if (e.ticket === 'ABC-1') clock.wall += 3 * 60 * MIN } })
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1'])
  assert.equal(r.status, 'stop-hour', JSON.stringify(r))
  const jumps = events(d.root).filter(e => e.event === 'clock-jump')
  assert.equal(jumps.length, 1, JSON.stringify(jumps))
  assert.equal(jumps[0].where, 'wave')
  assert.equal(jumps[0].jumpMs, 3 * 60 * MIN)
})

test('a clock set back is a jump too', async () => {
  const d = day('clock-back', { onLaunch: (e, clock) => { if (e.ticket === 'ABC-2') clock.wall -= 60 * MIN } })
  await d.run()
  const jumps = events(d.root).filter(e => e.event === 'clock-jump')
  assert.equal(jumps.length, 1)
  assert.equal(jumps[0].jumpMs, -60 * MIN)
})

test('a jump during a battery pause re-checks the day cap and parks the day when it no longer fits', async () => {
  let reads = 0
  const holder = {}
  const d = day('clock-battery-cap', {
    budgets: { run: 20, day: 45 },
    runtime: {
      battery: () => { reads += 1; return reads === 2 ? { percent: 5, onAc: false } : { percent: 80, onAc: true } },
      batteryMinPercent: 15,
      // While the day waits on the battery, spend lands from outside the day and the machine sleeps an hour.
      sleep: async ms => {
        assert.equal(ms, BATTERY_TICK_MS)
        appendJournal(journalPath(holder.root, 'ABC-1'), laneLine({ runId: 'r', phase: 'implement', label: 'implement:implement:T3', lane: 'implement', model: 'm', outcome: 'ok', costUsd: 30 }))
        holder.clock.wall += ms + 60 * MIN
        holder.clock.mono += ms
      },
    },
  })
  holder.root = d.root
  holder.clock = d.clock
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1'])
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.match(r.reason, /^budget-exhausted/)
  const ev = events(d.root).map(e => e.event)
  assert.deepEqual(ev, ['battery-pause', 'clock-jump'])
  // Parked inside the wait, before the battery was read again.
  assert.equal(reads, 2)
  assert.equal(events(d.root)[1].where, 'battery-pause')
})
