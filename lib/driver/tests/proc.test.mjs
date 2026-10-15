import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from '../proc.mjs'

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const waitFor = async (pred, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 25)) }
  return pred()
}

for (const withOnLine of [false, true]) {
  test(`a wall-clock timeout kills the grandchild too (onLine ${withOnLine ? 'set' : 'unset'})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proc-'))
    const pidFile = join(dir, 'grandchild.pid')
    const script = `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; wait`
    const res = await exec(['sh', '-c', script], { timeoutMs: 400, ...(withOnLine ? { onLine: () => null } : {}) })
    assert.equal(res.timedOut, true)
    assert.ok(res.durationMs < 5000, 'exec returned promptly')
    assert.ok(existsSync(pidFile), 'grandchild started')
    const gpid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(await waitFor(() => !alive(gpid)), `grandchild ${gpid} survived the timeout`)
  })
}

test('killLive takes down the process group of every child still running', async () => {
  const { killLive } = await import('../proc.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'proc-live-'))
  const pidFile = join(dir, 'grandchild.pid')
  const running = exec(['sh', '-c', `sleep 30 </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; wait`])
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()), 'grandchild started')
  const gpid = Number(readFileSync(pidFile, 'utf8').trim())
  killLive('SIGTERM')
  const res = await running
  assert.notEqual(res.exitCode, 0)
  assert.ok(await waitFor(() => !alive(gpid)), `grandchild ${gpid} survived`)
})
