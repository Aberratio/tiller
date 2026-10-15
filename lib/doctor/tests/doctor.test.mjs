import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atLeast, checkNode, jqUsers, NODE_FLOOR, which } from '../doctor.mjs'

const CORE = fileURLToPath(new URL('../../..', import.meta.url))
const DOCTOR = join(CORE, 'bin', 'doctor')

const COREUTILS = ['dirname', 'basename', 'grep', 'awk', 'sed', 'sort', 'head', 'tr', 'paste']

// A PATH holding only the named tools: real node and bash, fakes for the rest.
function sandbox(tools) {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'doctor-')))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const t of tools) {
    if (t === 'node') symlinkSync(process.execPath, join(bin, 'node'))
    else if (t === 'bash') symlinkSync('/bin/bash', join(bin, 'bash'))
    else { writeFileSync(join(bin, t), '#!/bin/sh\nexit 1\n'); chmodSync(join(bin, t), 0o755) }
  }
  // The text tools resolve-profile.sh needs, none of them a checked requirement.
  for (const u of COREUTILS) symlinkSync(which(u, { PATH: '/usr/bin:/bin' }), join(bin, u))
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'profiles'))
  mkdirSync(join(root, 'work'))
  return root
}

function run(root, args = [], extra = {}) {
  const env = { PATH: join(root, 'bin'), HOME: join(root, 'home'), TILLER_PROFILES_DIR: join(root, 'profiles'), TILLER_HOME: CORE, ...extra }
  return spawnSync('/bin/bash', [DOCTOR, '--dir', join(root, 'work'), ...args], { encoding: 'utf8', env })
}

const ALL = ['node', 'bash', 'git', 'jq', 'gh', 'claude', 'codex', 'caffeinate']

test('every requirement present: exit 0, one line per check', () => {
  const r = run(sandbox(ALL))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  for (const name of ['node', 'git', 'bash', 'jq', 'gh', 'claude', 'codex', 'keep-awake', 'TILLER_HOME', 'profile', 'agents']) {
    assert.match(r.stdout, new RegExp(`^(ok|warn|fail)\\s+${name}\\s`, 'm'), name)
  }
})

test('a missing required tool exits 1 and jq names the files that need it', () => {
  const r = run(sandbox(ALL.filter(t => t !== 'jq')), ['--json'])
  assert.equal(r.status, 1)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  const jq = out.checks.find(c => c.name === 'jq')
  assert.equal(jq.status, 'fail')
  assert.ok(jq.neededBy.includes('lib/profile-facts.sh'), jq.neededBy.join(','))
})

test('missing optional tools only warn', () => {
  const r = run(sandbox(['node', 'bash', 'git', 'jq']), ['--json'])
  assert.equal(r.status, 0, r.stdout)
  const by = Object.fromEntries(JSON.parse(r.stdout).checks.map(c => [c.name, c]))
  for (const n of ['gh', 'claude', 'codex', 'keep-awake', 'agents', 'profile']) assert.equal(by[n].status, 'warn', n)
  assert.match(by.claude.detail, /dry-run only/)
})

test('TILLER_HOME unset or not a checkout fails', () => {
  const root = sandbox(ALL)
  assert.equal(run(root, [], { TILLER_HOME: '' }).status, 1)
  const r = run(root, ['--json'], { TILLER_HOME: root })
  assert.equal(r.status, 1)
  assert.match(JSON.parse(r.stdout).checks.find(c => c.name === 'TILLER_HOME').detail, /not a tiller checkout/)
})

test('a resolving profile is ok', () => {
  const root = sandbox(ALL)
  mkdirSync(join(root, 'profiles', 'demo'))
  writeFileSync(join(root, 'profiles', 'demo', 'profile.md'), '---\nprofile: demo\n---\n')
  const r = run(root, ['--json'], { TILLER_PROFILE: 'demo' })
  assert.equal(JSON.parse(r.stdout).checks.find(c => c.name === 'profile').status, 'ok')
})

test('without node on PATH the bash wrapper still gives a verdict', () => {
  const r = run(sandbox(['bash', 'git', 'jq']), ['--json'])
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).checks[0].name, 'node')
})

test('node floor', () => {
  assert.equal(NODE_FLOOR, '20.11.0')
  assert.equal(checkNode('v20.11.0').status, 'ok')
  assert.equal(checkNode('v20.10.9').status, 'fail')
  assert.equal(atLeast('v22.0.0', '20.11.0'), true)
  assert.equal(atLeast('v18.19.1', '20.11.0'), false)
})

test('jq users are found by scanning, comments ignored', () => {
  const users = jqUsers(CORE)
  assert.ok(users.length >= 5, users.join(','))
  assert.ok(!users.includes('lib/resolve-profile.sh'))
})
