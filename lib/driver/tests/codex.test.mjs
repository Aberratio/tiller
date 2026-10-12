import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import codex, { argv as codexArgv } from '../adapters/codex.mjs'
import { adapter } from '../adapters/index.mjs'

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }
const PRICES = { models: { 'codex/gpt-test': { in: 1, out: 4, cacheRead: 0.25, cacheCreate: 0 } }, limits: { maxTokens: 1_000_000, maxTurns: 60, wallClockMs: 60000 } }
let TMP, BIN, CWD, LOG

// Records argv, stdin and the schema file, then behaves per FAKE_CODEX_MODE.
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const at = f => args[args.indexOf(f) + 1]
let stdin = ''
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, stdin, schema: fs.readFileSync(at('--output-schema'), 'utf8') }))
  const out = e => console.log(JSON.stringify(e))
  const usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50 }
  const mode = process.env.FAKE_CODEX_MODE
  out({ type: 'thread.started', thread_id: 't1' })
  out({ type: 'turn.started' })
  if (mode === 'ok' || mode === 'invalid') {
    out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls' } })
    out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } })
    out({ type: 'turn.completed', usage })
    fs.writeFileSync(at('-o'), mode === 'ok' ? '{"verdict":"pass"}' : '{"verdict":"maybe"}')
    process.exit(0)
  }
  if (mode === 'rate') { out({ type: 'turn.failed', error: { message: 'stream error: rate limit reached, retry later' } }); process.exit(1) }
  if (mode === 'auth') { out({ type: 'error', message: '401 Unauthorized: invalid api key' }); process.exit(1) }
  if (mode === 'crash') { process.stderr.write('panic: something broke'); process.exit(2) }
  if (mode === 'dispatch') {
    out({ type: 'item.started', item: { id: 'i9', type: 'collab_agent_spawn' } })
    setInterval(() => {}, 1000)
  }
  if (mode === 'spend') {
    const { spawn } = require('node:child_process')
    const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.FAKE_CODEX_LOG + '.gc', String(gc.pid))
    setInterval(() => out({ type: 'turn.completed', usage: { input_tokens: 500000, cached_input_tokens: 0, output_tokens: 0 } }), 5)
  }
})
`

before(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-codex-')))
  BIN = join(TMP, 'bin')
  CWD = join(TMP, 'repo')
  mkdirSync(BIN); mkdirSync(CWD)
  writeFileSync(join(BIN, 'codex'), FAKE)
  chmodSync(join(BIN, 'codex'), 0o755)
  LOG = join(TMP, 'log.json')
})
after(() => rmSync(TMP, { recursive: true, force: true }))

const req = (mode, extra = {}) => ({
  prompt: 'judge it', schema: SCHEMA, model: 'gpt-test', budgetUsd: 1, cwd: CWD, prices: PRICES,
  env: { PATH: `${BIN}:${process.env.PATH}`, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: LOG }, ...extra,
})
const logged = () => JSON.parse(readFileSync(LOG, 'utf8'))

test('registered as a runtime; skills and AGENTS.md native, no MCP, no recorded denials', () => {
  assert.equal(adapter('codex'), codex)
  assert.equal(codex.capabilities.instructionFile, 'AGENTS.md')
  assert.equal(codex.capabilities.mcp, false)
  assert.equal(codex.capabilities.denials, false)
})

test('argv: exec --json with the schema as a file, the last message to a file, read-only sandbox by default, prompt on stdin', () => {
  const a = codexArgv({ model: 'gpt-test', cwd: '/w' }, { schemaFile: '/t/s.json', lastFile: '/t/last.txt' })
  assert.deepEqual(a, ['codex', 'exec', '--json', '--output-schema', '/t/s.json', '-o', '/t/last.txt', '-m', 'gpt-test', '--sandbox', 'read-only', '-C', '/w', '-c', 'approval_policy="never"', '-c', 'mcp_servers={}', '-'])
  for (const sandbox of ['workspace-write', 'danger-full-access'])
    assert.throws(() => codexArgv({ model: 'm', cwd: '/w', sandbox }, { schemaFile: 's', lastFile: 'l' }), /sandbox/, sandbox)
})

test('a clean run: the -o file is the result, validated; usage summed from turn.completed and priced', async () => {
  const r = await codex.run(req('ok', { role: { name: 'r', systemPrompt: 'You are r.', tools: ['read', 'shell'] } }))
  assert.equal(r.exitClass, 'ok', r.message)
  assert.deepEqual(r.structured, { verdict: 'pass' })
  const l = logged()
  assert.equal(l.stdin, 'You are r.\n\njudge it')
  assert.deepEqual(JSON.parse(l.schema), SCHEMA)
  assert.deepEqual(r.usage, { in: 600, out: 250, cacheRead: 400, cacheCreate: 0, costUsd: 0.0017, costSource: 'computed' })
  assert.equal(r.model, 'gpt-test')
})

test('an -o result that fails the lane schema is exitClass schema, not ok', async () => {
  const r = await codex.run(req('invalid'))
  assert.equal(r.exitClass, 'schema')
  assert.equal(r.structured, null)
  assert.match(r.message, /not in enum/)
})

test('failure classes: turn.failed rate limit, error event auth, crash runtime_error with stderr', async () => {
  assert.equal((await codex.run(req('rate'))).exitClass, 'rate_limit')
  assert.equal((await codex.run(req('auth'))).exitClass, 'auth')
  const c = await codex.run(req('crash'))
  assert.equal(c.exitClass, 'runtime_error')
  assert.match(c.message, /panic/)
})

test('an item type outside the known set stops the run as tool_denied: dispatch cannot be ruled out', async () => {
  const started = Date.now()
  const r = await codex.run(req('dispatch', { timeoutMs: 20000 }))
  assert.equal(r.exitClass, 'tool_denied')
  assert.match(r.message, /collab_agent_spawn/)
  assert.ok(Date.now() - started < 5000)
})

test('harness-side budget: the turn.completed that crosses the cap kills the codex process group', async () => {
  const started = Date.now()
  const r = await codex.run(req('spend', { budgetUsd: 1, timeoutMs: 20000 }))
  assert.ok(Date.now() - started < 5000)
  assert.equal(r.exitClass, 'budget')
  assert.match(r.message, /budget/)
  const gc = Number(readFileSync(LOG + '.gc', 'utf8'))
  await new Promise(res => setTimeout(res, 200))
  assert.throws(() => process.kill(gc, 0), /ESRCH/)
})

test('refused before spawning: no price for the model, a role needing MCP or web', async () => {
  rmSync(LOG, { force: true })
  const noPrice = await codex.run(req('ok', { model: 'gpt-unpriced' }))
  assert.equal(noPrice.exitClass, 'runtime_error')
  assert.match(noPrice.message, /no price for codex\/gpt-unpriced/)
  const mcp = await codex.run(req('ok', { role: { name: 'r', systemPrompt: 's', tools: ['read', 'mcp:slack.slack_read_thread'] } }))
  assert.equal(mcp.exitClass, 'runtime_error')
  assert.match(mcp.message, /mcp:slack/)
  assert.equal(existsSync(LOG), false, 'codex was spawned')
})

test('codex missing from PATH is runtime_error', async () => {
  const r = await codex.run(req('ok', { env: { PATH: '/nonexistent' } }))
  assert.equal(r.exitClass, 'runtime_error')
})
