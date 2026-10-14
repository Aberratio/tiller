import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { caps } from '../../../skills/flow-run-ticket/bin/harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const kinds = JSON.parse(readFileSync(join(HERE, '..', '..', 'contract', 'kinds.json'), 'utf8'))

test('every fix-round cap in kinds.json carries a max a profile cannot exceed', () => {
  for (const [name, v] of Object.entries(kinds.caps)) {
    if (!['fixRounds', 'ciFix'].includes(name)) continue
    assert.ok(Number.isInteger(v.max) && v.max >= v.default, `${name}: max ${v.max} must be an integer >= default ${v.default}`)
  }
})

test('a run policy raising ciFix past its max is clamped, as fixRounds is', () => {
  const c = caps({ runPolicy: { fixRounds: 99, ciFix: 99 } })
  assert.equal(c.fixRounds, kinds.caps.fixRounds.max)
  assert.equal(c.ciFix, kinds.caps.ciFix.max)
  assert.equal(caps({ runPolicy: { ciFix: 1 } }).ciFix, 1, 'lowering stays as given')
  assert.equal(caps({}).ciFix, kinds.caps.ciFix.default, 'absent keeps the default')
})
