import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const TILLER = join(REPO, 'bin', 'tiller.mjs')

// A synthetic machine: its own HOME, state dir and PATH of stub tools. Nothing points at the real home.
function machine({ tools = { jq: 'jq-1.7.1', gh: 'gh version 2.62.0' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tiller-cli-'))
  const home = join(root, 'home'), state = join(root, 'state'), bin = join(root, 'bin')
  for (const d of [home, bin]) mkdirSync(d, { recursive: true })
  for (const [name, out] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho '${out}'\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const env = {
    PATH: [bin, dirname(process.execPath), '/bin'].join(':'),
    HOME: home, USERPROFILE: home, TILLER_STATE_HOME: state, TILLER_PERSONAL_ROOT: join(root, 'personal'),
  }
  assert.notEqual(env.HOME, homedir())
  return { root, home, state, env }
}

function tiller(args, m, cmd = [TILLER]) {
  const [exe, ...pre] = cmd.length === 1 ? [process.execPath, ...cmd] : cmd
  return spawnSync(exe, [...pre, ...args], { encoding: 'utf8', env: m.env, cwd: m.root })
}

const tree = dir => { try { return readdirSync(dir, { recursive: true }).sort() } catch { return null } }

test('doctor lists every feature in table order and writes nothing', () => {
  const m = machine()
  const before = [tree(m.home), tree(m.state)]
  const r = tiller(['doctor'], m)
  assert.equal(r.status, 0, r.stderr)
  const labels = r.stdout.trim().split('\n').map(l => l.replace(/^(ready|degraded|unavailable)\s+/, '').split(' - ')[0])
  assert.deepEqual(labels, ['Skills', 'Harness role agents', 'Private-access hook', 'Profile resolution in skills', 'Unattended runs', 'Pull requests'])
  assert.deepEqual([tree(m.home), tree(m.state)], before)
})

test('doctor names a missing tool with its install command', () => {
  const m = machine({ tools: { gh: 'gh version 2.62.0' } })
  const r = tiller(['doctor'], m)
  assert.equal(r.status, 0, r.stderr)
  const line = r.stdout.split('\n').find(l => l.includes('Private-access hook'))
  assert.match(line, /^unavailable/)
  assert.match(line, /needs jq/)
  assert.match(line, process.platform === 'darwin' ? /brew install jq/ : /apt install jq/)
})

test('doctor --json carries the probe and the features', () => {
  const m = machine()
  const r = tiller(['doctor', '--json'], m)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.probe.platform, process.platform)
  assert.equal(out.probe.tools.jq.version, '1.7.1')
  assert.equal(out.features.length, 6)
})

test('an unknown command exits 2 with usage', () => {
  const r = tiller(['frobnicate'], machine())
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage: tiller/i)
})

test('commands of later delivery steps say they are not available yet', () => {
  for (const cmd of ['onboard', 'status', 'uninstall']) {
    const r = tiller([cmd], machine())
    assert.equal(r.status, 2, cmd)
    assert.match(r.stderr, /not available yet/)
  }
})

test('the POSIX shim works through a symlink on PATH', () => {
  const m = machine()
  const link = join(m.root, 'bin', 'tiller')
  symlinkSync(join(REPO, 'bin', 'tiller'), link)
  const env = { ...m.env, PATH: `${m.env.PATH}:/usr/bin` }
  const r = spawnSync('sh', ['-c', 'tiller doctor'], { encoding: 'utf8', env, cwd: m.root })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Skills/)
})
