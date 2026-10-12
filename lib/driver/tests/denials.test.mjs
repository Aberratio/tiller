// 18-r3 A12/S11: a lane is harness-blocked on the runtime's own record of a refused tool call, not on a
// regex over what the model wrote. The regex stays only for a runtime that cannot report denials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildArgs, decisionsOf, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { awaitingRules, triageAwaiting, triageWithDenials } from '../../contract/awaiting.mjs'

const RULES = awaitingRules()
const DENIAL = { tool: 'Bash', input: { command: 'git push origin HEAD' }, text: 'Permission denied: Bash(git push origin HEAD)' }
const quoted = { kind: 'harness-blocked', question: 'push refused', why: 'Permission to use Bash has been denied', blocks: 'push' }
const prose = { kind: 'harness-blocked', question: 'push refused', why: 'the sandbox stopped my push', blocks: 'push' }
const decision = { kind: 'scope', question: 'which module?', why: 'vague', blocks: 'plan' }

test('A12: a runtime that cannot report denials keeps the regex triage exactly', () => {
  const result = { awaiting: [quoted, prose, decision] }
  assert.deepEqual(triageWithDenials('implement', result, RULES, undefined), triageAwaiting('implement', result, RULES))
})

test('A12: a quoted refusal with no runtime denial is a note, never a refusal', () => {
  const t = triageWithDenials('implement', { awaiting: [quoted, decision] }, RULES, [])
  assert.deepEqual(t.refusals, [])
  assert.deepEqual(t.notes, [quoted])
  assert.deepEqual(t.decisions, [decision])
})

test('A12: a real denial makes a harness-blocked item a refusal even in unquoted prose, and the why is the runtime\'s literal call', () => {
  const t = triageWithDenials('implement', { awaiting: [prose] }, RULES, [DENIAL])
  assert.equal(t.refusals.length, 1)
  assert.equal(t.refusals[0].why, DENIAL.text)
  assert.equal(t.refusals[0].question, prose.question)
})

test('A12: a prose lane stays notes-only, denial or not', () => {
  const t = triageWithDenials('pr-description', { awaiting: [quoted] }, RULES, [DENIAL])
  assert.deepEqual(t.refusals, [])
  assert.deepEqual(t.notes, [quoted])
})

const withDenials = (sim, denialsFor) => {
  const inner = sim.runtime.lane
  sim.runtime = {
    ...sim.runtime,
    lane: async opts => {
      const lane = opts.label.split(':')[1]
      try {
        return { ...(await inner(opts)), denials: denialsFor(lane) }
      } catch (e) { throw Object.assign(e, { denials: denialsFor(lane) }) }
    },
  }
  return sim
}

test('A12 (ABC-8846 defect 2 shape): a finished lane quoting a refusal the runtime never recorded does not hold the gate', async () => {
  const root = tmpRoot('drv-denial-none')
  const finished = (lane, ctx) => lane === 'implement' ? {
    ok: true, headSha: ctx.nextSha(), commits: ['efceddaf feat: a'], testCommand: 'make test', testResult: 'pass', awaiting: [quoted],
  } : undefined
  const sim = withDenials(makeSim(root, buildArgs(root), { agent: finished, skipLaneCheck: true }), () => [])
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'merged', JSON.stringify(r))
})

test('A12: an unfinished lane with a runtime denial parks harness-blocked after one identical retry, quoting the runtime\'s call', async () => {
  const root = tmpRoot('drv-denial-park')
  const blocked = lane => lane === 'implement' ? { ok: false, awaiting: [prose] } : undefined
  const sim = withDenials(makeSim(root, buildArgs(root), { agent: blocked, skipLaneCheck: true }), lane => lane === 'implement' ? [DENIAL] : [])
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.equal(sim.labels.filter(l => l.split(':')[1] === 'implement').length, 2, sim.labels.join(' '))
  const d = decisionsOf(root).find(x => x.kind === 'harness-blocked')
  assert.ok(d, JSON.stringify(decisionsOf(root)))
  assert.equal(d.why, DENIAL.text)
})

test('A12: a lane that died with a runtime denial is harness-blocked without asking the text classifier', async () => {
  const root = tmpRoot('drv-denial-throw')
  const dies = lane => lane === 'implement' ? { throw: 'claude exited 1 (error_during_execution)' } : undefined
  const sim = withDenials(makeSim(root, buildArgs(root), { agent: dies, skipLaneCheck: true }), lane => lane === 'implement' ? [DENIAL] : [])
  const r = await runTicketDriver(sim)
  assert.equal(r.status, 'parked', JSON.stringify(r))
  assert.ok(!sim.execs.some(e => e.argv[0] === 'classify' && /error_during_execution/.test(e.argv.join(' '))), 'classifier was asked')
  assert.equal(decisionsOf(root).find(x => x.kind === 'harness-blocked').why, DENIAL.text)
})
