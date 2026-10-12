// Shared test helpers for lib/forge scripts. Hermetic: every test stubs `gh` (and `git` where
// needed) on PATH inside its own temp bin dir; nothing here reaches the network.
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const FORGE_DIR = join(HERE, '..')

export function mkdtemp(prefix = 'forge-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

// Writes an executable stub on PATH ahead of the real binary. `script` is the body of a bash
// script; argv/stdin inspection happens there so each test can shape gh's answer precisely.
export function writeStub(binDir, name, script) {
  mkdirSync(binDir, { recursive: true })
  const path = join(binDir, name)
  writeFileSync(path, `#!/usr/bin/env bash\nset -e\n${script}\n`)
  chmodSync(path, 0o755)
  return path
}

export function runScript(scriptName, args, { binDir, cwd } = {}) {
  const env = { ...process.env }
  if (binDir) env.PATH = `${binDir}:${env.PATH}`
  const r = spawnSync(process.execPath, [join(FORGE_DIR, scriptName), ...args], { encoding: 'utf8', cwd, env })
  let json = null
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* left null for tests that check raw stdout */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json }
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
