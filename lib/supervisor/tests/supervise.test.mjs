import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from '../../contract/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SUPERVISE = join(HERE, '..', 'supervise.sh')
const STATE = join(HERE, '..', '..', 'state', 'state.mjs')
const RUNNER = join(HERE, '..', '..', 'state', 'tests', 'fixtures', 'fake-runner.mjs')
const CLASSIFY = join(HERE, '..', '..', 'resilience', 'classify-failure.mjs')

function setup(behavior, env = {}) {
  const base = mkdtempSync(join(tmpdir(), 'flow-sup-'))
  const root = join(base, 'profile-x', 'run-1')
  const stub = join(base, 'stub')
  mkdirSync(stub, { recursive: true })
  const brief = join(base, 'brief.md')
  writeFileSync(brief, 'Run the queue.\n')
  const behaviorFile = join(base, 'behavior.sh')
  writeFileSync(behaviorFile, `set -u\nS() { node ${JSON.stringify(STATE)} "$@" >/dev/null; }\n${behavior}\n`)
  const sleeps = join(base, 'sleeps')
  const sleepCmd = join(base, 'record-sleep')
  writeFileSync(sleepCmd, `#!/usr/bin/env bash\necho "$1" >>${JSON.stringify(sleeps)}\n`)
  chmodSync(sleepCmd, 0o755)
  const fullEnv = {
    ...process.env,
    PATH: `${join(HERE, 'bin')}:${process.env.PATH}`,
    STATE_ROOT: root,
    STUB_DIR: stub,
    STUB_BEHAVIOR: behaviorFile,
    SUPERVISE_SLEEP_CMD: sleepCmd,
    SUPERVISE_CLASSIFY: join(base, 'no-classifier'),
    EXECUTED_LOG: join(base, 'executed.log'),
    ...env,
  }
  delete fullEnv.SUPERVISE_STOP_HOUR
  if (env.SUPERVISE_STOP_HOUR !== undefined) fullEnv.SUPERVISE_STOP_HOUR = env.SUPERVISE_STOP_HOUR
  const run = () => {
    const r = spawnSync('bash', [SUPERVISE, brief], { encoding: 'utf8', env: fullEnv })
    const out = JSON.parse(r.stdout.trim().split('\n').pop())
    return { code: r.status, out, stderr: r.stderr }
  }
  const calls = () => Number(existsSync(join(stub, 'calls')) ? readFileSync(join(stub, 'calls'), 'utf8') : 0)
  const args = n => readFileSync(join(stub, `args-${n}`), 'utf8').split('\0')
  const slept = () => (existsSync(sleeps) ? readFileSync(sleeps, 'utf8').trim().split('\n').map(Number) : [])
  return { base, root, run, calls, args, slept, fullEnv, brief }
}

const contract = ({ code, out }) => assert.deepEqual(check('script-result', out, code), [], JSON.stringify(out))
const inFuture = min => new Date(Date.now() + min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z')

test('exits 0 once the state says done', () => {
  const s = setup('S handoff "all merged"; S handoff --done')
  const r = s.run()
  assert.equal(r.code, 0, r.stderr)
  contract(r)
  assert.equal(s.calls(), 1)
})

test('children are bounded and never skip permissions', () => {
  const s = setup('S handoff --done', { SUPERVISE_DISALLOWED_TOOLS: 'tool_a tool_b', SUPERVISE_MAX_TURNS: '40' })
  s.run()
  const a = s.args(1)
  assert.ok(!a.includes('--dangerously-skip-permissions'))
  assert.equal(a[0], '-p')
  assert.match(a[1], /state\.mjs resume <ticket>/)
  assert.match(a[1], /## Brief\nRun the queue\./)
  for (const [flag, value] of [['--permission-mode', 'auto'], ['--max-turns', '40'], ['--output-format', 'json'], ['--name', 'flow-run-1-1']]) {
    assert.equal(a[a.indexOf(flag) + 1], value, flag)
  }
  assert.deepEqual(a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--disallowedTools') + 3), ['tool_a', 'tool_b'])
})

test('every child gets --max-budget-usd: SUPERVISE_MAX_BUDGET_USD, else budgetsUsd.run from config/routing.json', () => {
  const routing = JSON.parse(readFileSync(join(HERE, '..', '..', '..', 'config', 'routing.json'), 'utf8'))
  for (const [env, want] of [[{ SUPERVISE_MAX_BUDGET_USD: '12.5' }, '12.5'], [{}, String(routing.budgetsUsd.run)]]) {
    const s = setup('S handoff --done', { SUPERVISE_DISALLOWED_TOOLS: 'tool_a', ...env })
    s.run()
    const a = s.args(1)
    assert.equal(a[a.indexOf('--max-budget-usd') + 1], want, JSON.stringify(env))
    assert.ok(a.indexOf('--max-budget-usd') < a.indexOf('--disallowedTools'), 'the variadic --disallowedTools stays last')
  }
})

test('SUPERVISE_DRY prints the child command and spawns nothing', () => {
  const s = setup('S handoff --done', { SUPERVISE_DRY: '1' })
  const r = s.run()
  assert.equal(r.code, 0)
  contract(r)
  assert.equal(s.calls(), 0)
  assert.match(r.stderr, /DRY: claude -p/)
})

test('exits 2 at the spawn cap when every child progresses but none finishes', () => {
  const s = setup('S handoff "wave $STUB_CALL done"', { SUPERVISE_MAX_SPAWNS: '3' })
  const r = s.run()
  assert.equal(r.code, 2)
  contract(r)
  assert.equal(s.calls(), 3)
})

test('exits 3 at the stop hour without spawning', () => {
  const s = setup('S handoff --done', { SUPERVISE_STOP_HOUR: '0' })
  const r = s.run()
  assert.equal(r.code, 3)
  assert.equal(r.out.status, 'blocked')
  assert.equal(r.out.kind, 'stop-hour')
  contract(r)
  assert.equal(s.calls(), 0)
})

test('exits 5 after two consecutive spawns that leave state unchanged', () => {
  const s = setup('true')
  const r = s.run()
  assert.equal(r.code, 5)
  contract(r)
  assert.equal(s.calls(), 2)
})

test('a progressing spawn resets the no-progress count', () => {
  const s = setup('[ "$STUB_CALL" = 2 ] && S handoff "moved"; [ "$STUB_CALL" = 4 ] && S handoff --done; true')
  const r = s.run()
  assert.equal(r.code, 0)
  assert.equal(s.calls(), 4)
})

test('exits 6 on a usage pause that cannot be waited out', () => {
  const reset = inFuture(600)
  const s = setup(`S handoff --pause ${reset}; exit 1`)
  const r = s.run()
  assert.equal(r.code, 6)
  contract(r)
  assert.equal(r.out.retryAfter, reset)
})

test('a usage limit seen only in the child output is classified by the real classifier and pauses', () => {
  const reset = inFuture(600)
  const s = setup(`echo '{"is_error":true,"result":"You'"'"'ve hit your usage limit. It resets at ${reset}."}'; exit 1`)
  s.fullEnv.SUPERVISE_CLASSIFY = CLASSIFY
  const r = s.run()
  assert.equal(r.code, 6)
  contract(r)
  assert.equal(r.out.retryAfter, reset)
})

test('a short usage pause is waited out, then the run continues', () => {
  const s = setup(`[ "$STUB_CALL" = 1 ] && { S handoff --pause ${inFuture(2)}; exit 1; }; S handoff --done`)
  const r = s.run()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(s.calls(), 2)
  const [wait] = s.slept()
  assert.ok(wait >= 110 && wait <= 155, `waited ${wait}s`)
})

test('a child killed mid-run is followed by one that resumes from its checkpoint', () => {
  const s = setup(`
    if [ "$STUB_CALL" = 1 ]; then DIE_AFTER=implement node ${JSON.stringify(RUNNER)} A-1; exit 137; fi
    node ${JSON.stringify(RUNNER)} A-1 && S handoff "A-1 merged" && S handoff --done`)
  writeFileSync(s.fullEnv.EXECUTED_LOG, '')
  const r = s.run()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(s.calls(), 2)
  const lines = readFileSync(s.fullEnv.EXECUTED_LOG, 'utf8').trim().split('\n')
  const executed = lines.filter(l => !l.startsWith('#'))
  assert.deepEqual(lines.filter(l => l.startsWith('#')), ['# start start plan=-', '# start review plan=3'])
  assert.equal(new Set(executed).size, executed.length, `a phase ran twice: ${executed}`)
  assert.equal(executed.length, 14)
  const cps = readdirSync(join(s.root, 'tickets', 'A-1', 'checkpoints'))
  assert.equal(cps.length, 14)
})

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (pred, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 50)) }
  return pred()
}

for (const [sig, n] of [['SIGTERM', 15], ['SIGHUP', 1], ['SIGINT', 2]]) {
  test(`${sig} kills the running child's process group and exits ${128 + n}`, async () => {
    const s = setup('echo $$ >"$STUB_DIR/child.pid"; sleep 30 </dev/null >/dev/null 2>&1 & echo $! >"$STUB_DIR/grandchild.pid"; wait')
    const stub = join(s.base, 'stub')
    const p = spawn('bash', [SUPERVISE, s.brief], { env: s.fullEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', d => { out += d })
    const closed = new Promise(r => p.on('close', code => r(code)))
    assert.ok(await until(() => existsSync(join(stub, 'grandchild.pid')) && readFileSync(join(stub, 'grandchild.pid'), 'utf8').trim()), 'child started')
    const child = Number(readFileSync(join(stub, 'child.pid'), 'utf8'))
    const grandchild = Number(readFileSync(join(stub, 'grandchild.pid'), 'utf8'))
    p.kill(sig)
    const code = await closed
    assert.equal(code, 128 + n)
    const line = JSON.parse(out.trim().split('\n').pop())
    assert.equal(line.status, 'error')
    assert.equal(line.kind, 'script-error')
    assert.match(line.reason, new RegExp(`killed by ${sig}`))
    assert.ok(await until(() => !alive(child) && !alive(grandchild)), `child ${child} or grandchild ${grandchild} survived`)
  })
}

test('exits 1 with a clear reason when claude is not on PATH, before any spawn', () => {
  const s = setup('S handoff --done')
  const bin = join(s.base, 'nodeonly')
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, 'node'))
  s.fullEnv.PATH = `${bin}:/usr/bin:/bin`
  const r = s.run()
  assert.equal(r.code, 1)
  assert.equal(r.out.status, 'error')
  assert.equal(r.out.kind, 'script-error')
  assert.match(r.out.reason, /claude not found on PATH/)
  contract(r)
  assert.equal(s.calls(), 0)
})

test('supervisor.log over SUPERVISE_LOG_MAX_BYTES is moved to supervisor.log.1', () => {
  const s = setup('S handoff --done', { SUPERVISE_LOG_MAX_BYTES: '2000' })
  mkdirSync(s.root, { recursive: true })
  const old = 'x'.repeat(3000) + '\n'
  writeFileSync(join(s.root, 'supervisor.log'), old)
  writeFileSync(join(s.root, 'supervisor.log.1'), 'older\n')
  const r = s.run()
  assert.equal(r.code, 0, r.stderr)
  assert.equal(readFileSync(join(s.root, 'supervisor.log.1'), 'utf8'), old)
  assert.ok(statSync(join(s.root, 'supervisor.log')).size < 2000)
  assert.match(readFileSync(join(s.root, 'supervisor.log'), 'utf8'), /exit 0/)
})

test('supervisor.log under the cap is appended to, not rotated', () => {
  const s = setup('S handoff --done')
  mkdirSync(s.root, { recursive: true })
  writeFileSync(join(s.root, 'supervisor.log'), 'earlier run\n')
  s.run()
  assert.match(readFileSync(join(s.root, 'supervisor.log'), 'utf8'), /^earlier run\n/)
  assert.ok(!existsSync(join(s.root, 'supervisor.log.1')))
})
