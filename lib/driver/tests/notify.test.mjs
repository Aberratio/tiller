// TILLER_NOTIFY_CMD: one JSON event on stdin per park, death, cap hit, stop hour, battery pause and day end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArgs, buildDayArgs, makeSim, runDayDriver, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { NOTIFY_KINDS, notify, notifyEvent, notifySync } from '../notify.mjs'

const sink = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'notify-')), 'events.jsonl')
  return { file, cmd: `cat >> '${file}'`, events: () => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] }
}

test('notify hands the command one JSON event on stdin', async () => {
  const s = sink()
  const at = new Date(2026, 8, 28, 10, 0)
  const r = await notify(notifyEvent({ kind: 'park', runId: 'r1', ticket: 'ABC-1', status: 'parked', reason: 'why', at }), { cmd: s.cmd })
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(s.events(), [{ kind: 'park', runId: 'r1', ticket: 'ABC-1', status: 'parked', reason: 'why', at: at.toISOString() }])
  notifySync(notifyEvent({ kind: 'died', dayId: 'day-x', status: 'died', at }), { cmd: s.cmd })
  assert.deepEqual(s.events()[1], { kind: 'died', dayId: 'day-x', ticket: null, status: 'died', reason: null, at: at.toISOString() })
  assert.deepEqual(NOTIFY_KINDS, ['park', 'died', 'cap-hit', 'day-end', 'stop-hour', 'battery-pause'])
})

test('without a command nothing runs', async () => {
  assert.deepEqual(await notify(notifyEvent({ kind: 'park' }), { cmd: '' }), { ok: true, skipped: true })
  assert.deepEqual(notifySync(notifyEvent({ kind: 'park' }), { cmd: undefined }), { ok: true, skipped: true })
})

test('a failing or hanging command is logged and never throws', async () => {
  const logs = []
  const log = m => logs.push(m)
  assert.equal((await notify(notifyEvent({ kind: 'park' }), { cmd: 'echo nope >&2; exit 3', log })).ok, false)
  assert.match(logs[0], /notify park: command exited 3: nope/)
  const t0 = Date.now()
  const r = await notify(notifyEvent({ kind: 'died' }), { cmd: 'sleep 30', log, timeoutMs: 200 })
  assert.equal(r.ok, false)
  assert.ok(Date.now() - t0 < 5000)
  assert.match(logs[1], /timed out after 200ms/)
  assert.equal(notifySync(notifyEvent({ kind: 'died' }), { cmd: 'exit 2', log }).ok, false)
  assert.match(logs[2], /exited 2/)
})

function day(tag, { stopHour = null, launch, now = () => new Date(2026, 8, 28, 10, 0), runtime = {}, budgets } = {}) {
  const root = tmpRoot(tag)
  const base = buildDayArgs(root, { queue: [['ABC-1', 'ABC-2']] })
  const args = { ...base, facts: { ...base.facts, runPolicy: { ...base.facts.runPolicy, stopHour } }, ...(budgets ? { budgetsUsd: { ...base.budgetsUsd, ...budgets } } : {}) }
  const s = sink()
  const sim = makeSim(root, args)
  return { s, run: () => runDayDriver(sim, { launch: launch || (async () => ({ status: 'merged' })), now, notifyCmd: s.cmd, ...runtime }) }
}

test('a day past its stop hour tells stop-hour, then day-end', async () => {
  const d = day('notify-stop-hour', { stopHour: '9' })
  const r = await d.run()
  assert.equal(r.status, 'stop-hour')
  const ev = d.s.events()
  assert.deepEqual(ev.map(e => e.kind), ['stop-hour', 'day-end'])
  assert.equal(ev[0].dayId, 'day-2026-09-28')
  assert.equal(ev[1].status, 'stop-hour')
  assert.match(ev[0].reason, /stop hour 9:00/)
})

test('a battery pause and a finished day are told', async () => {
  const seq = [{ percent: 5, onAc: false }, { percent: 5, onAc: true }]
  const d = day('notify-battery', { runtime: { battery: () => (seq.length > 1 ? seq.shift() : seq[0]), batteryMinPercent: 15, sleep: async () => {} } })
  const r = await d.run()
  assert.equal(r.status, 'done', JSON.stringify(r))
  const ev = d.s.events()
  assert.deepEqual(ev.map(e => e.kind), ['battery-pause', 'day-end'])
  assert.match(ev[0].reason, /battery 5% below 15%/)
  assert.equal(ev[1].status, 'done')
})

test('a child that died silently is told by the day; one that told it itself is not', async () => {
  const d = day('notify-child-died', { launch: async e => (e.ticket === 'ABC-1' ? null : { status: 'died', reason: 'crash', reported: true }) })
  await d.run()
  const ev = d.s.events()
  assert.deepEqual(ev.map(e => [e.kind, e.ticket]), [['died', 'ABC-1'], ['day-end', null]])
  assert.equal(ev[0].reason, 'child returned nothing')
})

test('the day cap tells cap-hit', async () => {
  const d = day('notify-day-cap', { budgets: { run: 10, day: 5 } })
  const r = await d.run()
  assert.equal(r.status, 'parked')
  assert.deepEqual(d.s.events().map(e => e.kind), ['cap-hit', 'day-end'])
  assert.match(d.s.events()[0].reason, /^budget-exhausted/)
})

test('a ticket run that hits its run cap tells cap-hit with its run id and ticket', async () => {
  const root = tmpRoot('notify-run-cap')
  const base = buildArgs(root)
  const args = { ...base, budgetsUsd: { ...base.budgetsUsd, run: base.budgetsUsd.T3 - 0.01 } }
  const s = sink()
  const sim = makeSim(root, args)
  sim.runtime.notifyCmd = s.cmd
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'parked')
  const ev = s.events()
  assert.equal(ev.length, 1, JSON.stringify(ev))
  assert.equal(ev[0].kind, 'cap-hit')
  assert.equal(ev[0].ticket, 'ABC-1')
  assert.equal(typeof ev[0].runId, 'string')
  assert.equal(ev[0].dayId, undefined)
})

test('a notify command that fails does not change the day', async () => {
  const logs = []
  const d = day('notify-fails', { runtime: { notifyCmd: 'exit 9', log: m => logs.push(m) } })
  const r = await d.run()
  assert.equal(r.status, 'done', JSON.stringify(r))
  assert.ok(logs.some(m => /notify day-end: command exited 9/.test(m)), logs.join('\n'))
})
