import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../resolve-profile.sh', import.meta.url))

const BASE = `---
profile: demo
schema_version: 2
---

# Profile — Demo

## environments

- staging: \`https://staging.example\`

## inviolables

- never push to main

## commits

none
`

function layout(overlays = {}) {
  const root = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'resolve-')))
  mkdirSync(join(root, 'lib'))
  copyFileSync(SCRIPT, join(root, 'lib', 'resolve-profile.sh'))
  mkdirSync(join(root, 'profiles', 'demo', 'overlays'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'demo', 'profile.md'), BASE)
  for (const [name, body] of Object.entries(overlays)) writeFileSync(join(root, 'profiles', 'demo', 'overlays', `${name}.md`), body)
  return root
}

function resolve(root, overlay) {
  const env = { ...process.env, TILLER_PROFILE: 'demo' }
  if (overlay === undefined) delete env.TILLER_OVERLAY
  else env.TILLER_OVERLAY = overlay
  return spawnSync('bash', [join(root, 'lib', 'resolve-profile.sh'), root], { encoding: 'utf8', env })
}

test('without an overlay the profile itself is printed', () => {
  const root = layout()
  const r = resolve(root)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), join(root, 'profiles', 'demo', 'profile.md'))
})

test('an overlay section replaces the profile section whole; a new one is appended; front matter stays', () => {
  const root = layout({ ci: '# CI overlay\n\n## environments\n\n- ci: `http://localhost`\n\n## known issues\n\n- flaky e2e\n' })
  const r = resolve(root, 'ci')
  assert.equal(r.status, 0, r.stderr)
  const merged = readFileSync(r.stdout.trim(), 'utf8')
  assert.match(merged, /^---\nprofile: demo\nschema_version: 2\n---/)
  assert.match(merged, /- ci: `http:\/\/localhost`/)
  assert.doesNotMatch(merged, /staging\.example/)
  assert.doesNotMatch(merged, /CI overlay/)
  assert.match(merged, /## inviolables\n\n- never push to main/)
  assert.ok(merged.indexOf('## known issues') > merged.indexOf('## commits'))
})

test('an overlay that sets merge authority, inviolables or owner proxy is refused', () => {
  for (const h of ['merge authority', 'inviolables', 'owner proxy']) {
    const r = resolve(layout({ ci: `## ${h}\n\nnone\n` }), 'ci')
    assert.equal(r.status, 3, h)
    assert.match(r.stderr, new RegExp(`may not set: ${h}`))
  }
})

test('a missing overlay, or a name outside [a-z0-9-], is refused', () => {
  const root = layout()
  assert.equal(resolve(root, 'staging').status, 3)
  assert.equal(resolve(root, '../demo').status, 3)
})
