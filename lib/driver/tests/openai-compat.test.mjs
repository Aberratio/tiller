import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import oc from '../adapters/openai-compat.mjs'
import { adapter } from '../adapters/index.mjs'

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }
let TMP, CWD, OUTSIDE

before(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-oc-')))
  CWD = join(TMP, 'repo')
  mkdirSync(join(CWD, 'src'), { recursive: true })
  writeFileSync(join(CWD, 'src', 'a.txt'), 'alpha\nneedle here\n')
  OUTSIDE = join(TMP, 'secret.txt')
  writeFileSync(OUTSIDE, 'top secret')
})
after(() => rmSync(TMP, { recursive: true, force: true }))

// A scripted /v1/chat/completions: each step sees the parsed request body and returns { status, body } or a delay.
async function fakeServer(steps) {
  const requests = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', d => { data += d })
    req.on('end', async () => {
      const body = JSON.parse(data || '{}')
      requests.push({ url: req.url, auth: req.headers.authorization, body })
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]
      const out = await step(body, requests.length)
      if (out.hang) return
      res.writeHead(out.status || 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/v1`
  return { url, requests, close: () => new Promise(r => { server.closeAllConnections(); server.close(r) }) }
}

const usage = (p, c, cached = 0) => ({ prompt_tokens: p, completion_tokens: c, prompt_tokens_details: { cached_tokens: cached } })
const say = (content, u = usage(10, 5)) => () => ({ body: { model: 'served-model', choices: [{ message: { role: 'assistant', content } }], usage: u } })
const call = (name, args, id = 'c1') => () => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: usage(10, 5) } })
const toolResult = (body, id = 'c1') => (body.messages.find(m => m.role === 'tool' && m.tool_call_id === id) || {}).content
const req = (srv, extra = {}) => ({ prompt: 'judge it', schema: SCHEMA, model: 'local-model', budgetUsd: 1, cwd: CWD, env: { OPENAI_COMPAT_BASE_URL: srv.url, OPENAI_COMPAT_API_KEY: 'k-test' }, ...extra })

test('registered as a runtime; no dispatch, no MCP, denials recorded', () => {
  assert.equal(adapter('openai-compat'), oc)
  assert.equal(oc.capabilities.subagents, false)
  assert.equal(oc.capabilities.mcp, false)
  assert.equal(oc.capabilities.denials, true)
})

test('a tool loop: read_file inside cwd, then a valid answer in one pass; usage summed and computed at price zero', async () => {
  const srv = await fakeServer([call('read_file', { path: 'src/a.txt' }), say('{"verdict":"pass"}', usage(100, 20, 40))])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok', r.message)
    assert.deepEqual(r.structured, { verdict: 'pass' })
    assert.equal(srv.requests.length, 2)
    assert.equal(srv.requests[0].url, '/v1/chat/completions')
    assert.equal(srv.requests[0].auth, 'Bearer k-test')
    assert.equal(srv.requests[0].body.model, 'local-model')
    assert.match(toolResult(srv.requests[1].body), /needle here/)
    assert.deepEqual(r.usage, { in: 70, out: 25, cacheRead: 40, cacheCreate: 0, costUsd: 0, costSource: 'computed' })
    assert.equal(r.model, 'served-model')
    assert.deepEqual(r.denials, [])
    assert.ok(!srv.requests[0].body.tools.some(t => /agent|task|dispatch/i.test(t.function.name)))
  } finally { await srv.close() }
})

test('a path outside cwd is refused, recorded as a denial, and the model is told; the loop goes on', async () => {
  const srv = await fakeServer([call('read_file', { path: OUTSIDE }), call('read_file', { path: '../secret.txt' }, 'c2'), say('{"verdict":"fail"}')])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok')
    assert.equal(r.denials.length, 2)
    assert.equal(r.denials[0].tool, 'read_file')
    assert.equal(r.denials[0].text, `Permission denied: read_file(${OUTSIDE})`)
    assert.match(toolResult(srv.requests[1].body), /denied/i)
    assert.doesNotMatch(toolResult(srv.requests[1].body), /top secret/)
    assert.doesNotMatch(toolResult(srv.requests[2].body, 'c2'), /top secret/)
  } finally { await srv.close() }
})

test('shell runs only allowlisted commands, without a shell, inside cwd', async () => {
  const srv = await fakeServer([
    call('shell', { argv: ['ls', 'src'] }),
    call('shell', { argv: ['git', 'push', 'origin', 'HEAD'] }, 'c2'),
    call('shell', { argv: ['rm', '-rf', '.'] }, 'c3'),
    call('shell', { argv: ['cat', OUTSIDE] }, 'c4'),
    call('shell', { argv: ['ls', 'src;', 'rm', 'x'] }, 'c5'),
    call('shell', { argv: ['git', 'diff', '--output=x.patch'] }, 'c6'),
    say('{"verdict":"pass"}'),
  ])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok')
    assert.match(toolResult(srv.requests[1].body), /a\.txt/)
    assert.deepEqual(r.denials.map(d => d.text), [
      'Permission denied: shell(git push origin HEAD)',
      'Permission denied: shell(rm -rf .)',
      `Permission denied: shell(cat ${OUTSIDE})`,
      'Permission denied: shell(git diff --output=x.patch)',
    ])
    assert.doesNotMatch(toolResult(srv.requests[5].body, 'c5'), /denied/i, 'a metacharacter is an argument, not a second command')
  } finally { await srv.close() }
})

test('search finds lines under cwd; list_files lists a directory', async () => {
  const srv = await fakeServer([call('search', { pattern: 'need+le' }), call('list_files', { path: 'src' }, 'c2'), say('{"verdict":"pass"}')])
  try {
    await oc.run(req(srv))
    assert.match(toolResult(srv.requests[1].body), /src\/a\.txt:2: needle here/)
    assert.match(toolResult(srv.requests[2].body, 'c2'), /a\.txt/)
  } finally { await srv.close() }
})

test('a role is honoured: only its tools are offered and a tool outside them is a denial', async () => {
  const srv = await fakeServer([call('shell', { argv: ['ls'] }), say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv, { role: { name: 'r', systemPrompt: 'You are r.', tools: ['read'] } }))
    assert.deepEqual(srv.requests[0].body.tools.map(t => t.function.name), ['read_file'])
    assert.deepEqual(srv.requests[0].body.messages[0], { role: 'system', content: 'You are r.' })
    assert.equal(r.denials[0].text, 'Permission denied: shell(ls)')
  } finally { await srv.close() }
})

test('a role needing MCP or web is refused before any call: this loop has no MCP client and no web tool', async () => {
  const srv = await fakeServer([say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv, { role: { name: 'r', systemPrompt: 's', tools: ['read', 'mcp:atlassian.getJiraIssue'] } }))
    assert.equal(r.exitClass, 'runtime_error')
    assert.match(r.message, /mcp:atlassian\.getJiraIssue/)
    assert.equal(srv.requests.length, 0)
  } finally { await srv.close() }
})

test('an invalid final answer gets one repair turn with response_format json_schema and no tools', async () => {
  const srv = await fakeServer([say('I think it passes'), say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok', r.message)
    assert.equal(srv.requests[0].body.response_format, undefined)
    assert.equal(srv.requests[1].body.response_format.type, 'json_schema')
    assert.deepEqual(srv.requests[1].body.response_format.json_schema.schema, SCHEMA)
    assert.equal(srv.requests[1].body.tools, undefined)
    assert.match(srv.requests[1].body.messages.at(-1).content, /no JSON object/)
    assert.equal(r.usage.in, 20)
  } finally { await srv.close() }
})

test('a server that rejects response_format falls back to the plain repair (F), and a second failure is schema', async () => {
  const reject = () => ({ status: 400, body: { error: { message: 'response_format json_schema is not supported' } } })
  const srv = await fakeServer([say('nope'), reject, say('still nope')])
  try {
    const r = await oc.run(req(srv))
    assert.equal(srv.requests.length, 3)
    assert.equal(srv.requests[2].body.response_format, undefined)
    assert.equal(r.exitClass, 'schema')
    assert.equal(r.structured, null)
  } finally { await srv.close() }
})

test('OPENAI_COMPAT_RESPONSE_FORMAT=off never sends response_format', async () => {
  const srv = await fakeServer([say('x'), say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv, { env: { OPENAI_COMPAT_BASE_URL: srv.url, OPENAI_COMPAT_RESPONSE_FORMAT: 'off' } }))
    assert.equal(r.exitClass, 'ok')
    assert.ok(srv.requests.every(q => q.body.response_format === undefined))
    assert.equal(srv.requests[0].auth, undefined)
  } finally { await srv.close() }
})

test('caps: turns, tokens at price zero, and wall clock each stop the loop with their class', async () => {
  const loop = await fakeServer([call('list_files', { path: '.' })])
  try {
    const r = await oc.run(req(loop, { maxTurns: 2 }))
    assert.equal(r.exitClass, 'turns')
    assert.equal(loop.requests.length, 2)
  } finally { await loop.close() }

  const big = await fakeServer([say('{"verdict":"pass"}', usage(3_000_000, 1))])
  try {
    const r = await oc.run(req(big))
    assert.equal(r.exitClass, 'budget')
    assert.match(r.message, /tokens/)
  } finally { await big.close() }

  const slow = await fakeServer([() => ({ hang: true })])
  try {
    const started = Date.now()
    const r = await oc.run(req(slow, { timeoutMs: 300 }))
    assert.equal(r.exitClass, 'timeout')
    assert.ok(Date.now() - started < 3000)
  } finally { await slow.close() }
})

test('HTTP failures are classed: 401 auth, 429 rate_limit, 500 runtime_error; no endpoint is runtime_error without a call', async () => {
  for (const [status, cls] of [[401, 'auth'], [429, 'rate_limit'], [500, 'runtime_error']]) {
    const srv = await fakeServer([() => ({ status, body: { error: { message: `status ${status}` } } })])
    try {
      const r = await oc.run(req(srv))
      assert.equal(r.exitClass, cls, String(status))
      assert.match(r.message, new RegExp(String(status)))
    } finally { await srv.close() }
  }
  const r = await oc.run({ prompt: 'p', schema: SCHEMA, model: 'm', budgetUsd: 1, cwd: CWD, env: { OPENAI_COMPAT_BASE_URL: '' } })
  assert.equal(r.exitClass, 'runtime_error')
  assert.match(r.message, /OPENAI_COMPAT_BASE_URL/)
})

test('a symlink inside cwd that points outside it is refused as a shell argument, bare or as a flag value', async () => {
  symlinkSync(OUTSIDE, join(CWD, 'link.txt'))
  const srv = await fakeServer([call('shell', { argv: ['cat', 'link.txt'] }), call('shell', { argv: ['grep', '-r', 'secret', 'link.txt'] }, 'c2'), call('shell', { argv: ['git', 'diff', '--no-index', '--src-prefix=a/', 'src/a.txt', 'link.txt'] }, 'c3'), say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok')
    assert.equal(r.denials.length, 3, JSON.stringify(r.denials))
    for (const [i, id] of [[1, 'c1'], [2, 'c2'], [3, 'c3']]) assert.doesNotMatch(toolResult(srv.requests[i].body, id), /top secret/)
  } finally { rmSync(join(CWD, 'link.txt')); await srv.close() }
})

test('a backtracking search pattern returns within the timeout, and an over-long pattern is refused', async () => {
  writeFileSync(join(CWD, 'src', 'redos.txt'), 'a'.repeat(28) + '!\n')
  const srv = await fakeServer([call('search', { pattern: '(a+)+$', path: 'src' }), call('search', { pattern: 'a'.repeat(5000) }, 'c2'), say('{"verdict":"pass"}')])
  try {
    const started = Date.now()
    const r = await oc.run(req(srv))
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`)
    assert.equal(r.exitClass, 'ok')
    assert.doesNotMatch(toolResult(srv.requests[1].body), /redos\.txt|timed out/)
    assert.equal(r.denials.length, 1, JSON.stringify(r.denials))
  } finally { rmSync(join(CWD, 'src', 'redos.txt')); await srv.close() }
})

test('a response without usage is estimated from characters, marked estimated, and still counted against the caps', async () => {
  const srv = await fakeServer([() => ({ body: { choices: [{ message: { role: 'assistant', content: '{"verdict":"pass"}' } }] } })])
  try {
    const r = await oc.run(req(srv))
    assert.equal(r.exitClass, 'ok')
    assert.equal(r.usage.costSource, 'estimated')
    assert.equal(r.usage.in, Math.ceil(JSON.stringify(srv.requests[0].body).length / 4))
    assert.equal(r.usage.out, Math.ceil('{"verdict":"pass"}'.length / 4))
  } finally { await srv.close() }
})

test('a non-numeric budget is refused before any call', async () => {
  const srv = await fakeServer([say('{"verdict":"pass"}')])
  try {
    const r = await oc.run(req(srv, { budgetUsd: 'lots' }))
    assert.equal(r.exitClass, 'runtime_error')
    assert.match(r.message, /budgetUsd/)
    assert.equal(srv.requests.length, 0)
  } finally { await srv.close() }
})
