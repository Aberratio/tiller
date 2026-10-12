// Shared test helpers for lib/git scripts. Hermetic: everything runs against a fixture repo
// under a temp dir; nothing touches a real remote.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const GIT_DIR = join(HERE, '..')

export function mkdtemp(prefix = 'git-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// main: base.txt. One commit ahead on a merged-and-deletable branch, one on a branch still
// ahead of main, one worktree left dirty.
export function makeFixtureRepo(dir) {
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@test.invalid'])
  git(dir, ['config', 'user.name', 'test'])
  mkdirSync(join(dir, 'client-new'), { recursive: true })
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return { rev: (ref) => git(dir, ['rev-parse', ref]).trim() }
}

let pass = 0
const failures = []

export function assertEq(expected, actual, label) {
  const e = JSON.stringify(expected), a = JSON.stringify(actual)
  if (e === a) { pass++; return }
  failures.push(`${label}\n  expected: ${e}\n  actual:   ${a}`)
}

export function assertTrue(cond, label) {
  if (cond) { pass++; return }
  failures.push(label)
}

export function report() {
  for (const f of failures) console.log(`FAIL: ${f}`)
  console.log(`passed: ${pass}, failed: ${failures.length}`)
  if (failures.length) process.exit(1)
}

export function runScript(scriptName, args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [join(GIT_DIR, scriptName), ...args], { encoding: 'utf8', cwd })
  let json = null
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* left null */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
}
