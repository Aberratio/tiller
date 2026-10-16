import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../../contract/validate.mjs'
import { resolveRoot, runStatePath } from '../state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE = join(HERE, '..', 'state.mjs')
const RUNNER = join(HERE, 'fixtures', 'fake-runner.mjs')

const newRoot = () => join(mkdtempSync(join(tmpdir(), 'flow-state-')), 'profile-x', 'run-1')

function cli(root, args, env = {}) {
  const r = spawnSync('node', [STATE, ...args], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root, ...env } })
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `one stdout line, got: ${r.stdout}${r.stderr}`)
  const out = JSON.parse(lines[0])
  assert.deepEqual(check('script-result', out, r.status), [], `contract: ${lines[0]}`)
  return { code: r.status, out }
}

const ok = (root, args, env) => {
  const r = cli(root, args, env)
  assert.equal(r.code, 0, JSON.stringify(r.out))
  return r.out
}

const decision = (ticket, kind, extra = {}) => JSON.stringify({
  ticket, kind, question: `q ${kind}`, why: 'because', blocks: 'merge',
  ...(kind === 'harness-blocked' ? {} : { options: ['a', 'b'], recommendation: 'a', reversalCost: 'low' }),
  ...extra,
})

test('init is idempotent and writes a valid run-state record', () => {
  const root = newRoot()
  assert.equal(ok(root, ['init', 'ABC-1']).created, true)
  assert.equal(ok(root, ['init', 'ABC-1']).created, false)
  const run = JSON.parse(readFileSync(join(root, 'tickets', 'ABC-1', 'run.json'), 'utf8'))
  assert.deepEqual(check('run-state', run), [])
  assert.equal(run.runId, 'run-1')
  assert.equal(run.profile, 'profile-x')
})

test('phase-done validates the checkpoint and phase-get returns the latest output', () => {
  const root = newRoot()
  ok(root, ['init', 'ABC-1'])
  ok(root, ['phase-done', 'ABC-1', 'plan', '{"steps":1}', '--lane', 'plan'])
  ok(root, ['phase-done', 'ABC-1', 'plan', '{"steps":2}'])
  assert.deepEqual(ok(root, ['phase-get', 'ABC-1', 'plan']).output, { steps: 2 })
  assert.equal(ok(root, ['phase-get', 'ABC-1', 'review']).found, false)
  assert.equal(cli(root, ['phase-done', 'ABC-1', 'deploy', '{}']).code, 4)
  assert.equal(cli(root, ['phase-done', 'ABC-1', 'plan', '[1]']).code, 4)
  assert.equal(cli(root, ['phase-done', '../x', 'plan', '{}']).code, 4)
})

test('four concurrent decide processes lose no line', async () => {
  const root = newRoot()
  const per = 25
  const worker = i => new Promise((resolve, reject) => {
    const script = `
      const { spawnSync } = require('node:child_process')
      for (let n = 0; n < ${per}; n++) {
        const r = spawnSync('node', [${JSON.stringify(STATE)}, 'decide', ${JSON.stringify(decision(`T-${i}`, 'question'))}], { encoding: 'utf8' })
        if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1) }
      }`
    const p = spawn('node', ['-e', script], { env: { ...process.env, STATE_ROOT: root }, stdio: 'inherit' })
    p.on('exit', c => (c === 0 ? resolve() : reject(new Error(`worker ${i} exit ${c}`))))
  })
  await Promise.all([0, 1, 2, 3].map(worker))
  const lines = readFileSync(join(root, 'decisions.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 4 * per)
  const ids = new Set(lines.map(l => JSON.parse(l).id))
  assert.equal(ids.size, 4 * per)
  assert.equal(ok(root, ['open-count']).open, 4 * per)
})

test('open-count reads the whole file, whichever session wrote it', () => {
  const root = newRoot()
  ok(root, ['decide', decision('A-1', 'gate-red')], { FLOW_RUN: 'session-a' })
  ok(root, ['decide', decision('B-1', 'conflict')], { FLOW_RUN: 'session-b' })
  const runs = readFileSync(join(root, 'decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).runId)
  assert.deepEqual(runs, ['session-a', 'session-b'])
  assert.deepEqual(ok(root, ['open-count']), { status: 'ok', open: 2, byKind: { 'gate-red': 1, conflict: 1 } })
})

test('excluded, non-ceiling and resolved decisions are not counted', () => {
  const root = newRoot()
  ok(root, ['decide', decision('A-1', 'harness-blocked')])
  ok(root, ['decide', decision('A-1', 'ready-to-sign')])
  ok(root, ['decide', decision('A-1', 'quota')])
  ok(root, ['decide', decision('A-1', 'manual-qa')])
  const { id } = ok(root, ['decide', decision('A-1', 'question')])
  ok(root, ['decide', decision('A-1', 'split')])
  assert.equal(ok(root, ['open-count']).open, 3)
  assert.equal(ok(root, ['open-count', '--exclude', 'manual-qa']).open, 2)
  ok(root, ['resolve', id, '--resolution', 'took a', '--by', 'resolver'])
  assert.deepEqual(ok(root, ['open-count', '--exclude', 'manual-qa']).byKind, { split: 1 })
})

test('decide appends to the branch ledger and refuses a harness block shaped as a question', () => {
  const root = newRoot()
  const ledger = join(dirname(root), 'ledger.md')
  const { id } = ok(root, ['decide', decision('A-1', 'gate-red'), '--ledger', ledger])
  assert.equal(id, 'A-1-D1')
  assert.match(readFileSync(ledger, 'utf8'), /^- \S+ `A-1-D1` gate-red \(open\): q gate-red Why: because\. Options: a \/ b\.\n$/)
  const bad = JSON.stringify({ ticket: 'A-1', kind: 'harness-blocked', question: 'q', why: 'denied', blocks: 'merge', options: ['x', 'y'] })
  assert.equal(cli(root, ['decide', bad]).code, 4)
})

test('a torn last line from a killed writer does not break reads', () => {
  const root = newRoot()
  ok(root, ['decide', decision('A-1', 'gate-red')])
  appendFileSync(join(root, 'decisions.jsonl'), '{"id":"A-1-D2","kind":"gate')
  assert.equal(ok(root, ['open-count']).open, 1)
  assert.equal(ok(root, ['decide', decision('A-1', 'split')]).id, 'A-1-D2')
})

test('a write after a torn last line closes it first, so the new record is its own line', () => {
  const root = newRoot()
  ok(root, ['decide', decision('A-1', 'gate-red')])
  appendFileSync(join(root, 'decisions.jsonl'), '{"id":"A-1-D2","kind":"gate')
  const d2 = ok(root, ['decide', decision('A-1', 'split')]).id
  ok(root, ['resolve', d2, '--resolution', 'a', '--by', 'owner'])
  const lines = readFileSync(join(root, 'decisions.jsonl'), 'utf8').split('\n')
  assert.equal(lines.at(-1), '', 'the file ends with a newline')
  const parsed = lines.slice(0, -1).map(l => { try { return JSON.parse(l) } catch { return null } })
  assert.equal(parsed.filter(x => x === null).length, 1, 'only the torn fragment itself fails to parse')
  assert.deepEqual(parsed.filter(Boolean).map(d => [d.id, d.status]), [['A-1-D1', 'open'], ['A-1-D2', 'open'], ['A-1-D2', 'resolved']])
  assert.equal(ok(root, ['open-count']).open, 1)
})

test('a lock left by a killed holder is reclaimed', async () => {
  const root = newRoot()
  const holder = spawn('sleep', ['30'])
  const { token } = ok(root, ['lock', 'acquire', 'decisions', '--pid', String(holder.pid)])
  assert.equal(cli(root, ['lock', 'acquire', 'decisions', '--pid', String(process.pid), '--timeout', '0.2']).code, 1)
  holder.kill('SIGKILL')
  await new Promise(r => holder.on('exit', r))
  assert.equal(ok(root, ['decide', decision('A-1', 'gate-red')]).id, 'A-1-D1')
  assert.equal(cli(root, ['lock', 'release', 'decisions', token]).out.released, false)
})

test('counters survive in run state and report their cap', () => {
  const root = newRoot()
  ok(root, ['init', 'A-1'])
  ok(root, ['counter', 'A-1', 'fixRounds', '--inc'])
  const c = ok(root, ['counter', 'A-1', 'fixRounds', '--inc'])
  assert.deepEqual([c.value, c.cap, c.capReached], [2, 2, true])
  assert.equal(ok(root, ['counter', 'A-1', 'fixRounds']).value, 2)
  assert.equal(cli(root, ['counter', 'A-1', 'bogus']).code, 4)
})

test('a keyed --inc counts once however often the same call is retried', () => {
  const root = newRoot()
  ok(root, ['init', 'A-2'])
  assert.equal(ok(root, ['counter', 'A-2', 'fixRounds', '--inc', '--key', 'r1:review:1']).value, 1)
  const again = ok(root, ['counter', 'A-2', 'fixRounds', '--inc', '--key', 'r1:review:1'])
  assert.deepEqual([again.value, again.duplicate], [1, true])
  assert.equal(ok(root, ['counter', 'A-2', 'fixRounds', '--inc', '--key', 'r1:review:2']).value, 2)
  const batch = ok(root, ['batch', JSON.stringify([['counter', 'A-2', 'ciFix', '--inc', '--key', 'r1:ci:1'], ['counter', 'A-2', 'ciFix', '--inc', '--key', 'r1:ci:1']])])
  assert.equal(batch.value, 1)
  assert.equal(cli(root, ['counter', 'A-2', 'fixRounds', '--key', 'r1:review:3']).code, 4, 'a key without --inc is refused')
})

test('resume reports the run id the counter keys are built from', () => {
  const root = newRoot()
  ok(root, ['init', 'A-3'])
  assert.equal(typeof ok(root, ['resume', 'A-3']).runId, 'string')
})

test('quota is shared by every run of the profile', () => {
  const root = newRoot()
  const sibling = join(dirname(root), 'run-2')
  const reset = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
  ok(root, ['quota', 'set', 'review-bot', reset])
  assert.deepEqual(ok(sibling, ['quota', 'get']).quotas, [{ source: 'review-bot', resetAt: reset }])
  ok(root, ['quota', 'set', 'review-bot', '2020-01-01T00:00:00Z'])
  assert.equal(ok(sibling, ['quota', 'get', 'review-bot']).active, false)
})

test('quota writes are serialised across runs: the lock lives beside quota.json, not in the run', async () => {
  const root = newRoot()
  const profileDir = dirname(root)
  const holder = spawn('sleep', ['30'])
  await new Promise(r => holder.on('spawn', r))
  ok(profileDir, ['lock', 'acquire', 'quota', '--pid', String(holder.pid)])
  const reset = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
  const writer = spawn('node', [STATE, 'quota', 'set', 'review-bot', reset], { env: { ...process.env, STATE_ROOT: root } })
  let out = ''
  writer.stdout.on('data', d => { out += d })
  const exited = new Promise(r => writer.on('exit', code => r(code)))
  const early = await Promise.race([exited, new Promise(r => setTimeout(() => r('waiting'), 700))])
  assert.equal(early, 'waiting', `a sibling run's quota lock holds the write: ${out}`)
  assert.ok(!existsSync(join(root, 'locks')), 'no quota lock under the run itself')
  holder.kill('SIGKILL')
  assert.equal(await exited, 0, out)
  assert.equal(ok(dirname(root), ['lock', 'acquire', 'quota']).token.length > 0, true, 'released afterwards')
})

test('a corrupt quota.json reads as no quota, says so on stderr, and is overwritten by the next set', () => {
  const root = newRoot()
  mkdirSync(dirname(root), { recursive: true })
  writeFileSync(join(dirname(root), 'quota.json'), '{"review-bot":')
  const r = spawnSync('node', [STATE, 'quota', 'get'], { encoding: 'utf8', env: { ...process.env, STATE_ROOT: root } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim()), { status: 'ok', active: false, quotas: [] })
  assert.match(r.stderr, /quota\.json/)
  const reset = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, 'Z')
  ok(root, ['quota', 'set', 'review-bot', reset])
  assert.deepEqual(ok(root, ['quota', 'get']).quotas, [{ source: 'review-bot', resetAt: reset }])
})

test('runStatePath is the one spelling of the run-state layout', () => {
  assert.equal(runStatePath('p1', 'r1', { HOME: '/h' }), '/h/.claude/run-state/p1/r1')
  assert.equal(runStatePath('p1', undefined, { HOME: '/h' }), '/h/.claude/run-state/p1')
  assert.equal(resolveRoot({ HOME: '/h', FLOW_PROFILE: 'p1', FLOW_RUN: 'r1' }), '/h/.claude/run-state/p1/r1')
  assert.equal(resolveRoot({ STATE_ROOT: '/x/y/' }), '/x/y')
})

test('the default root is ~/.claude/run-state/<profile>/<run>/', () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-home-'))
  const env = { ...process.env, HOME: home, FLOW_PROFILE: 'p1', FLOW_RUN: 'r1' }
  delete env.STATE_ROOT
  const r = spawnSync('node', [STATE, 'init', 'A-1'], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stdout)
  assert.ok(existsSync(join(home, '.claude', 'run-state', 'p1', 'r1', 'tickets', 'A-1', 'run.json')))
  delete env.FLOW_RUN
  assert.equal(spawnSync('node', [STATE, 'init', 'A-1'], { env }).status, 4)
})

test('handoff appends sections and supervisor lines', () => {
  const root = newRoot()
  ok(root, ['handoff', 'wave 1 running'])
  ok(root, ['handoff', '--pause', '2026-09-28T12:00:00Z'])
  ok(root, ['handoff', '--done'])
  const md = readFileSync(join(root, 'state.md'), 'utf8')
  assert.match(md, /## Handoff \S+\n\nwave 1 running\n/)
  assert.match(md, /^supervisor: paused-usage 2026-09-28T12:00:00Z$/m)
  assert.match(md, /^supervisor: done$/m)
})

test('resume without checkpoints starts clean; resumes past the cap are flagged', () => {
  const root = newRoot()
  ok(root, ['init', 'A-1'])
  const first = ok(root, ['resume', 'A-1'])
  assert.deepEqual([first.startPhase, first.clean, first.resumes], ['start', true, 0])
  ok(root, ['phase-done', 'A-1', 'plan', '{}'])
  const seen = [1, 2, 3].map(() => ok(root, ['resume', 'A-1']))
  assert.deepEqual(seen.map(r => [r.startPhase, r.resumes, r.capReached]), [['implement', 1, false], ['implement', 2, false], ['implement', 3, true]])
})

test('a restart with no checkpoint counts from the second resume on, so a crash loop inside the first phase reaches the cap', () => {
  const root = newRoot()
  ok(root, ['init', 'A-1'])
  assert.equal(ok(root, ['run-get', 'A-1']).startedAt, null, 'nothing has started')
  const first = ok(root, ['resume', 'A-1'])
  assert.deepEqual([first.clean, first.restart, first.resumes, first.capReached], [true, false, 0, false], 'the first ever start is not a restart')
  assert.match(ok(root, ['run-get', 'A-1']).startedAt, /^\d{4}-\d{2}-\d{2}T/)
  const seen = [1, 2, 3].map(() => ok(root, ['resume', 'A-1']))
  assert.deepEqual(seen.map(r => [r.startPhase, r.clean, r.restart, r.resumes, r.capReached]), [['start', true, true, 1, false], ['start', true, true, 2, false], ['start', true, true, 3, true]])
  assert.equal(ok(root, ['run-get', 'A-1']).resumes, 3)
})

test('init draws one fence nonce per run and every resume returns it unchanged', () => {
  const root = newRoot()
  const a = ok(root, ['init', 'A-1'])
  const nonce = JSON.parse(readFileSync(join(root, 'tickets', 'A-1', 'run.json'), 'utf8')).fenceNonce
  assert.match(nonce, /^[0-9a-f]{16}$/)
  assert.equal(ok(root, ['init', 'A-1']).created, false)
  assert.equal(ok(root, ['resume', 'A-1']).fenceNonce, nonce)
  ok(root, ['phase-done', 'A-1', 'plan', '{}'])
  assert.equal(ok(root, ['resume', 'A-1']).fenceNonce, nonce)
  ok(root, ['init', 'A-2'])
  assert.notEqual(ok(root, ['resume', 'A-2']).fenceNonce, nonce)
  void a
})

test('run-get reports an unknown ticket as not found and touches nothing', () => {
  const root = newRoot()
  assert.deepEqual(ok(root, ['run-get', 'A-9']), { status: 'ok', ticket: 'A-9', found: false })
  assert.ok(!existsSync(join(root, 'tickets', 'A-9')))
})

test('a killed run resumes from its last checkpoint without replaying finished phases', async () => {
  const root = newRoot()
  const log = join(dirname(root), 'executed.log')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, '')
  const env = { ...process.env, STATE_ROOT: root, EXECUTED_LOG: log, PHASE_DELAY_MS: '100' }
  const first = spawn('node', [RUNNER, 'A-1'], { env, stdio: 'inherit' })
  const cpDir = join(root, 'tickets', 'A-1', 'checkpoints')
  const count = () => (existsSync(cpDir) ? readdirSync(cpDir).filter(f => f.endsWith('.json')).length : 0)
  for (let i = 0; count() < 4 && i < 400; i++) await new Promise(r => setTimeout(r, 10))
  first.kill('SIGKILL')
  await new Promise(r => first.on('exit', r))

  const done = readdirSync(cpDir).filter(f => f.endsWith('.json')).map(f => f.replace(/^\d+-|\.json$/g, ''))
  assert.ok(done.length >= 4 && done.length < 14, `killed mid-run after ${done.length} phases`)
  const r = spawnSync('node', [RUNNER, 'A-1'], { env: { ...env, PHASE_DELAY_MS: '0' }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)

  const lines = readFileSync(log, 'utf8').trim().split('\n')
  const second = lines.slice(lines.findLastIndex(l => l.startsWith('# start')))
  const phases = ['start', 'premise', 'plan', 'implement', 'review', 'pr', 'ci', 'review-bot', 'confidence', 'gate', 'merge', 'qa', 'cleanup', 'logs']
  const expectedStart = phases[phases.indexOf(done.at(-1)) + 1]
  assert.equal(second[0], `# start ${expectedStart} plan=3`, 'resumed at the next phase with the stored plan output')
  for (const p of done) assert.ok(!second.includes(p), `checkpointed phase ${p} was replayed`)
  const run = JSON.parse(readFileSync(join(root, 'tickets', 'A-1', 'run.json'), 'utf8'))
  assert.deepEqual([run.status, run.lastPhase, run.counters.resumes], ['merged', 'logs', 1])
})

test('a decide retried with the same key in the same run records one decision', () => {
  const root = newRoot()
  const first = ok(root, ['decide', decision('K-1', 'gate-red', { key: 'review:1' })])
  const again = ok(root, ['decide', decision('K-1', 'gate-red', { key: 'review:1' })])
  assert.equal(again.id, first.id)
  assert.equal(again.duplicate, true)
  const lines = readFileSync(join(root, 'decisions.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.filter(l => l.includes('"K-1"')).length, 1)
  const other = ok(root, ['decide', decision('K-1', 'gate-red', { key: 'review:1' })], { FLOW_RUN: 'another-run' })
  assert.notEqual(other.id, first.id)
  assert.equal(ok(root, ['decide', decision('K-1', 'gate-red', { key: 'review:2' })]).duplicate, undefined)
})

test('batch applies its writes in order and answers with the last one', () => {
  const root = newRoot()
  ok(root, ['init', 'B-1'])
  const r = ok(root, ['batch', JSON.stringify([
    ['counter', 'B-1', 'fixRounds', '--inc'],
    ['decide', decision('B-1', 'split', { key: 'review:1' })],
    ['counter', 'B-1', 'fixRounds'],
  ])])
  assert.equal(r.value, 1)
  assert.equal(r.batch.length, 2)
  assert.equal(r.batch[1].id, 'B-1-D1')
})

test('batch stops at the first refused write and says which one', () => {
  const root = newRoot()
  ok(root, ['init', 'B-2'])
  const r = cli(root, ['batch', JSON.stringify([
    ['counter', 'B-2', 'fixRounds', '--inc'],
    ['set-status', 'B-2', 'no-such-status'],
    ['counter', 'B-2', 'fixRounds', '--inc'],
  ])])
  assert.equal(r.code, 4)
  assert.equal(r.out.failedAt, 1)
  assert.equal(ok(root, ['counter', 'B-2', 'fixRounds']).value, 1)
  assert.equal(cli(root, ['batch', JSON.stringify([['batch', '[]']])]).code, 4)
})

test('decide creates the ledger directory a fresh worktree does not have yet', () => {
  const root = newRoot()
  const ledger = join(dirname(root), 'wt', 'docs', 'decisions', 'L-1.md')
  const r = ok(root, ['decide', decision('L-1', 'gate-red'), '--ledger', ledger])
  assert.match(readFileSync(ledger, 'utf8'), new RegExp(r.id))
})

// A parked run's run.json still read `running`. The terminal status and its
// reason ride on the logs checkpoint, one write, so a lost separate status call cannot leave it open.
test('phase-done --status/--reason writes the terminal status into run.json with the checkpoint', () => {
  const root = newRoot()
  ok(root, ['init', 'T-1'])
  ok(root, ['phase-done', 'T-1', 'logs', '{"status":"parked"}', '--status', 'parked', '--reason', 'review: 1 finding(s) open'])
  const run = JSON.parse(readFileSync(join(root, 'tickets', 'T-1', 'run.json'), 'utf8'))
  assert.equal(run.status, 'parked')
  assert.equal(run.reason, 'review: 1 finding(s) open')
  assert.deepEqual(check('run-state', run), [])
  assert.equal(cli(root, ['phase-done', 'T-1', 'logs', '{}', '--status', 'nope']).code, 4)
  ok(root, ['set-status', 'T-1', 'merged', '--reason', 'done'])
  assert.equal(JSON.parse(readFileSync(join(root, 'tickets', 'T-1', 'run.json'), 'utf8')).reason, 'done')
})

// The short reason stays short for the CLI line; the complete text rides alongside it in run.json.
test('phase-done --reason-full stores the complete text next to the short reason', () => {
  const root = newRoot()
  ok(root, ['init', 'T-2'])
  const full = 'harness-blocked: the repo rule is explicit: a failing frontend test is not believed until it fails in the container, because the host toolchain differs from the one CI pins. The container run could not be started.'
  ok(root, ['phase-done', 'T-2', 'logs', '{"status":"parked"}', '--status', 'parked', '--reason', 'harness-blocked: the repo rule is explicit…', '--reason-full', full])
  const read = () => JSON.parse(readFileSync(join(root, 'tickets', 'T-2', 'run.json'), 'utf8'))
  assert.equal(read().reasonFull, full)
  assert.equal(read().reason, 'harness-blocked: the repo rule is explicit…')
  assert.deepEqual(check('run-state', read()), [])
  ok(root, ['set-status', 'T-2', 'merged', '--reason', 'done'])
  assert.equal(read().reasonFull, undefined, 'a later status without a full reason drops the stale one')
})

test('the state hash ignores logs and a rotated log', () => {
  const root = newRoot()
  ok(root, ['handoff', 'started'])
  const before = ok(root, ['hash']).hash
  writeFileSync(join(root, 'supervisor.log'), 'line\n')
  writeFileSync(join(root, 'supervisor.log.1'), 'old line\n')
  assert.equal(ok(root, ['hash']).hash, before)
})
