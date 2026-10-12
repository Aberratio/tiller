import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyResult } from '../classify-failure.mjs'
import { check } from '../../contract/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const KNOWN_KINDS = ['usage-limit', 'rate-limit', 'harness-blocked', 'ci-infra']

test('corpus: every real-shaped snippet classifies as its own folder, never another known kind', () => {
  let total = 0
  for (const kind of KNOWN_KINDS) {
    const dir = join(FIXTURES, kind)
    const files = readdirSync(dir)
    assert.ok(files.length >= 10, `${kind}: expected at least 10 fixtures, found ${files.length}`)
    for (const f of files) {
      total++
      const text = readFileSync(join(dir, f), 'utf8')
      const result = classifyResult(text, undefined)
      assert.equal(result.kind, kind, `${kind}/${f} classified as ${result.kind}: ${text}`)
      assert.equal(result.matched, true)
    }
  }
  assert.ok(total >= 40, `expected at least 40 snippets across known kinds, got ${total}`)
})

test('unclassified fixtures never get labelled with a known failure kind', () => {
  const dir = join(FIXTURES, 'unclassified')
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8')
    const result = classifyResult(text, undefined)
    assert.equal(result.kind, undefined, `unclassified/${f} wrongly classified as ${result.kind}: ${text}`)
    assert.equal(result.status, 'ok')
  }
})

test('exit code 0 is never classified as a failure, regardless of text', () => {
  const result = classifyResult('rate limit exceeded, retrying anyway', 0)
  assert.equal(result.status, 'ok')
  assert.equal(result.matched, false)
})

test('every classified result validates against schemas/script-result.json with a matching exit code', () => {
  const kindsJson = JSON.parse(readFileSync(join(HERE, '..', '..', 'contract', 'kinds.json'), 'utf8'))
  for (const kind of KNOWN_KINDS) {
    const dir = join(FIXTURES, kind)
    const [first] = readdirSync(dir)
    const text = readFileSync(join(dir, first), 'utf8')
    const result = classifyResult(text, undefined)
    const exit = kindsJson.kinds[kind].exit
    const errs = check('script-result', result, exit)
    assert.deepEqual(errs, [], `${kind}: ${errs.join('; ')}`)
  }
  const unclassified = classifyResult('some ordinary stack trace', undefined)
  assert.deepEqual(check('script-result', unclassified, 0), [])
})

test('usage-limit extracts a retryAfter when a reset time is present in the text', () => {
  const text = readFileSync(join(FIXTURES, 'usage-limit', '01.txt'), 'utf8')
  const result = classifyResult(text, undefined)
  assert.match(result.retryAfter, /^\d{4}-\d{2}-\d{2}T15:40:00Z$/)
})
