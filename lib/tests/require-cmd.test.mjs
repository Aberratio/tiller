import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const LIB = fileURLToPath(new URL('..', import.meta.url))

// The caller's PATH with jq taken out: every other executable is linked into one directory.
function pathWithout(cmd) {
  const bin = join(realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'nojq-'))), 'bin')
  mkdirSync(bin)
  for (const dir of process.env.PATH.split(':')) {
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (n === cmd) continue
      try { symlinkSync(join(dir, n), join(bin, n)) } catch {}
    }
  }
  return bin
}

test('a script that needs jq names it and exits 1 when it is missing', () => {
  const r = spawnSync('bash', [join(LIB, 'profile-facts.sh'), '--profile', '/nonexistent'], { encoding: 'utf8', env: { ...process.env, PATH: pathWithout('jq') } })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /profile-facts\.sh: 'jq' not found on PATH/)
  assert.equal(r.stdout, '')
})

test('private-access without jq still denies a protected path and allows the rest', () => {
  const { home, cwd } = makeHome()
  const PATH = pathWithout('jq')
  const call = file_path => spawnSync('bash', [join(LIB, 'hooks', 'private-access.sh')], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path }, cwd: cwd.beta }),
    env: cleanEnv({ TILLER_HOME: home, PATH }),
  })
  const r = call(join(home, 'brains', 'main', 'note.md'))
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.match(r.stderr, /'jq' not found/)
  const ok = call(join(cwd.beta, 'README.md'))
  assert.equal(ok.stdout, '')
})
