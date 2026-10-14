import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEAD_PID, buildArgs, makeSim, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { acquire, lockOwner } from '../../state/state.mjs'
import { drive } from '../drive.mjs'

const LOCK = 'ticket-run-ABC-1'
const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVE = join(HERE, '..', 'drive.mjs')
const owner = root => lockOwner(root, LOCK)

// A live process that is not this one: what a run still working on the ticket looks like from outside.
async function liveHolder(root) {
  const holder = spawn('sleep', ['30'])
  await new Promise(r => holder.on('spawn', r))
  acquire(root, LOCK, { pid: holder.pid })
  return holder
}

test('a ticket whose run lock is held by another live process is refused before any state is touched', async () => {
  const root = tmpRoot('lock-live')
  const args = buildArgs(root)
  const holder = await liveHolder(root)
  // `args` seeds the run record; a refused launch must leave it exactly as found.
  const runFile = join(root, 'tickets', 'ABC-1', 'run.json')
  const before = existsSync(runFile) ? readFileSync(runFile, 'utf8') : null
  try {
    const sim = makeSim(root, args)
    const { result, fatal, locked } = await drive(args, sim.runtime)
    assert.equal(fatal, null)
    assert.equal(locked && locked.pid, holder.pid, JSON.stringify(locked))
    assert.equal(result.status, 'running', 'the ticket is still being run, by the holder')
    assert.match(result.reason, new RegExp(`pid ${holder.pid}`))
    assert.deepEqual(sim.execs, [], 'no resume, no checkpoint, nothing executed')
    assert.deepEqual(sim.labels, [], 'no lane called')
    assert.equal(existsSync(runFile) ? readFileSync(runFile, 'utf8') : null, before, 'the run record is untouched')
    assert.ok(!existsSync(join(root, 'tickets', 'ABC-1', 'steps.jsonl')), 'no step log opened')
    assert.equal(owner(root).pid, holder.pid, 'the holder keeps its lock')
  } finally { holder.kill('SIGKILL') }
})

test('a run lock left by a dead process is broken and the run proceeds, holding the lock under its own pid until it ends', async () => {
  const root = tmpRoot('lock-dead')
  const args = buildArgs(root)
  acquire(root, LOCK, { pid: DEAD_PID })
  const sim = makeSim(root, args)
  const { locked } = await drive(args, sim.runtime)
  assert.equal(locked, undefined)
  assert.ok(sim.execs.some(e => e.name === 'resume'), 'the run resumed')
  assert.equal(owner(root), null, 'the lock is released when the run ends')
})

test('a run lock left by an earlier run inside this same process is not a live holder', async () => {
  const root = tmpRoot('lock-self')
  const args = buildArgs(root)
  acquire(root, LOCK, { pid: process.pid })
  const sim = makeSim(root, args)
  const { locked } = await drive(args, sim.runtime)
  assert.equal(locked, undefined)
  assert.ok(sim.execs.some(e => e.name === 'resume'), 'the run resumed')
  assert.equal(owner(root), null)
})

test('the lock is held for the whole run: a parallel launch of the same ticket is refused mid-run', async () => {
  const root = tmpRoot('lock-mid')
  const args = buildArgs(root)
  let seen = null
  const sim = makeSim(root, args, { exec: name => { if (name === 'worktree.mjs') seen = owner(root); return undefined } })
  await drive(args, sim.runtime)
  assert.ok(seen && seen.pid === process.pid && seen.host === hostname(), JSON.stringify(seen))
  assert.equal(owner(root), null, 'released at the end')
})

test('the CLI refuses a locked ticket with exit 4, kind locked, and writes no driver result', async () => {
  const root = tmpRoot('lock-cli')
  const args = buildArgs(root)
  const file = join(root, 'args-ABC-1.json')
  writeFileSync(file, JSON.stringify(args))
  const holder = await liveHolder(root)
  try {
    const r = spawnSync(process.execPath, [DRIVE, '--args', file], { encoding: 'utf8' })
    assert.equal(r.status, 4, r.stdout + r.stderr)
    const line = JSON.parse(r.stdout.trim())
    assert.equal(line.status, 'refused')
    assert.equal(line.kind, 'locked')
    assert.equal(line.runStatus, 'running')
    assert.match(line.reason, new RegExp(`pid ${holder.pid}`))
    assert.ok(!existsSync(join(root, 'tickets', 'ABC-1', 'driver-result.json')), 'no driver result for a run that never ran')
    assert.equal(owner(root).pid, holder.pid)
  } finally { holder.kill('SIGKILL') }
  assert.ok(readFileSync(join(HERE, '..', '..', 'contract', 'kinds.json'), 'utf8').includes('"locked"'), 'locked is a contract kind')
})
