import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { HARNESS, PROFILE, NO_TRACKER, buildArgs, harness, tmpRoot } from './dryrun.mjs'
import { outwardTools } from '../bin/harness.mjs'

const lastLine = s => JSON.parse(String(s).trim().split('\n').pop())

function argsWith(root, ...extra) {
  const r = harness(root, 'args', '--profile', NO_TRACKER, '--date', '2026-09-30', '--root', root, '--spec', specIn(root), ...extra)
  return { ...r, args: r.result.status === 'ok' ? JSON.parse(readFileSync(r.result.artifact, 'utf8')) : null }
}

function specIn(dir) {
  const spec = join(dir, 'add-flag.md')
  if (!existsSync(spec)) writeFileSync(spec, '# Add a --json flag\n\nAcceptance: the CLI prints JSON when --json is passed.\n')
  return spec
}

test('args defaults the driver to the Node driver', () => {
  const root = tmpRoot('drv-default')
  const r = argsWith(root)
  assert.equal(r.exitCode, 0, r.stdout)
  assert.equal(r.args.driver, 'node')
})

test('args --driver workflow is stored in the args', () => {
  const root = tmpRoot('drv-workflow')
  const r = argsWith(root, '--driver', 'workflow')
  assert.equal(r.exitCode, 0, r.stdout)
  assert.equal(r.args.driver, 'workflow')
})

test('args refuses a driver other than node or workflow, and a bare --driver', () => {
  for (const extra of [['--driver', 'bogus'], ['--driver']]) {
    const root = tmpRoot('drv-bogus')
    const r = argsWith(root, ...extra)
    assert.equal(r.exitCode, 4, r.stdout)
    assert.equal(r.result.status, 'refused')
    assert.match(r.result.reason, /--driver/)
    assert.ok(!existsSync(join(root, 'args-ADD-FLAG.json')), 'no artifact for a refused driver')
  }
})

// A lane call is answered by prompt: the premise lane falsifies the ticket, the log lane writes prose.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const prompt = readFileSync(0, 'utf8')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), premise: /Check the ticket's premise/.test(prompt) }) + '\\n')
const out = /Check the ticket's premise/.test(prompt)
  ? { verdict: 'falsified', evidence: 'src/cli.js does not exist', awaiting: [] }
  : /summarising run/.test(prompt) ? { text: 'The run parked at the premise.', awaiting: [] } : null
if (!out) { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, errors: ['unexpected prompt'] })); process.exit(1) }
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, total_cost_usd: 0.01,
  modelUsage: { 'claude-haiku-4-5': { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 11, cacheCreationInputTokens: 0, costUSD: 0.01 } } }))
`

function fixture(tag) {
  const dir = realpathSync(tmpRoot(tag))
  const repo = join(dir, 'sample-cli')
  mkdirSync(repo)
  const git = (...a) => {
    const p = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'sample\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  // The duplicate guard reads the forge and the remote: a bare origin and a gh that knows no PRs keep
  // it off the network.
  const origin = join(dir, 'origin.git')
  assert.equal(spawnSync('git', ['init', '-q', '--bare', origin]).status, 0)
  git('remote', 'add', 'origin', origin)
  git('push', '-q', 'origin', 'main')
  const profile = join(dir, 'profile.md')
  writeFileSync(profile, readFileSync(NO_TRACKER, 'utf8').replace('/tmp/sample-cli', repo))
  mkdirSync(join(dir, 'bin'))
  writeFileSync(join(dir, 'bin', 'claude'), FAKE_CLAUDE)
  chmodSync(join(dir, 'bin', 'claude'), 0o755)
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\necho "$@" >> "${join(dir, 'gh.log')}"\n[ "$1 $2" = "pr list" ] && { echo '[]'; exit 0; }\nexit 1\n`)
  chmodSync(join(dir, 'bin', 'gh'), 0o755)
  const root = join(dir, 'state')
  const env = { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, FAKE_CLAUDE_LOG: join(dir, 'claude.jsonl'), STATE_ROOT: '' }
  const built = spawnSync(process.execPath, [HARNESS, 'args', '--profile', profile, '--date', '2026-09-30', '--root', root, '--spec', specIn(dir), '--driver', 'node'], { encoding: 'utf8', env })
  assert.equal(built.status, 0, built.stdout)
  const drive = (...argv) => {
    const p = spawnSync(process.execPath, [HARNESS, 'drive', ...argv], { encoding: 'utf8', env })
    return { exitCode: p.status, stdout: p.stdout, stderr: p.stderr, result: lastLine(p.stdout) }
  }
  const calls = () => existsSync(env.FAKE_CLAUDE_LOG) ? readFileSync(env.FAKE_CLAUDE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { dir, repo, root, artifact: lastLine(built.stdout).artifact, drive, calls }
}

test('drive runs the Node driver for real: a falsified premise parks, exit 0, one result line, the result file written', () => {
  const f = fixture('drv-e2e')
  const r = f.drive('--args', f.artifact)
  assert.equal(r.exitCode, 0, r.stdout + r.stderr)
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout is one script-result line')
  const { result } = r
  assert.deepEqual(Object.keys(result), ['status', 'runStatus', 'reason', 'prUrl', 'journal', 'steps'])
  assert.equal(result.status, 'ok')
  assert.equal(result.runStatus, 'parked')
  assert.equal(result.reason, 'premise falsified')
  assert.match(readFileSync(join(f.dir, 'gh.log'), 'utf8'), /^pr list --repo example\/sample-cli --search ADD-FLAG/m, 'the duplicate guard ran against the stub')
  assert.equal(result.prUrl, null)
  assert.equal(result.journal, join(f.root, 'tickets', 'ADD-FLAG', 'driver-journal.jsonl'))
  assert.ok(existsSync(result.journal))
  assert.equal(result.steps.replayed, 0)
  assert.ok(result.steps.live > 0)

  const saved = JSON.parse(readFileSync(join(f.root, 'tickets', 'ADD-FLAG', 'driver-result.json'), 'utf8'))
  assert.equal(saved.ticket, 'ADD-FLAG')
  assert.equal(saved.status, 'parked')
  assert.ok(Array.isArray(saved.calls) && saved.calls.length === 2, JSON.stringify(saved.calls))

  const calls = f.calls()
  const premise = calls.find(c => c.premise)
  assert.ok(premise, 'the premise lane went through claude')
  assert.equal(premise.cwd, join(f.root, 'worktrees', JSON.parse(readFileSync(f.artifact, 'utf8')).branch))
  for (const flag of ['-p', '--model', '--json-schema', '--output-format', '--max-budget-usd']) assert.ok(premise.argv.includes(flag), flag)
  // The premise lane dispatched a subagent despite the no-dispatch rule.
  const denyIdx = premise.argv.indexOf('--disallowedTools')
  assert.ok(denyIdx >= 0, 'premise lane carries --disallowedTools')
  for (const t of ['Agent', 'Task', 'Workflow']) assert.ok(premise.argv.slice(denyIdx + 1).includes(t), t)
  const run = JSON.parse(readFileSync(join(f.root, 'tickets', 'ADD-FLAG', 'run.json'), 'utf8'))
  assert.equal(run.status, 'parked')

  const again = f.drive('--args', f.artifact)
  assert.equal(again.exitCode, 0, again.stdout + again.stderr)
  assert.equal(again.result.runStatus, 'parked')
  assert.equal(f.calls().length, calls.length, 'a relaunch of a finished run calls no lane')
})

test('drive without --args is refused; args that crash the driver exit 1 with an error line', () => {
  const f = fixture('drv-crash')
  const none = f.drive()
  assert.equal(none.exitCode, 4)
  assert.equal(none.result.status, 'refused')

  const broken = join(f.dir, 'broken.json')
  writeFileSync(broken, JSON.stringify({ ...JSON.parse(readFileSync(f.artifact, 'utf8')), schemas: undefined }))
  const crashed = f.drive('--args', broken)
  assert.equal(crashed.exitCode, 1)
  assert.equal(crashed.result.status, 'error')
  assert.match(crashed.result.reason, /args\.schemas is required/)
})

test('a supervised child never holds an outward-channel tool: args carries the same disallowedTools as supervise-env for the acme profile', () => {
  const root = tmpRoot('args-disallow')
  const args = buildArgs(root)
  for (const t of ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Gmail', 'mcp__claude_ai_Google_Calendar__create_event', 'mcp__claude_ai_Google_Calendar__update_event'])
    assert.ok(args.disallowedTools.includes(t), t)
  const env = harness(root, 'supervise-env', '--profile', PROFILE).result.env
  assert.deepEqual(args.disallowedTools, env.SUPERVISE_DISALLOWED_TOOLS.split(' '))
})

test('outward tools resolve through the profile, and a rebound or none role never reopens the default server', () => {
  const base = outwardTools({ ownerProxy: {} }).tools
  const moved = outwardTools({ ownerProxy: {}, tools: { chat: { server: 'atlassian' }, email: { kind: 'none' } } }).tools
  assert.ok(moved.includes('mcp__claude_ai_Atlassian__slack_send_message'))
  for (const t of base) assert.ok(moved.includes(t), t)
})

test('outward tools are derived from write ops: reads and in-run writes stay, a narrowed-out channel reopens', () => {
  const all = outwardTools({ ownerProxy: {} }).tools
  for (const t of ['mcp__claude_ai_Slack__slack_read_thread', 'mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Atlassian__transitionJiraIssue'])
    assert.ok(!all.includes(t), t)
  const chatOnly = outwardTools({ ownerProxy: { hardStopChannels: ['chat-send'] } }).tools
  assert.deepEqual(chatOnly, ['mcp__claude_ai_Slack__slack_send_message'])
})
