import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lane, laneSandbox } from '../runtime.mjs'
import { NO_TRACKER, buildArgs, makeSim, runTicketDriver, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_PROFILE = join(CORE, 'lib', 'testing', 'fixtures', 'acme', 'profile.md')
let TMP, LOG, ORIGINAL_PATH, ORIGINAL_CORE

// Agent resolution as a live `claude -p` 2.x does it (probe 2026-09-30): `--agent <name>` is looked up in
// the `--agents` JSON and the installed agents; a miss exits 1 with no stdout and this stderr line.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync, readdirSync } = require('node:fs')
const argv = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
const at = f => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1] }
writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, stdin, skillsCore: process.env.TILLER_HOME || null }))
const name = at('--agent')
if (name) {
  const inline = at('--agents') ? Object.keys(JSON.parse(at('--agents'))) : []
  const installed = readdirSync(process.env.FAKE_AGENTS_DIR).map(f => f.replace(/\\.md$/, ''))
  if (!inline.includes(name) && !installed.includes(name)) {
    process.stderr.write("--agent '" + name + "' not found. Available agents: " + [...installed, ...inline].join(', ') + '\\n')
    process.exit(1)
  }
}
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { verdict: 'pass' }, total_cost_usd: 0.01,
  modelUsage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } }))
`

const SCHEMA = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] }
const roleLane = agentType => ({ name: 'owner-proxy', label: 'escalate', prompt: 'mandate step', model: 'opus', schema: SCHEMA, budgetUsd: 15, cwd: TMP, agentType, disallowedTools: ['mcp__claude_ai_Slack__slack_send_message'] })
const recorded = () => JSON.parse(readFileSync(LOG, 'utf8'))
const inlineAgents = () => { const { argv } = recorded(); return JSON.parse(argv[argv.indexOf('--agents') + 1]) }

function skillParts(skill) {
  const md = readFileSync(join(CORE, 'skills', skill, 'SKILL.md'), 'utf8')
  const m = md.match(/^---\n([\s\S]*?)\n---\n/)
  return { description: m[1].match(/^description: (.*)$/m)[1], body: md.slice(m[0].length) }
}

before(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-agents-')))
  mkdirSync(join(TMP, 'bin'))
  mkdirSync(join(TMP, 'agents'))
  writeFileSync(join(TMP, 'agents', 'acme-resolver.md'), '---\nname: acme-resolver\n---\n')
  writeFileSync(join(TMP, 'bin', 'claude'), FAKE_CLAUDE)
  chmodSync(join(TMP, 'bin', 'claude'), 0o755)
  LOG = join(TMP, 'claude-call.json')
  ORIGINAL_PATH = process.env.PATH
  ORIGINAL_CORE = process.env.TILLER_HOME
  delete process.env.TILLER_HOME
  process.env.PATH = `${join(TMP, 'bin')}${delimiter}${ORIGINAL_PATH}`
  process.env.FAKE_CLAUDE_LOG = LOG
  process.env.FAKE_AGENTS_DIR = join(TMP, 'agents')
})
after(() => {
  process.env.PATH = ORIGINAL_PATH
  if (ORIGINAL_CORE !== undefined) process.env.TILLER_HOME = ORIGINAL_CORE
  rmSync(TMP, { recursive: true, force: true })
})

test('15-phase-b-live D1 (`--agent flow-owner-proxy` not found): lane() resolves the owner-proxy role from its skill without an installed agent file', async () => {
  const r = await lane(roleLane('flow-owner-proxy'))
  assert.deepEqual(r.result, { verdict: 'pass' })
  const def = inlineAgents()['flow-owner-proxy']
  const { description, body } = skillParts('flow-owner-proxy')
  assert.ok(def.prompt.endsWith(body), 'the agent prompt is the skill body, so the skill stays the only source')
  assert.equal(def.description, description)
})

test('flow-pm resolves as a thin agent: sonnet, and exactly the allowlist its README names', async () => {
  await lane(roleLane('flow-pm'))
  const def = inlineAgents()['flow-pm']
  assert.equal(def.model, 'sonnet')
  assert.deepEqual([...def.tools].sort(), [
    'Bash', 'Read', 'Grep', 'Glob', 'ToolSearch',
    'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql', 'mcp__claude_ai_Atlassian__getJiraIssue',
    'mcp__claude_ai_Atlassian__getTransitionsForJiraIssue', 'mcp__claude_ai_Atlassian__transitionJiraIssue',
    'mcp__claude_ai_Atlassian__editJiraIssue', 'mcp__claude_ai_Atlassian__getJiraIssueRemoteIssueLinks',
    'mcp__claude_ai_Google_Calendar__list_events', 'mcp__claude_ai_Google_Calendar__search_events',
    'mcp__claude_ai_Slack__slack_search_public_and_private', 'mcp__claude_ai_Slack__slack_read_thread',
    'mcp__notion__notion-search', 'mcp__notion__notion-fetch',
    'StructuredOutput',
  ].sort())
  assert.ok(!def.tools.includes('Write') && !def.tools.includes('Edit'), 'README: no Write/Edit, the log is written through Bash')
})

test('probe 2026-09-30 (an agent allowlist without StructuredOutput returns success with no structured_output): every inline role keeps StructuredOutput', async () => {
  for (const name of ['flow-resolver', 'flow-owner-proxy', 'flow-pm']) {
    await lane(roleLane(name))
    assert.ok(inlineAgents()[name].tools.includes('StructuredOutput'), name)
  }
})

test('the role skill reaches its scripts through $TILLER_HOME, so an unset one is pointed at this checkout for the lane', async () => {
  await lane(roleLane('flow-owner-proxy'))
  assert.equal(recorded().skillsCore, CORE)
})

test('probe 2026-09-30 (auto mode refuses `ls "$TILLER_HOME/..."`: "Contains simple_expansion"): the prompt names the checkout path literally before the skill body', async () => {
  await lane(roleLane('flow-owner-proxy'))
  const { prompt } = inlineAgents()['flow-owner-proxy']
  const head = prompt.slice(0, prompt.length - skillParts('flow-owner-proxy').body.length)
  assert.ok(head.includes('`' + CORE + '`'), head)
})

test('an installed agent that is not a harness role passes through as --agent alone', async () => {
  await lane(roleLane('acme-resolver'))
  const { argv } = recorded()
  assert.deepEqual(argv.slice(argv.indexOf('--agent'), argv.indexOf('--agent') + 2), ['--agent', 'acme-resolver'])
  assert.ok(!argv.includes('--agents'))
})

test('an unknown agent still fails loudly with the CLI text, never as a silent default agent', async () => {
  await assert.rejects(lane(roleLane('flow-nobody')), /--agent 'flow-nobody' not found/)
})

test('with an inline role, the variadic --disallowedTools still closes argv', async () => {
  await lane(roleLane('flow-pm'))
  const { argv } = recorded()
  assert.deepEqual(argv.slice(-5), ['--disallowedTools', 'mcp__claude_ai_Slack__slack_send_message', 'Agent', 'Task', 'Workflow'])
})

// `harness.mjs args` decides which role agents a run's escalation lanes get. A proxy that is not a harness
// role (the profile's owner-proxy is a skill) gets no agentType, so its lane stays the plain lane it was.
test('args for a node run name flow-resolver as the resolver agent, and leave a proxy that is not a harness role unset', () => {
  const args = buildArgs(tmpRoot('agents-acme'), { profile: FIXTURE_PROFILE })
  assert.equal(args.driver, 'node')
  assert.deepEqual(args.agents, { resolver: 'flow-resolver' })
})

test('args for a node run pass the profile proxy through when it is a harness role', () => {
  const root = tmpRoot('agents-flow-proxy')
  const spec = join(root, 'add-flag.md')
  writeFileSync(spec, '# Add a --json flag\n')
  const args = buildArgs(root, { profile: NO_TRACKER, spec })
  assert.deepEqual(args.agents, { resolver: 'flow-resolver', ownerProxy: 'flow-owner-proxy' })
})

test('args for a workflow run set no agents: a Workflow agentType resolves installed agents only', () => {
  const args = buildArgs(tmpRoot('agents-workflow'), { profile: FIXTURE_PROFILE, extra: ['--driver', 'workflow'] })
  assert.equal(args.agents, undefined)
})

test('a lane question in a node run reaches the resolver lane with agentType flow-resolver', async () => {
  const root = tmpRoot('agents-question')
  const args = buildArgs(root, { profile: FIXTURE_PROFILE })
  let asked = false
  const sim = makeSim(root, args, {
    agent: lane => lane === 'plan' && !asked
      ? (asked = true, { questions: [{ question: 'Which module?', options: ['a', 'b'], recommendation: 'a', why: 'ticket is vague' }] })
      : undefined,
  })
  await runTicketDriver(sim)
  const resolver = sim.laneOpts.find(o => o.label === 'plan:resolver:T3:question')
  assert.ok(resolver, sim.labels.join(' '))
  assert.equal(resolver.agentType, 'flow-resolver')
  assert.ok(sim.laneOpts.filter(o => !/:resolver:|:owner-proxy:/.test(o.label)).every(o => o.agentType === undefined), 'only role lanes get an agent')
})

test('a role lane under a repo sandbox can still read the core it runs scripts from; a plain lane gets no extra read', async () => {
  await lane(roleLane('flow-owner-proxy'))
  const settingsOf = () => { const { argv } = recorded(); return JSON.parse(argv[argv.indexOf('--settings') + 1]) }
  assert.ok(settingsOf().sandbox.filesystem.allowRead.includes(CORE))
  await lane(roleLane('acme-resolver'))
  assert.deepEqual(settingsOf(), laneSandbox().settings)
})
