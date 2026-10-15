import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INHIBIT = join(dirname(fileURLToPath(import.meta.url)), '..', 'inhibit.sh')

const until = async (pred, ms = 3000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 25)) }
  return pred()
}

// Stub inhibitors log their arguments; the probe (`... true`) fails when `fail` is set.
function setup({ tools = [], fail = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'inhibit-'))
  const stubs = join(base, 'stubs')
  mkdirSync(stubs)
  const log = join(base, 'calls.log')
  for (const t of tools) {
    writeFileSync(join(stubs, t), `#!/bin/sh\necho "${t} $*" >>${JSON.stringify(log)}\ncase "$*" in *" true") exit ${fail ? 1 : 0};; esac\nexit 0\n`)
    chmodSync(join(stubs, t), 0o755)
  }
  const run = (args, env = {}) => spawnSync('bash', [INHIBIT, ...args], { encoding: 'utf8', env: { ...process.env, INHIBIT_PATH: stubs, TILLER_NO_INHIBIT: '', ...env } })
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  return { run, calls }
}

test('with caffeinate the command is exec-ed under the same pid that caffeinate -w watches', async () => {
  const s = setup({ tools: ['caffeinate', 'systemd-inhibit'] })
  const r = s.run(['sh', '-c', 'echo $$; exit 7'])
  assert.equal(r.status, 7, 'the command exit code comes through')
  const pid = r.stdout.trim()
  assert.ok(await until(() => s.calls().includes(`caffeinate -i -w ${pid}`)), s.calls().join('\n'))
  assert.ok(!s.calls().some(l => l.startsWith('systemd-inhibit')), 'caffeinate wins when both exist')
  assert.equal(r.stderr, '')
})

test('without caffeinate systemd-inhibit holds idle and sleep until the pid ends', async () => {
  const s = setup({ tools: ['systemd-inhibit'] })
  const r = s.run(['sh', '-c', 'echo $$'])
  assert.equal(r.status, 0)
  const pid = r.stdout.trim()
  assert.ok(await until(() => s.calls().some(l => l.startsWith('systemd-inhibit --what=idle:sleep') && l.endsWith(`sh ${pid}`))), s.calls().join('\n'))
})

test('no inhibitor, or one that fails its probe: one warning line, and the command still runs', () => {
  for (const s of [setup(), setup({ tools: ['caffeinate', 'systemd-inhibit'], fail: true })]) {
    const r = s.run(['sh', '-c', 'echo ran; exit 3'])
    assert.equal(r.status, 3)
    assert.equal(r.stdout.trim(), 'ran')
    assert.equal(r.stderr.trim().split('\n').length, 1)
    assert.match(r.stderr, /^inhibit: .*may sleep/)
    assert.ok(!s.calls().some(l => / -w | sh -c /.test(l)), 'no inhibitor was left running')
  }
})

test('TILLER_NO_INHIBIT=1 runs the command untouched', () => {
  const s = setup({ tools: ['caffeinate'] })
  const r = s.run(['sh', '-c', 'echo ran'], { TILLER_NO_INHIBIT: '1' })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.deepEqual(s.calls(), [])
})

test('--pid inhibits for another process and returns at once', async () => {
  const s = setup({ tools: ['caffeinate'] })
  const r = s.run(['--pid', String(process.pid)])
  assert.equal(r.status, 0)
  assert.ok(await until(() => s.calls().includes(`caffeinate -i -w ${process.pid}`)), s.calls().join('\n'))
  assert.equal(s.run(['--pid']).status, 1)
})
