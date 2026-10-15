import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HARNESS, PROFILE, NO_TRACKER, buildDayArgs, decisionsOf, makeSim, runDayDriver, state, tmpRoot } from '../../flow-run-ticket/tests/dryrun.mjs'

const lastLine = s => JSON.parse(String(s).trim().split('\n').pop())
const record = root => JSON.parse(readFileSync(join(root, 'day-result.json'), 'utf8'))

function dayArgsWith(root, ...extra) {
  const qf = join(root, 'queue.json')
  writeFileSync(qf, JSON.stringify([['ABC-1']]))
  const p = spawnSync(process.execPath, [HARNESS, 'day-args', '--profile', PROFILE, '--date', '2026-09-28', '--root', root, '--queue', qf, ...extra], { encoding: 'utf8' })
  const result = lastLine(p.stdout)
  return { exitCode: p.status, result, args: result.status === 'ok' ? JSON.parse(readFileSync(result.artifact, 'utf8')) : null }
}

test('day-args carries no driver field or ticket script, builds the role agents, and refuses --driver', () => {
  const def = dayArgsWith(tmpRoot('dd-default'))
  assert.equal(def.exitCode, 0, JSON.stringify(def.result))
  assert.equal(def.args.driver, undefined)
  assert.equal(def.args.runTicketScript, undefined)
  assert.equal(def.args.agents.resolver, 'flow-resolver')
  for (const extra of [['--driver', 'workflow'], ['--driver', 'node'], ['--driver']]) {
    const root = tmpRoot('dd-flag')
    const r = dayArgsWith(root, ...extra)
    assert.equal(r.exitCode, 4)
    assert.match(r.result.reason, /--driver is gone/)
    assert.ok(!existsSync(join(root, 'args-day.json')))
  }
})

test('drive-day refuses an args file that names the retired Workflow runner, before taking the day lock', () => {
  const root = tmpRoot('dd-legacy')
  const built = dayArgsWith(root)
  assert.equal(built.exitCode, 0, JSON.stringify(built.result))
  const legacy = join(root, 'args-day-legacy.json')
  writeFileSync(legacy, JSON.stringify({ ...built.args, driver: 'workflow' }))
  const p = spawnSync(process.execPath, [HARNESS, 'drive-day', '--args', legacy], { encoding: 'utf8' })
  const r = lastLine(p.stdout)
  assert.equal(p.status, 4, p.stdout)
  assert.equal(r.status, 'refused')
  assert.equal(r.kind, 'policy')
  assert.match(r.reason, /retired Workflow runner/)
  assert.ok(!existsSync(join(root, 'day-result.json')), 'no completion record for a refused day')
  assert.ok(!existsSync(join(root, 'locks', 'day.lock')), 'the day lock was never taken')
})

test('the completion record says running with the pid while the day runs, and the outcome when it ends', async () => {
  const root = tmpRoot('dd-record')
  const args = buildDayArgs(root, { queue: [['ABC-1']] })
  const sim = makeSim(root, args)
  let during = null
  const { drive } = await import('../../../lib/driver/drive.mjs')
  const r = await runDayDriver(sim, { pid: 4242, launch: async (entry, childArgs) => {
    during = record(root)
    sim.children.push(entry.ticket)
    return (await drive(childArgs, sim.runtime)).result
  } })
  assert.equal(during.status, 'running')
  assert.equal(during.pid, 4242)
  assert.equal(r.status, 'done', JSON.stringify(r.reason))
  const after = record(root)
  assert.equal(after.status, 'done')
  assert.deepEqual(after.results.map(x => [x.ticket, x.status]), [['ABC-1', 'merged']])
  assert.ok(!existsSync(join(root, 'locks', 'day.lock')), 'the day lock is released')
  assert.ok(existsSync(join(root, 'tickets', 'day-2026-09-28', 'driver-journal.jsonl')), 'day lanes are journaled')
})

// 2026-10-06: a day run died and left no completion record; the summary was written by hand.
test('a crash inside the day driver still writes the completion record and a handoff, and frees the lock', async () => {
  const root = tmpRoot('dd-crash')
  const args = buildDayArgs(root, { queue: [['ABC-1'], ['ABC-2']] })
  const sim = makeSim(root, args)
  let wave = 0
  const exec = async (argv, opts) => {
    if (argv.includes('open-count') && ++wave === 2) throw new Error('ENOMEM: the driver ran out of memory')
    return sim.runtime.exec(argv, opts)
  }
  const r = await runDayDriver(sim, { exec })
  assert.equal(r.status, 'died')
  assert.match(r.reason, /ENOMEM/)
  assert.ok(r.fatal, 'the crash comes back as fatal')
  const rec = record(root)
  assert.equal(rec.status, 'died')
  assert.match(rec.reason, /ENOMEM/)
  assert.deepEqual(rec.results.map(x => [x.ticket, x.status]), [['ABC-1', 'merged']], 'what finished before the crash is kept')
  const md = readFileSync(join(root, 'state.md'), 'utf8')
  assert.match(md, /day 2026-09-28 died/)
  assert.doesNotMatch(md, /supervisor: done/)
  assert.ok(!existsSync(join(root, 'locks', 'day.lock')))
})

test('a second day driver on the same root is refused while the first is alive, and touches nothing', async () => {
  const root = tmpRoot('dd-lock')
  const args = buildDayArgs(root, { queue: [['ABC-1']] })
  assert.equal(state(root, 'lock', 'acquire', 'day', '--pid', String(process.pid), '--ttl', '86400').status, 'ok')
  writeFileSync(join(root, 'day-result.json'), JSON.stringify({ status: 'running', pid: process.pid }))
  const sim = makeSim(root, args)
  const r = await runDayDriver(sim)
  assert.equal(r.status, 'refused')
  assert.match(r.reason, /day lock/)
  assert.deepEqual(sim.children, [])
  assert.deepEqual(sim.labels, [])
  assert.deepEqual(record(root), { status: 'running', pid: process.pid }, 'the live run keeps its record')
})

test('lift-cap-once is spent once per day: a rerun after the lift does not ask the proxy again', async () => {
  const root = tmpRoot('dd-lift')
  const profile = join(root, 'acme-lift.md')
  writeFileSync(profile, readFileSync(PROFILE, 'utf8').replace('- Mandate: `start-next-ticket`,', '- Mandate: `lift-cap-once`, `start-next-ticket`,'))
  const args = buildDayArgs(root, { profile, queue: [['ABC-1', 'ABC-2', 'ABC-3']] })
  assert.ok(!args.refused, JSON.stringify(args.refused))
  for (let i = 0; i < args.facts.runPolicy.dayCeiling; i++)
    state(root, 'decide', JSON.stringify({ ticket: `ABC-9${i}`, kind: 'question', question: `seeded ${i}`, why: 'x', blocks: 'ABC-9', options: ['a', 'b'], recommendation: 'a', reversalCost: 'low' }))
  const lifts = sim => sim.labels.filter(l => l.includes(':owner-proxy:T3:lift-cap-once')).length
  const first = makeSim(root, args)
  const r1 = await runDayDriver(first)
  assert.equal(lifts(first), 1)
  assert.equal(r1.status, 'ceiling')
  assert.equal(r1.liftedOnce, true)
  assert.deepEqual(first.children, ['ABC-1', 'ABC-2'])
  const second = makeSim(root, args)
  const r2 = await runDayDriver(second)
  assert.equal(lifts(second), 0, 'the lift was already spent today')
  assert.equal(r2.status, 'ceiling')
  assert.ok(decisionsOf(root).filter(d => d.kind === 'ceiling').length >= 1)
})

// ------------------------------------------------------------------------------ the CLI, for real

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs')
const prompt = readFileSync(0, 'utf8')
const kind = /Check the ticket's premise/.test(prompt) ? 'premise' : /summarising run/.test(prompt) ? 'run-prose'
  : /this sweep looks only/.test(prompt) ? 'sweep' : /summary of day run/.test(prompt) ? 'day-prose' : 'other'
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ kind, argv: process.argv.slice(2) }) + '\\n')
if (kind === 'premise' && process.env.FAKE_CLAUDE_HANG) { writeFileSync(process.env.FAKE_CLAUDE_HANG, String(process.pid)); setInterval(() => {}, 1000); return }
const out = { premise: { verdict: 'falsified', evidence: 'src/cli.js does not exist', awaiting: [] },
  'run-prose': { text: 'The run parked at the premise.', awaiting: [] },
  sweep: { summary: 'Nothing interacts.', regressions: [], awaiting: [] },
  'day-prose': { text: 'The day ran one ticket.', awaiting: [] } }[kind]
if (!out) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, errors: ['unexpected prompt'] })); process.exit(1) }
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, total_cost_usd: 0.01,
  modelUsage: { 'claude-sonnet-4-5': { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } }))
`

function fixture(tag, env = {}) {
  const dir = realpathSync(tmpRoot(tag))
  const repo = join(dir, 'sample-cli')
  mkdirSync(repo)
  const git = (...a) => assert.equal(spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]).status, 0)
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'sample\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  const origin = join(dir, 'origin.git')
  assert.equal(spawnSync('git', ['init', '-q', '--bare', origin]).status, 0)
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  const profile = join(dir, 'profile.md')
  writeFileSync(profile, readFileSync(NO_TRACKER, 'utf8').replace('/tmp/sample-cli', repo))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'claude'), FAKE_CLAUDE)
  chmodSync(join(dir, 'bin', 'claude'), 0o755)
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr list" ] && { echo '[]'; exit 0; }\nexit 1\n`)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  const spec = join(dir, 'add-flag.md')
  writeFileSync(spec, '# Add a --json flag\n')
  const qf = join(dir, 'queue.json')
  writeFileSync(qf, JSON.stringify([[{ spec }]]))
  const root = join(dir, 'state')
  const fullEnv = { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: join(dir, 'claude.jsonl'), STATE_ROOT: '', ...env }
  const built = spawnSync(process.execPath, [HARNESS, 'day-args', '--profile', profile, '--date', '2026-09-30', '--root', root, '--queue', qf], { encoding: 'utf8', env: fullEnv })
  assert.equal(built.status, 0, built.stdout)
  // The fixture profile's stop hour would make these real-clock runs depend on the time of day.
  const artifact = lastLine(built.stdout).artifact
  const a = JSON.parse(readFileSync(artifact, 'utf8'))
  a.facts.runPolicy.stopHour = null
  writeFileSync(artifact, JSON.stringify(a))
  const calls = () => existsSync(fullEnv.FAKE_CLAUDE_LOG) ? readFileSync(fullEnv.FAKE_CLAUDE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { dir, root, artifact: lastLine(built.stdout).artifact, env: fullEnv, calls }
}

test('drive-day runs the day for real: each ticket through its own drive.mjs process, one result line, the record written', () => {
  const f = fixture('dd-e2e')
  const p = spawnSync(process.execPath, [HARNESS, 'drive-day', '--args', f.artifact], { encoding: 'utf8', env: f.env })
  assert.equal(p.status, 0, p.stdout + p.stderr)
  assert.equal(p.stdout.trim().split('\n').length, 1, 'stdout is one script-result line')
  const line = lastLine(p.stdout)
  assert.equal(line.status, 'ok')
  assert.equal(line.dayStatus, 'done', JSON.stringify(line))
  assert.deepEqual(line.results, [{ ticket: 'ADD-FLAG', status: 'parked' }])
  assert.equal(line.record, join(f.root, 'day-result.json'))
  assert.equal(record(f.root).status, 'done')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'tickets', 'ADD-FLAG', 'driver-result.json'), 'utf8')).status, 'parked', 'the child wrote its own result')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'args-ADD-FLAG.json'), 'utf8')).ticket, 'ADD-FLAG', 'the child args were written for it')
  const kinds = f.calls().map(c => c.kind)
  assert.deepEqual(kinds, ['premise', 'run-prose', 'sweep', 'day-prose'], 'no exec lane, nothing else called')
  const tier = kind => { const c = f.calls().find(x => x.kind === kind); return c.argv[c.argv.indexOf('--model') + 1] }
  assert.equal(tier('sweep'), 'sonnet')
  assert.equal(tier('day-prose'), 'sonnet')
  for (const c of f.calls()) for (const t of ['Agent', 'Task', 'Workflow']) assert.ok(c.argv.slice(c.argv.indexOf('--disallowedTools')).includes(t), `${c.kind}: ${t}`)
  assert.match(readFileSync(join(f.root, 'state.md'), 'utf8'), /supervisor: done/)
  assert.match(readFileSync(join(f.root, 'day-summary.md'), 'utf8'), /The day ran one ticket/)
})

test('drive-day killed with SIGTERM takes its children down and still leaves a completion record', async () => {
  const f = fixture('dd-sigterm')
  const hang = join(f.dir, 'hang.pid')
  const day = spawn(process.execPath, [HARNESS, 'drive-day', '--args', f.artifact], { env: { ...f.env, FAKE_CLAUDE_HANG: hang }, stdio: 'ignore' })
  const exited = new Promise(res => day.on('exit', (code, signal) => res({ code, signal })))
  for (let i = 0; i < 200 && !existsSync(hang); i++) await delay(50)
  assert.ok(existsSync(hang), 'the premise lane started')
  const claudePid = Number(readFileSync(hang, 'utf8'))
  // drive-day is a thin wrapper; the day driver is its child.
  const rec0 = record(f.root)
  assert.equal(rec0.status, 'running')
  process.kill(rec0.pid, 'SIGTERM')
  await exited
  const rec = record(f.root)
  assert.equal(rec.status, 'died')
  assert.match(rec.reason, /SIGTERM/)
  assert.match(readFileSync(join(f.root, 'state.md'), 'utf8'), /day 2026-09-30 died/)
  let alive = true
  for (let i = 0; i < 40 && alive; i++) { try { process.kill(claudePid, 0); await delay(50) } catch { alive = false } }
  assert.ok(!alive, 'the hanging lane of the child was killed with the day')
})
