// lib/leak-guard.sh on a throwaway tree: the term list catches a name anywhere except in the two
// files whose names are public on purpose; credential shapes are still checked there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const GUARD = fileURLToPath(new URL('../../leak-guard.sh', import.meta.url))

function tree(files) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'leak-guard-'))
  mkdirSync(join(root, 'lib'))
  copyFileSync(GUARD, join(root, 'lib', 'leak-guard.sh'))
  mkdirSync(join(root, 'profiles', 'x'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'x', 'leak-terms.txt'), 'Example Person\n')
  for (const [f, body] of Object.entries(files)) writeFileSync(join(root, f), body)
  return root
}

const run = root => spawnSync('bash', [join(root, 'lib', 'leak-guard.sh')], { encoding: 'utf8' })

test('a listed term in LICENSE or CODE_OF_CONDUCT.md is not a leak; elsewhere it is', () => {
  const clean = run(tree({ LICENSE: 'Copyright (c) 2026 Example Person\n', 'CODE_OF_CONDUCT.md': 'report to example.person@example.com\n' }))
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  const dirty = run(tree({ LICENSE: 'Copyright (c) 2026 Example Person\n', 'README.md': 'maintained by Example Person\n' }))
  assert.equal(dirty.status, 1)
  assert.match(dirty.stdout, /^leak: README\.md:1:/m)
  assert.doesNotMatch(dirty.stdout, /LICENSE/)
})

test('a credential shape in LICENSE is still a leak', () => {
  const r = run(tree({ LICENSE: 'token ghp_' + 'A'.repeat(24) + '\n' }))
  assert.equal(r.status, 1)
  assert.match(r.stdout, /^leak: LICENSE:1:/m)
})
