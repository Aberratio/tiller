import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adapter, adapterNames } from '../adapters/index.mjs'
import { claudeTools } from '../adapters/claude.mjs'
import { TOOL_KINDS, outwardRoleOps, parseTool, resolveRoleTool, resolveTools, roleBindings } from '../adapters/tools.mjs'
import { lane } from '../runtime.mjs'

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
let TMP, LOG, OUT, ORIGINAL_PATH

const FAKE_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const stdin = readFileSync(0, 'utf8')
writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin }))
process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_OUT, 'utf8'))
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR)
process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0))
`

const MODEL_USAGE = { 'claude-haiku-4-5-20251001': { inputTokens: 9, outputTokens: 106, cacheReadInputTokens: 3, cacheCreationInputTokens: 13602, costUSD: 0.0175415 } }
const SUCCESS = { type: 'result', subtype: 'success', is_error: false, structured_output: { verdict: 'pass' }, total_cost_usd: 0.0175415, modelUsage: MODEL_USAGE, permission_denials: [] }
// permission_denials shape per the Agent SDK result message type: { tool_name, tool_use_id, tool_input }.
const DENIED = { ...SUCCESS, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_01', tool_input: { command: 'git push origin HEAD' } }] }
const BUDGET = { type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($0.05)'], total_cost_usd: 0.052704, modelUsage: MODEL_USAGE }
const TURNS = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached maximum turns (3)'], total_cost_usd: 0.01, modelUsage: MODEL_USAGE }

function canned(stdout, { exit = 0, stderr = '' } = {}) {
  writeFileSync(OUT, typeof stdout === 'string' ? stdout : JSON.stringify(stdout))
  process.env.FAKE_CLAUDE_EXIT = String(exit)
  process.env.FAKE_CLAUDE_STDERR = stderr
}
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'] }
const req = (extra = {}) => ({ prompt: 'judge it', schema: SCHEMA, model: 'opus', budgetUsd: 15, cwd: TMP, ...extra })

before(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-adapters-')))
  mkdirSync(join(TMP, 'bin'))
  writeFileSync(join(TMP, 'bin', 'claude'), FAKE_CLAUDE)
  chmodSync(join(TMP, 'bin', 'claude'), 0o755)
  LOG = join(TMP, 'claude-call.json')
  OUT = join(TMP, 'claude-out.json')
  ORIGINAL_PATH = process.env.PATH
  process.env.PATH = `${join(TMP, 'bin')}${delimiter}${ORIGINAL_PATH}`
  process.env.FAKE_CLAUDE_LOG = LOG
  process.env.FAKE_CLAUDE_OUT = OUT
})
after(() => {
  process.env.PATH = ORIGINAL_PATH
  rmSync(TMP, { recursive: true, force: true })
})

// ------------------------------------------------------------------------------- registry

test('the registry names its adapters, and an unknown runtime fails loudly instead of falling back to claude', () => {
  assert.ok(adapterNames().includes('claude'))
  const a = adapter('claude')
  assert.equal(a.name, 'claude')
  assert.equal(typeof a.run, 'function')
  assert.equal(a.capabilities.nativeSchema, true)
  assert.equal(a.capabilities.usdBudget, true)
  assert.equal(a.capabilities.denials, true)
  assert.throws(() => adapter('gpt-who'), /unknown runtime "gpt-who"/)
})

// ----------------------------------------------------------------------------- tool names

// config/agents.json at a35411a, before it held logical names: the Claude translation must give these back exactly.
const CLAUDE_NAMES_AT_A35411A = {
  'flow-resolver': ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', 'mcp__claude_ai_Slack__slack_search_public_and_private', 'mcp__claude_ai_Slack__slack_read_thread', 'mcp__claude_ai_Slack__slack_read_channel', 'mcp__claude_ai_Slack__slack_search_users', 'mcp__claude_ai_Slack__slack_search_channels', 'mcp__notion__notion-search', 'mcp__notion__notion-fetch'],
  'flow-owner-proxy': ['Bash', 'Read', 'Grep', 'Glob', 'ToolSearch', 'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Atlassian__getTransitionsForJiraIssue', 'mcp__claude_ai_Atlassian__transitionJiraIssue'],
  'flow-pm': ['Bash', 'Read', 'Grep', 'Glob', 'ToolSearch', 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', 'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Atlassian__getTransitionsForJiraIssue', 'mcp__claude_ai_Atlassian__transitionJiraIssue', 'mcp__claude_ai_Atlassian__editJiraIssue', 'mcp__claude_ai_Atlassian__getJiraIssueRemoteIssueLinks', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Calendar__search_events', 'mcp__claude_ai_Slack__slack_search_public_and_private', 'mcp__claude_ai_Slack__slack_read_thread', 'mcp__notion__notion-search', 'mcp__notion__notion-fetch'],
}

test('config/agents.json holds logical tool names only, and the claude translation reproduces the a35411a Claude names in order', () => {
  const roles = JSON.parse(readFileSync(join(CORE, 'config', 'agents.json'), 'utf8'))
  assert.deepEqual(Object.keys(roles).sort(), Object.keys(CLAUDE_NAMES_AT_A35411A).sort())
  for (const [name, spec] of Object.entries(roles)) {
    for (const t of spec.tools) assert.doesNotThrow(() => parseTool(t), `${name}: ${t}`)
    assert.deepEqual(claudeTools(spec.tools), CLAUDE_NAMES_AT_A35411A[name], name)
  }
})

test('a logical name outside the vocabulary is refused, so a Claude name cannot slip back into config/agents.json', () => {
  for (const bad of ['Bash', 'mcp__notion__notion-fetch', 'mcp:notion', 'mcp:.x', 'write']) assert.throws(() => parseTool(bad), /logical tool/, bad)
  assert.deepEqual(parseTool('mcp:atlassian.getJiraIssue'), { kind: 'mcp', server: 'atlassian', tool: 'getJiraIssue' })
  assert.deepEqual(parseTool('shell'), { kind: 'shell' })
})

test('an MCP server the claude translation has no connector name for is refused, not guessed', () => {
  assert.throws(() => claudeTools(['mcp:jira-cloud.getIssue']), /no claude name for MCP server "jira-cloud"/)
})

test('claude connector names come from config/mcp-servers.json, and an override adds or replaces one', () => {
  const file = JSON.parse(readFileSync(new URL('../../../config/mcp-servers.json', import.meta.url), 'utf8'))
  assert.equal(file.claude.atlassian, 'claude_ai_Atlassian')
  assert.deepEqual(claudeTools(['mcp:jira-cloud.getIssue'], { 'jira-cloud': 'jira' }), ['ToolSearch', 'mcp__jira__getIssue'])
  assert.deepEqual(claudeTools(['mcp:notion.notion-fetch'], { notion: 'claude_ai_Notion' }), ['ToolSearch', 'mcp__claude_ai_Notion__notion-fetch'])
})

test('config/agents.json names roles, not vendors: every MCP grant is a role op', () => {
  const roles = JSON.parse(readFileSync(join(CORE, 'config', 'agents.json'), 'utf8'))
  for (const [name, spec] of Object.entries(roles)) {
    for (const t of spec.tools) assert.ok(!t.startsWith('mcp:'), `${name}: ${t} names a vendor tool`)
  }
})

test('a role op resolves through its default kind, or through the kind and server the profile picks', () => {
  assert.equal(resolveRoleTool('role:tracker.get'), 'mcp:atlassian.getJiraIssue')
  assert.equal(resolveRoleTool('role:docs.fetch', roleBindings({ docs: { kind: 'confluence' } })), 'mcp:atlassian.getConfluencePage')
  assert.equal(resolveRoleTool('role:chat.send', roleBindings({ chat: { server: 'slack-eu' } })), 'mcp:slack-eu.slack_send_message')
  assert.equal(resolveRoleTool('role:email'), 'mcp:gmail')
  assert.deepEqual(resolveTools(['read', 'role:calendar.list', 'role:docs.search'], { docs: { kind: 'none' } }), ['read', 'mcp:google-calendar.list_events'])
})

test('an unknown role, kind or op is refused, never guessed', () => {
  assert.throws(() => resolveRoleTool('role:pager.page'), /unknown role "pager"/)
  assert.throws(() => roleBindings({ tracker: { kind: 'linear' } }), /no kind "linear"/)
  assert.throws(() => resolveRoleTool('role:tracker.delete'), /no op "delete"/)
  assert.throws(() => resolveRoleTool('role:review-bot.get'), /unknown role "review-bot"/)
  assert.throws(() => parseTool('role:email'), /logical tool/)
})

test('every op declares its access, and every write names an outward channel or null', () => {
  const channels = JSON.parse(readFileSync(join(CORE, 'lib', 'contract', 'kinds.json'), 'utf8')).outwardChannels
  for (const [role, def] of Object.entries(TOOL_KINDS)) {
    for (const [kind, k] of Object.entries(def.kinds)) {
      for (const c of k.serverChannels || []) assert.ok(channels.includes(c), `${role}/${kind}: ${c}`)
      for (const [op, o] of Object.entries(k.ops)) {
        const at = `${role}/${kind}.${op}`
        assert.ok(typeof o.tool === 'string' && o.tool, at)
        assert.ok(['read', 'write'].includes(o.access), at)
        if (o.access === 'write') assert.ok('channel' in o && (o.channel === null || channels.includes(o.channel)), at)
        else assert.ok(!('channel' in o), at)
      }
    }
  }
})

test('outward role ops are the write ops of the named channels, plus whole servers that reach one', () => {
  assert.deepEqual(outwardRoleOps(['chat-send']), ['role:chat.send'])
  assert.deepEqual(outwardRoleOps(['email-draft']), ['role:email'])
  assert.deepEqual(outwardRoleOps(['calendar-write'], { calendar: { kind: 'none' } }), [])
  assert.deepEqual(outwardRoleOps(['public-comment']), [])
})

// ------------------------------------------------------------------------------- claude run

test('claude adapter: a success envelope becomes the uniform result', async () => {
  canned(SUCCESS)
  const r = await adapter('claude').run(req())
  assert.equal(r.exitClass, 'ok')
  assert.deepEqual(r.structured, { verdict: 'pass' })
  assert.deepEqual(r.usage, { in: 9, out: 106, cacheRead: 3, cacheCreate: 13602, costUsd: 0.0175415, costSource: 'reported' })
  assert.equal(r.model, 'claude-haiku-4-5-20251001')
  assert.deepEqual(r.denials, [])
  assert.equal(typeof r.durationMs, 'number')
  assert.equal(typeof r.raw, 'string')
})

test('claude adapter: budget and turn stops are classed from the envelope subtype, never thrown', async () => {
  canned(BUDGET, { exit: 1 })
  const b = await adapter('claude').run(req())
  assert.equal(b.exitClass, 'budget')
  assert.equal(b.structured, null)
  assert.equal(b.usage.costUsd, 0.052704)
  assert.match(b.message, /Reached maximum budget/)
  canned(TURNS, { exit: 1 })
  assert.equal((await adapter('claude').run(req())).exitClass, 'turns')
})

test('claude adapter: no envelope is a runtime_error with stderr, a missing structured_output is a schema failure', async () => {
  canned('', { exit: 1, stderr: 'segfault in the CLI' })
  const dead = await adapter('claude').run(req())
  assert.equal(dead.exitClass, 'runtime_error')
  assert.match(dead.message, /segfault in the CLI/)
  assert.equal(dead.usage.costSource, 'unknown')
  const { structured_output, ...bare } = SUCCESS
  canned(bare)
  assert.equal((await adapter('claude').run(req())).exitClass, 'schema')
})

test('claude adapter: rate-limit and auth failures get their own class', async () => {
  canned('', { exit: 1, stderr: 'API Error: 429 rate_limit_error' })
  assert.equal((await adapter('claude').run(req())).exitClass, 'rate_limit')
  canned('', { exit: 1, stderr: 'Invalid API key · Please run /login' })
  assert.equal((await adapter('claude').run(req())).exitClass, 'auth')
})

// ------------------------------------------------------------------------------ denials (S11)

test('18-r3 S11 (harness-blocked decided by regex over model prose): permission_denials in the envelope become denials[] with the literal refused call', async () => {
  canned(DENIED)
  const r = await adapter('claude').run(req())
  assert.deepEqual(r.denials, [{ tool: 'Bash', input: { command: 'git push origin HEAD' }, text: 'Permission denied: Bash(git push origin HEAD)' }])
})

test('18-r3 S11: an envelope without permission_denials still carries an empty denials[]', async () => {
  const { permission_denials, ...none } = SUCCESS
  canned(none)
  assert.deepEqual((await adapter('claude').run(req())).denials, [])
})

test('lane() hands denials back on a result and on a thrown error', async () => {
  canned(DENIED)
  const r = await lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'opus', schema: SCHEMA, budgetUsd: 1, cwd: TMP })
  assert.equal(r.denials.length, 1)
  canned({ ...BUDGET, permission_denials: DENIED.permission_denials }, { exit: 1 })
  await assert.rejects(lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'opus', schema: SCHEMA, budgetUsd: 1, cwd: TMP }), err => {
    assert.equal(err.denials[0].tool, 'Bash')
    assert.equal(err.exitClass, 'budget')
    return true
  })
})

// ------------------------------------------------------------------------ runtime selection

test('lane() runs on claude when no runtime is named', async () => {
  rmSync(LOG, { force: true })
  canned(SUCCESS)
  const r = await lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'opus', schema: SCHEMA, budgetUsd: 1, cwd: TMP })
  assert.equal(JSON.parse(readFileSync(LOG, 'utf8')).argv[0], '-p')
  assert.deepEqual(r.result, { verdict: 'pass' })
})

test('lane() runs on the runtime it is given: openai-compat answers from its endpoint and claude is never spawned', async () => {
  const { createServer } = await import('node:http')
  const seen = []
  const server = createServer((q, s) => {
    let d = ''
    q.on('data', c => { d += c })
    q.on('end', () => {
      seen.push(JSON.parse(d))
      s.writeHead(200, { 'content-type': 'application/json' })
      s.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"verdict":"fail"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`
  rmSync(LOG, { force: true })
  try {
    const r = await lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'local', schema: SCHEMA, budgetUsd: 1, cwd: TMP, runtime: 'openai-compat' })
    assert.deepEqual(r.result, { verdict: 'fail' })
    assert.equal(r.costUsd, 0)
    assert.deepEqual(r.denials, [])
    assert.equal(seen.length, 1)
    assert.throws(() => readFileSync(LOG), /ENOENT/, 'claude was spawned')
  } finally {
    delete process.env.OPENAI_COMPAT_BASE_URL
    await new Promise(r => server.close(r))
  }
})

test('lane() on a runtime without recorded denials hands back none, so triage keeps its text rules', async () => {
  await assert.rejects(lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'gpt-unpriced', schema: SCHEMA, budgetUsd: 1, cwd: TMP, runtime: 'codex' }), err => {
    assert.equal(err.exitClass, 'runtime_error')
    assert.match(err.message, /no price for codex/)
    assert.equal(err.denials, undefined)
    return true
  })
})

test('lane() with an unknown runtime fails before anything runs', async () => {
  rmSync(LOG, { force: true })
  await assert.rejects(lane({ name: 'review-axis', label: 'x', prompt: 'p', model: 'opus', schema: SCHEMA, budgetUsd: 1, cwd: TMP, runtime: 'gpt-who' }), /unknown runtime "gpt-who"/)
  assert.throws(() => readFileSync(LOG), /ENOENT/)
})
