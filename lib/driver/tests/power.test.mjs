// Battery guard: the readers, and the day driver waiting on a low battery instead of starting a chunk.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDayArgs, makeSim, runDayDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { journalPath, readJournal } from '../journal.mjs'
import { check } from '../../contract/validate.mjs'
import { BATTERY_TICK_MS, exitOf, inhibitSelf } from '../day.mjs'
import { batteryLow, batteryMaxWaitMs, batteryMinPercent, parsePmset, readBattery, readSysfs } from '../power.mjs'

test('pmset output: percent and power source; a machine with no battery reads null', () => {
  assert.deepEqual(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t12%; discharging; 0:40 remaining present: true"), { percent: 12, onAc: false })
  assert.deepEqual(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t9%; charging; present: true"), { percent: 9, onAc: true })
  assert.equal(parsePmset("Now drawing from 'AC Power'\n"), null)
})

test('sysfs: the first Battery supply; Discharging means not on mains', () => {
  const files = { '/p/AC/type': 'Mains', '/p/BAT0/type': 'Battery\n', '/p/BAT0/capacity': '11\n', '/p/BAT0/status': 'Discharging\n' }
  const read = f => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }
  assert.deepEqual(readSysfs('/p', { read, list: () => ['AC', 'BAT0'] }), { percent: 11, onAc: false })
  files['/p/BAT0/status'] = 'Charging'
  assert.deepEqual(readSysfs('/p', { read, list: () => ['AC', 'BAT0'] }), { percent: 11, onAc: true })
  assert.equal(readSysfs('/p', { read, list: () => { throw new Error('ENOENT') } }), null)
})

test('readBattery picks the reader by platform and never throws on a failed tool', () => {
  const run = () => ({ status: 0, stdout: "Now drawing from 'Battery Power'\n\t50%; discharging" })
  assert.deepEqual(readBattery({ platform: 'darwin', run }), { percent: 50, onAc: false })
  assert.equal(readBattery({ platform: 'darwin', run: () => ({ status: 1, stdout: '' }) }), null)
  assert.deepEqual(readBattery({ platform: 'linux', sysfs: () => ({ percent: 3, onAc: true }) }), { percent: 3, onAc: true })
  assert.equal(readBattery({ platform: 'win32' }), null)
})

test('the threshold defaults to 15 and only a discharging battery below it is low', () => {
  assert.equal(batteryMinPercent({}), 15)
  assert.equal(batteryMinPercent({ TILLER_BATTERY_MIN_PERCENT: '30' }), 30)
  assert.equal(batteryMinPercent({ TILLER_BATTERY_MIN_PERCENT: 'x' }), 15)
  assert.equal(batteryLow({ percent: 14, onAc: false }, 15), true)
  assert.equal(batteryLow({ percent: 14, onAc: true }, 15), false)
  assert.equal(batteryLow({ percent: 15, onAc: false }, 15), false)
  assert.equal(batteryLow(null, 15), false)
})

test('the wait limit defaults to 240 minutes; only a positive number of minutes overrides it', () => {
  assert.equal(batteryMaxWaitMs({}), 240 * 60 * 1000)
  assert.equal(batteryMaxWaitMs({ TILLER_BATTERY_MAX_WAIT_MINUTES: '30' }), 30 * 60 * 1000)
  assert.equal(batteryMaxWaitMs({ TILLER_BATTERY_MAX_WAIT_MINUTES: '0' }), 240 * 60 * 1000)
  assert.equal(batteryMaxWaitMs({ TILLER_BATTERY_MAX_WAIT_MINUTES: 'x' }), 240 * 60 * 1000)
})

function day(tag, readings, extra = {}) {
  const root = tmpRoot(tag)
  const base = buildDayArgs(root, { queue: [['ABC-1', 'ABC-2', 'ABC-3']] })
  const args = { ...base, facts: { ...base.facts, runPolicy: { ...base.facts.runPolicy, stopHour: extra.stopHour ?? null } } }
  const sim = makeSim(root, args)
  const launched = []
  const slept = []
  const seq = [...readings]
  const launch = async entry => { launched.push(entry.ticket); return { status: 'merged', reason: null, prUrl: null } }
  const runtime = { launch, battery: () => (seq.length > 1 ? seq.shift() : seq[0]), batteryMinPercent: 15, batteryMaxWaitMs: 240 * 60 * 1000,
    sleep: async ms => { slept.push(ms); extra.onSleep?.() }, ...extra.runtime }
  return { root, launched, slept, run: () => runDayDriver(sim, runtime) }
}

test('a low battery holds the next chunk, re-checks every tick, and the day goes on once it charges', async () => {
  const low = { percent: 10, onAc: false }
  const d = day('battery-wait', [low, low, low, { percent: 10, onAc: true }])
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'], JSON.stringify(r))
  assert.equal(d.slept.filter(ms => ms === BATTERY_TICK_MS).length, 3)
  const events = readJournal(journalPath(d.root, 'day-2026-09-28')).filter(l => l.kind === 'event').map(l => l.event)
  assert.deepEqual(events, ['battery-pause', 'battery-resume'])
})

test('the stop hour ends a battery wait', async () => {
  const clock = { now: new Date(2026, 8, 28, 18, 50) }
  const d = day('battery-stop-hour', [{ percent: 5, onAc: false }], { stopHour: '19:00', onSleep: () => { clock.now = new Date(2026, 8, 28, 19, 5) }, runtime: { now: () => clock.now } })
  const r = await d.run()
  assert.deepEqual(d.launched, [])
  assert.equal(r.status, 'stop-hour', JSON.stringify(r))
})

test('a battery that never charges ends the day battery-wait after the wait limit, with a handoff', async () => {
  const d = day('battery-limit', [{ percent: 9, onAc: false }], { runtime: { batteryMaxWaitMs: 3 * BATTERY_TICK_MS } })
  const r = await d.run()
  assert.equal(r.status, 'battery-wait', JSON.stringify(r))
  assert.match(r.reason, /battery 9% still below 15% after 15 minutes/)
  assert.deepEqual(d.launched, [])
  assert.equal(d.slept.filter(ms => ms === BATTERY_TICK_MS).length, 3)
  const journal = readJournal(journalPath(d.root, 'day-2026-09-28')).filter(l => l.kind === 'event').map(l => l.event)
  assert.deepEqual(journal, ['battery-pause', 'battery-wait-limit'])
  assert.match(readFileSync(join(d.root, 'state.md'), 'utf8'), /Plug the machine in and relaunch/)
})

test('a battery that charges right at the limit lets the day go on', async () => {
  const low = { percent: 9, onAc: false }
  const d = day('battery-limit-charged', [low, low, low, { percent: 9, onAc: true }], { runtime: { batteryMaxWaitMs: 3 * BATTERY_TICK_MS } })
  const r = await d.run()
  assert.notEqual(r.status, 'battery-wait', JSON.stringify(r))
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'])
})

test('the CLI line for a battery wait is blocked/battery-wait, exit 3, and passes the contract', () => {
  const [code, head] = exitOf({ status: 'battery-wait' }, null)
  assert.equal(code, 3)
  assert.deepEqual(check('script-result', { ...head, dayStatus: 'battery-wait', reason: 'battery 9% still below 15% after 240 minutes', results: [], record: '/r/day-result.json', journal: '/r/j.jsonl' }, code), [])
})

test('an unreadable battery never pauses the day', async () => {
  const d = day('battery-none', [null])
  await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.deepEqual(d.slept.filter(ms => ms === BATTERY_TICK_MS), [])
})

test('the CLI keeps the machine awake for its own pid through inhibit.sh', () => {
  const calls = []
  inhibitSelf({ pid: 4242, run: (cmd, argv) => calls.push([cmd, ...argv]) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'bash')
  assert.match(calls[0][1], /lib\/supervisor\/inhibit\.sh$/)
  assert.deepEqual(calls[0].slice(2), ['--pid', '4242'])
  assert.doesNotThrow(() => inhibitSelf({ run: () => { throw new Error('no bash') } }))
})
