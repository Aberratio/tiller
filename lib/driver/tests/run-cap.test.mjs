// The run cap (budgetsUsd.run): a lane call that could push the ticket's recorded spend past it is never made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildArgs, decisionsOf, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { Stop, createContext } from '../core.mjs'
import { appendJournal, journalPath, laneLine } from '../journal.mjs'

const ROUTING_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('../../../config/routing.json', import.meta.url)), 'utf8'))

const setup = (tag, { spent = 0, run, hold = false } = {}) => {
  const root = tmpRoot(tag)
  const base = buildArgs(root)
  const args = { ...base, budgetsUsd: { ...base.budgetsUsd, ...(run === undefined ? {} : { run }) } }
  if (spent) appendJournal(journalPath(root, args.ticket), laneLine({ runId: 'earlier', phase: 'implement', label: 'implement:implement:T3', lane: 'implement', model: 'm', outcome: 'ok', costUsd: spent }))
  const calls = []
  let release = () => {}
  const gate = new Promise(r => { release = r })
  const c = createContext(args, { ...makeSim(root, args).runtime, lane: async req => {
    calls.push(req)
    if (hold && calls.length === 1) await gate
    return { result: { ok: true, awaiting: [], questions: [] }, usage: {}, costUsd: 0, durationMs: 0, model: req.model }
  } })
  c.cur = 'plan'
  const capOf = name => args.routing[name].budgetUsd ?? args.budgetsUsd[args.routing[name].tier]
  return { root, args, c, calls, capOf, release: () => release() }
}

test('config/routing.json sets run and day caps that fit at least one call of every tier', () => {
  const b = ROUTING_JSON.budgetsUsd
  assert.ok(b.run >= Math.max(b.T1, b.T2, b.T3), JSON.stringify(b))
  assert.ok(b.day >= b.run, JSON.stringify(b))
})

test('recorded spend plus the next call cap over the run cap parks the run before the call, with an open decision', async () => {
  const { root, c, calls, capOf } = setup('run-cap-over', { spent: 10, run: 10 + capOf0('premise') - 0.01 })
  await assert.rejects(c.lane('premise', 'p', null), e => e instanceof Stop && e.status === 'parked' && /^budget-exhausted/.test(e.reason))
  assert.equal(calls.length, 0)
  assert.ok(c.pendingStop && /^budget-exhausted/.test(c.pendingStop.reason))
  await c.flush()
  const d = decisionsOf(root).find(x => x.kind === 'budget-exhausted')
  assert.ok(d, JSON.stringify(decisionsOf(root)))
  assert.equal(d.status, 'open')
  assert.match(d.why, /run cap/)
  assert.ok(capOf('premise') > 0)
})

test('spend that leaves room for the call lets it run', async () => {
  const { c, calls } = setup('run-cap-under', { spent: 10, run: 10 + capOf0('premise') })
  const r = await c.lane('premise', 'p', null)
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
})

test('calls still in flight count against the run cap, so a fan-out cannot overshoot it', async () => {
  const { c, calls, release } = setup('run-cap-inflight', { run: capOf0('premise') * 1.5, hold: true })
  const first = c.lane('premise', 'p', 'a')
  await new Promise(r => setImmediate(r))
  const second = c.lane('premise', 'p', 'b')
  await assert.rejects(second, e => e instanceof Stop && /^budget-exhausted/.test(e.reason))
  release()
  await first
  assert.equal(calls.length, 1)
})

test('no run cap in args leaves lane calls unbounded by it', async () => {
  const root = tmpRoot('run-cap-none')
  const base = buildArgs(root)
  const { run, day, ...perCall } = base.budgetsUsd
  const args = { ...base, budgetsUsd: perCall }
  appendJournal(journalPath(root, args.ticket), laneLine({ runId: 'earlier', phase: 'implement', label: 'x', lane: 'implement', model: 'm', outcome: 'ok', costUsd: 1e6 }))
  let called = 0
  const c = createContext(args, { ...makeSim(root, args).runtime, lane: async req => { called++; return { result: { ok: true, awaiting: [], questions: [] }, usage: {}, costUsd: 0, durationMs: 0, model: req.model } } })
  c.cur = 'plan'
  await c.lane('premise', 'p', null)
  assert.equal(called, 1)
})

function capOf0(name) {
  const args = buildArgs(tmpRoot(`run-cap-probe-${name}`))
  return args.routing[name].budgetUsd ?? args.budgetsUsd[args.routing[name].tier]
}

test('a whole run whose run cap fits the T2 lanes but not a T3 one parks before the first T3 lane', async () => {
  const root = tmpRoot('run-cap-drive')
  const base = buildArgs(root)
  const args = { ...base, budgetsUsd: { ...base.budgetsUsd, run: base.budgetsUsd.T3 - 0.01 } }
  const sim = makeSim(root, args)
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.match(r.reason, /^budget-exhausted/)
  const t3 = Object.entries(args.routing).filter(([, x]) => x.tier === 'T3').map(([n]) => n)
  assert.ok(!sim.labels.some(l => t3.includes(l.split(':')[1])), sim.labels.join(' '))
  assert.ok(decisionsOf(root).some(d => d.kind === 'budget-exhausted'), JSON.stringify(decisionsOf(root)))
})
