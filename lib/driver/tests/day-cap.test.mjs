// The day cap (budgetsUsd.day): a chunk starts only while the queue's recorded spend plus the run cap
// still left to each of its tickets fits under it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDayArgs, decisionsOf, makeSim, runDayDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { appendJournal, journalPath, laneLine } from '../journal.mjs'

const spend = (root, ticket, costUsd) =>
  appendJournal(journalPath(root, ticket), laneLine({ runId: 'r', phase: 'implement', label: 'implement:implement:T3', lane: 'implement', model: 'm', outcome: 'ok', costUsd }))

function day(tag, { run, day: dayCap, perChild = 0, queue = [['ABC-1', 'ABC-2', 'ABC-3']], seed = {} }) {
  const root = tmpRoot(tag)
  const base = buildDayArgs(root, { queue })
  const args = { ...base, budgetsUsd: { ...base.budgetsUsd, run, day: dayCap } }
  for (const [t, usd] of Object.entries(seed)) spend(root, t, usd)
  const sim = makeSim(root, args)
  const launched = []
  const launch = async entry => {
    launched.push(entry.ticket)
    if (perChild) spend(root, entry.ticket, perChild)
    return { status: 'merged', reason: null, prUrl: null }
  }
  return { root, sim, launched, run: () => runDayDriver(sim, { launch }) }
}

test('day-args carry the day and run caps from config/routing.json', () => {
  const args = buildDayArgs(tmpRoot('day-cap-args'), { queue: [['ABC-1']] })
  assert.equal(typeof args.budgetsUsd.day, 'number')
  assert.equal(typeof args.budgetsUsd.run, 'number')
})

test('a chunk that could pass the day cap does not start; the day parks as budget-exhausted with an open decision', async () => {
  const d = day('day-cap-second-chunk', { run: 10, day: 25, perChild: 8 })
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2'])
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.match(r.reason, /^budget-exhausted/)
  const dec = decisionsOf(d.root).find(x => x.kind === 'budget-exhausted')
  assert.ok(dec, JSON.stringify(decisionsOf(d.root)))
  assert.match(dec.blocks, /ABC-3/)
})

test('spend recorded before the day counts, and a ticket only reserves the run cap it has left', async () => {
  const stopped = day('day-cap-seeded', { run: 10, day: 25, seed: { 'ABC-3': 20 } })
  assert.equal((await stopped.run()).status, 'parked')
  assert.deepEqual(stopped.launched, [])
  const fits = day('day-cap-partly-spent', { run: 10, day: 30, seed: { 'ABC-1': 9, 'ABC-2': 9 } })
  const r = await fits.run()
  assert.deepEqual(fits.launched, ['ABC-1', 'ABC-2', 'ABC-3'], JSON.stringify(r))
})

test('a day under its cap runs the whole queue', async () => {
  const d = day('day-cap-room', { run: 10, day: 1000, perChild: 8 })
  const r = await d.run()
  assert.deepEqual(d.launched, ['ABC-1', 'ABC-2', 'ABC-3'])
  assert.notEqual(r.status, 'parked', JSON.stringify(r))
})
