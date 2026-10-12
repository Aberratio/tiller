import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'leak-guard.sh')

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'leak-guard-'))
  mkdirSync(join(root, 'lib'))
  copyFileSync(GUARD, join(root, 'lib', 'leak-guard.sh'))
  spawnSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), body)
  }
  spawnSync('git', ['add', '-A'], { cwd: root })
  return root
}

const run = (root, ...args) => spawnSync('bash', [join(root, 'lib', 'leak-guard.sh'), ...args], { cwd: root, encoding: 'utf8' })

test('a private agent record path is a leak, in every home spelling', () => {
  // Assembled at run time so this file does not trip the guard it tests.
  const paths = [['~', 'plans/x.md'], ['$HOME', 'memory/a.md'], ['/Users/someone', 'qa-evidence/a.png'], ['~', 'foo-reflections/b.md']]
  for (const p of paths.map(([home, rest]) => `${home}/.claude/${rest}`)) {
    const r = run(repo({ 'docs/a.md': `see ${p}\n` }), '--staged')
    assert.equal(r.status, 1, p)
    assert.match(r.stdout, /leak: docs\/a\.md:1:/)
  }
})

test('shared harness paths under ~/.claude stay allowed', () => {
  const r = run(repo({ 'docs/a.md': 'install into ~/.claude/skills/ and ~/.claude/agents/\n' }), '--staged')
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('a credential shape is still a leak', () => {
  const r = run(repo({ 'a.txt': 'token ghp_' + 'a'.repeat(30) + '\n' }), '--staged')
  assert.equal(r.status, 1)
})
