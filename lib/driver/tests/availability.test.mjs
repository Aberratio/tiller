import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapter, adapterNames, runtimeAvailability } from '../adapters/index.mjs'

const BIN = mkdtempSync(join(tmpdir(), 'avail-'))
after(() => rmSync(BIN, { recursive: true, force: true }))
const fake = name => { const p = join(BIN, name); writeFileSync(p, '#!/bin/sh\nexit 0\n'); chmodSync(p, 0o755) }

test('every adapter declares its own available(env)', () => {
  for (const n of adapterNames()) assert.equal(typeof adapter(n).available, 'function', n)
})

test('availability keeps its shape: one { available } per runtime, from binaries on PATH and configured endpoints', () => {
  const none = runtimeAvailability({ PATH: BIN })
  assert.deepEqual(none, Object.fromEntries(adapterNames().map(n => [n, { available: false }])))
  fake('claude')
  const some = runtimeAvailability({ PATH: BIN, OPENAI_COMPAT_BASE_URL: 'http://localhost:1/v1' })
  assert.equal(some.claude.available, true)
  assert.equal(some.codex.available, false)
  assert.equal(some['openai-compat'].available, true)
})

test('an adapter without available(), or one answering anything but true, is unavailable', () => {
  const r = runtimeAvailability({ PATH: BIN }, { silent: {}, vague: { available: () => 'yes' }, up: { available: () => true } })
  assert.deepEqual(r, { silent: { available: false }, vague: { available: false }, up: { available: true } })
})
