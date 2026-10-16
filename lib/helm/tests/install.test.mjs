import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const INSTALL = fileURLToPath(new URL('../../../install.sh', import.meta.url))

test('--hooks prints only the helm session hook; the private-access hook is a tiller apply item', () => {
  const r = spawnSync('bash', [INSTALL, '--hooks'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const { hooks } = JSON.parse(r.stdout)
  assert.equal(hooks.PreToolUse, undefined)
  assert.match(hooks.SessionStart[0].hooks[0].command, /helm-session\.sh$/)
})

test('--helm without a url is a usage error', () => {
  const r = spawnSync('bash', [INSTALL, '--helm'], { encoding: 'utf8', env: { ...process.env, TILLER_HELM_DIR: '/nonexistent/helm-test' } })
  assert.equal(r.status, 2)
})
