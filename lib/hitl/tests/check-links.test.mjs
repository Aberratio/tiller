// L13 is the only network rule, so it is kept out of lint(): a dead link blocks, a forge that cannot answer only warns.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLinks } from '../check-links.mjs'

const request = { links: [{ text: 'Pull request 251', url: 'https://github.com/o/r/pull/251' }], run: { ticket: 'X-1', runUrl: 'https://example.com/run', prUrl: 'https://github.com/o/r/pull/251' } }
const answering = byUrl => async url => {
  const a = byUrl[url]
  if (a instanceof Error) throw a
  return { status: a ?? 200 }
}

test('every distinct URL is checked once and 2xx/3xx pass', async () => {
  const seen = []
  const r = await checkLinks(request, { fetch: async u => { seen.push(u); return { status: 301 } } })
  assert.deepEqual(r, { ok: true, violations: [], warnings: [] })
  assert.deepEqual(seen.sort(), ['https://example.com/run', 'https://github.com/o/r/pull/251'])
})

test('a 404 blocks with L13', async () => {
  const r = await checkLinks(request, { fetch: answering({ 'https://github.com/o/r/pull/251': 404 }) })
  assert.equal(r.ok, false)
  assert.equal(r.violations[0].rule, 'L13')
  assert.match(r.violations[0].text, /404/)
})

test('offline, timeout and rate limits only warn', async () => {
  for (const answer of [new Error('getaddrinfo ENOTFOUND'), 429, 403, 503]) {
    const r = await checkLinks(request, { fetch: answering({ 'https://github.com/o/r/pull/251': answer }) })
    assert.equal(r.ok, true, String(answer))
    assert.equal(r.violations.length, 0)
    assert.equal(r.warnings[0].rule, 'L13')
  }
})

test('a slow forge is cut at the timeout and warns', async () => {
  const r = await checkLinks(request, { timeoutMs: 20, fetch: (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) })
  assert.equal(r.ok, true)
  assert.equal(r.warnings.length, 2)
})
