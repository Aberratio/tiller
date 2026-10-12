import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { exec, gitCommonDir, parseScriptResult, lane, laneSandbox, pool } from '../runtime.mjs'

let TMP, LOG, OUT, WORKTREE, ORIGINAL_PATH

const FAKE_CLAUDE = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const stdin = readFileSync(0, 'utf8')
writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin, path: process.env.PATH }))
process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_OUT, 'utf8'))
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR)
process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0))
`

// Shapes copied from a live `claude -p --output-format json --json-schema` probe (haiku, 2026-09-30).
const SUCCESS = {
  type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed',
  result: '{"verdict":"pass"}', structured_output: { verdict: 'pass' }, total_cost_usd: 0.0175415, duration_ms: 1571,
  usage: { input_tokens: 9, output_tokens: 106, cache_read_input_tokens: 0, cache_creation_input_tokens: 13602 },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 9, outputTokens: 106, cacheReadInputTokens: 0, cacheCreationInputTokens: 13602, costUSD: 0.0175415 } },
}
const BUDGET_EXCEEDED = {
  type: 'result', subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted',
  errors: ['Reached maximum budget ($0.05)'], total_cost_usd: 0.052704, duration_ms: 4233,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 9, outputTokens: 290, cacheReadInputTokens: 0, cacheCreationInputTokens: 40996, costUSD: 0.052704 } },
}

function canned(stdout, { exit = 0, stderr = '' } = {}) {
  writeFileSync(OUT, typeof stdout === 'string' ? stdout : JSON.stringify(stdout))
  process.env.FAKE_CLAUDE_EXIT = String(exit)
  process.env.FAKE_CLAUDE_STDERR = stderr
}
const recorded = () => JSON.parse(readFileSync(LOG, 'utf8'))
const SCHEMA = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'] }
const baseLane = () => ({ name: 'review-axis', label: 'review: standards', prompt: 'judge it', model: 'opus', schema: SCHEMA, budgetUsd: 15, cwd: WORKTREE })

before(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'driver-runtime-')))
  mkdirSync(join(TMP, 'bin'))
  WORKTREE = join(TMP, 'worktree')
  mkdirSync(WORKTREE)
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

// ------------------------------------------------------------------------------------------ lane

test('13 finding 6 (exec lane schema drift, 5-8 invalid answers per run): a judgment lane pins the schema, model, budget and JSON envelope in argv', async () => {
  canned(SUCCESS)
  await lane(baseLane())
  const { argv } = recorded()
  assert.deepEqual(argv, ['-p', '--model', 'opus', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--max-budget-usd', '15', '--permission-mode', 'auto',
    '--settings', JSON.stringify(laneSandbox().settings), '--disallowedTools', 'Agent', 'Task', 'Workflow'])
})

// PATH and HOME from a lane that died on `spawnSync git EPERM` (2026-09-30).
const HOME = '/Users/owner'
const LANE_PATH = [`${HOME}/.local/bin`, `${HOME}/.rbenv/shims`, `${HOME}/.nvm/versions/node/v24.15.0/bin`, '/opt/homebrew/bin', HOME, `${HOME}/bin`, '/usr/bin', '/bin'].join(':')
const prefixWithLib = p => p === `${HOME}/.nvm/versions/node/v24.15.0/lib`

test('14 defect 4 (spawnSync git/npm EPERM in a lane under a denyRead ["~/"] sandbox): every PATH dir under HOME is readable, so the PATH walk never stops on EPERM', () => {
  const { settings } = laneSandbox({ path: LANE_PATH, home: HOME, exists: prefixWithLib })
  const allow = settings.sandbox.filesystem.allowRead
  for (const dir of [`${HOME}/.local/bin`, `${HOME}/.rbenv/shims`, `${HOME}/.nvm/versions/node/v24.15.0/bin`, `${HOME}/bin`]) assert.ok(allow.includes(dir), dir)
  assert.ok(!allow.includes('/usr/bin') && !allow.includes('/opt/homebrew/bin'), 'dirs outside HOME are not the sandbox\'s to re-allow')
})

test('14 defect 4: npm resolves through its symlink into the node prefix, and git reads ~/.gitconfig, so both are readable', () => {
  const allow = laneSandbox({ path: LANE_PATH, home: HOME, exists: prefixWithLib }).settings.sandbox.filesystem.allowRead
  assert.ok(allow.includes(`${HOME}/.nvm/versions/node/v24.15.0`), 'prefix of a bin dir that has a lib/ beside it')
  assert.ok(allow.includes(`${HOME}/.rbenv`), 'shims resolve into their parent')
  assert.ok(!allow.includes(`${HOME}/.local`), 'a bin dir with no lib/ beside it is not a toolchain prefix')
  assert.ok(allow.includes(`${HOME}/.gitconfig`))
})

test('14 defect 4: HOME itself leaves PATH and is never re-allowed, so the repo\'s denyRead ["~/"] still holds', () => {
  const { PATH, settings } = laneSandbox({ path: LANE_PATH, home: HOME, exists: () => true })
  assert.deepEqual(PATH.split(':'), LANE_PATH.split(':').filter(p => p !== HOME))
  assert.ok(!settings.sandbox.filesystem.allowRead.includes(HOME), 'the prefix of ~/bin is HOME')
})

test('14 defect 4: the lane settings only add reads - no network, no write, no unsandboxed escape, no sandbox switch', () => {
  const { settings } = laneSandbox({ path: LANE_PATH, home: HOME, exists: () => true })
  assert.deepEqual(Object.keys(settings), ['sandbox'])
  assert.deepEqual(Object.keys(settings.sandbox), ['filesystem'])
  assert.deepEqual(Object.keys(settings.sandbox.filesystem), ['allowRead'])
})

test('14 defect 4: the lane passes its sandbox settings before the variadic tool list and runs claude on the cleaned PATH', async () => {
  canned(SUCCESS)
  const tools = ['mcp__claude_ai_Slack__slack_send_message']
  await lane({ ...baseLane(), disallowedTools: tools })
  const { argv, path } = recorded()
  const i = argv.indexOf('--settings')
  assert.ok(i > 0 && i < argv.indexOf('--disallowedTools'))
  assert.deepEqual(JSON.parse(argv[i + 1]), laneSandbox().settings)
  assert.equal(path, laneSandbox().PATH)
})

// A lane in a run worktree under ~/.claude/run-state could not run git from a
// spawned test, because the worktree's .git file points into <repo>/.git/worktrees/..., under the
// repo sandbox's denyRead ["~/"]. Layout as `git worktree add` writes it.
function linkedWorktree(tag, gitdirLine) {
  const repo = join(TMP, `${tag}-repo`)
  const wt = join(TMP, `${tag}-wt`)
  mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'gitdir'), `${join(wt, '.git')}\n`)
  mkdirSync(wt)
  writeFileSync(join(wt, '.git'), `gitdir: ${gitdirLine(repo, wt)}\n`)
  return { repo, wt }
}

test('ABC-8846 defect 3: a linked worktree names its common git dir, absolute or relative', () => {
  const abs = linkedWorktree('abs', repo => join(repo, '.git', 'worktrees', 'wt'))
  assert.equal(gitCommonDir(abs.wt), join(abs.repo, '.git'))
  const rel = linkedWorktree('rel', () => '../rel-repo/.git/worktrees/wt')
  assert.equal(gitCommonDir(rel.wt), join(rel.repo, '.git'))
})

test('ABC-8846 defect 3: a main checkout, a plain dir and a missing dir have no common git dir to add', () => {
  const main = join(TMP, 'main-checkout')
  mkdirSync(join(main, '.git'), { recursive: true })
  assert.equal(gitCommonDir(main), null)
  assert.equal(gitCommonDir(WORKTREE), null)
  assert.equal(gitCommonDir(join(TMP, 'nowhere')), null)
})

test('ABC-8846 defect 3: a lane in a linked worktree may read the common git dir, and nothing else of the repo', async () => {
  const { repo, wt } = linkedWorktree('lane', repo => join(repo, '.git', 'worktrees', 'wt'))
  canned(SUCCESS)
  await lane({ ...baseLane(), cwd: wt })
  const { argv } = recorded()
  const allow = JSON.parse(argv[argv.indexOf('--settings') + 1]).sandbox.filesystem.allowRead
  assert.ok(allow.includes(join(repo, '.git')), allow.join(' '))
  assert.ok(!allow.includes(repo), 'the main checkout\'s working tree stays denied')
})

test('a supervised child never holds an outward-channel tool: the lane runs in auto permission mode and drops every disallowed tool', async () => {
  canned(SUCCESS)
  const tools = ['mcp__claude_ai_Slack__slack_send_message', 'mcp__claude_ai_Gmail']
  await lane({ ...baseLane(), agentType: 'flow-resolver', disallowedTools: tools })
  const { argv } = recorded()
  assert.deepEqual(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto'])
  assert.deepEqual(argv.slice(-6), ['--disallowedTools', ...tools, 'Agent', 'Task', 'Workflow'], 'the variadic tool list closes argv so no later flag is swallowed')
  assert.ok(argv.includes('--agent'))
  assert.ok(!argv.some(a => /dangerously/.test(a)))
})

test('ABC-8367 defect 7 (premise lane dispatched a subagent despite no-dispatch): with no caller-supplied disallowed tools, the lane still denies Agent, Task and Workflow', async () => {
  canned(SUCCESS)
  await lane({ ...baseLane(), disallowedTools: [] })
  const { argv } = recorded()
  assert.ok(argv.includes('--permission-mode'))
  assert.deepEqual(argv.slice(-4), ['--disallowedTools', 'Agent', 'Task', 'Workflow'])
})

test('a caller-supplied deny that already names a dispatch tool is not duplicated', async () => {
  canned(SUCCESS)
  await lane({ ...baseLane(), disallowedTools: ['Agent', 'mcp__claude_ai_Gmail'] })
  const { argv } = recorded()
  assert.deepEqual(argv.slice(-5), ['--disallowedTools', 'Agent', 'mcp__claude_ai_Gmail', 'Task', 'Workflow'])
})

test('agentType selects the agent with --agent', async () => {
  canned(SUCCESS)
  await lane({ ...baseLane(), agentType: 'flow-resolver' })
  const { argv } = recorded()
  assert.equal(argv[argv.indexOf('--agent') + 1], 'flow-resolver')
})

test('the lane runs in the worktree it was given', async () => {
  canned(SUCCESS)
  await lane(baseLane())
  assert.equal(recorded().cwd, WORKTREE)
})

test('ABC-8270 (literal \\n re-rendered by the model): the prompt reaches claude on stdin byte-for-byte, never in argv', async () => {
  const prompt = 'line one\nsay "hi" and \'bye\'\nprintf "a\\nb" stays a literal backslash-n\n\ttab $(not expanded) `nor this`\n'
  canned(SUCCESS)
  await lane({ ...baseLane(), prompt })
  const call = recorded()
  assert.equal(call.stdin, prompt)
  assert.ok(!call.argv.some(a => a.includes('line one')), 'prompt leaked into argv')
})

test('structured_output, usage from modelUsage, cost, duration and model come back from the envelope', async () => {
  canned(SUCCESS)
  const r = await lane(baseLane())
  assert.deepEqual(r.result, { verdict: 'pass' })
  assert.deepEqual(r.usage, { input: 9, output: 106, cacheRead: 0, cacheCreate: 13602 })
  assert.equal(r.costUsd, 0.0175415)
  assert.equal(r.model, 'claude-haiku-4-5-20251001')
  assert.equal(typeof r.durationMs, 'number')
})

test('is_error envelope throws with the envelope error text and keeps the spend on the error', async () => {
  canned(BUDGET_EXCEEDED, { exit: 1 })
  await assert.rejects(lane(baseLane()), err => {
    assert.match(err.message, /Reached maximum budget \(\$0\.05\)/)
    assert.equal(err.subtype, 'error_max_budget_usd')
    assert.equal(err.costUsd, 0.052704)
    assert.equal(err.usage.cacheCreate, 40996)
    return true
  })
})

test('non-zero exit with no envelope throws with stderr', async () => {
  canned('', { exit: 1, stderr: 'API Error: 429 rate_limit_error' })
  await assert.rejects(lane(baseLane()), /API Error: 429 rate_limit_error/)
})

test('garbage stdout on exit 0 throws with the text instead of returning nothing', async () => {
  canned('I could not produce JSON, sorry')
  await assert.rejects(lane(baseLane()), /I could not produce JSON, sorry/)
})

test('a success envelope without structured_output throws', async () => {
  const { structured_output, ...noStructured } = SUCCESS
  canned(noStructured)
  await assert.rejects(lane(baseLane()), /no structured_output/)
})

// ------------------------------------------------------------------------------------------ exec

function childScript(body) {
  const p = join(TMP, `child-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(p, body)
  return p
}

test('f23113d (exec lane rejected a real success as "command altered" when the model re-quoted it): argv reaches the child verbatim, no shell, no model', async () => {
  const echo = childScript('console.log(JSON.stringify({ status: "ok", argv: process.argv.slice(2) }))')
  const tricky = ['he said "run it"', "it's a 'test'", 'two  spaces', 'real\nnewline', '$(echo pwned)', '`id`', '*', 'a\\nb']
  const r = await exec([process.execPath, echo, ...tricky])
  assert.equal(r.exitCode, 0)
  assert.deepEqual(parseScriptResult(r.stdout, 'echo').argv, tricky)
})

test('ABC-8270 (a wait-ci call parked because the model used Monitor): exit code 2 comes back as pending, with the script result', async () => {
  const pending = childScript('console.log("progress"); console.log(JSON.stringify({ status: "pending", reason: "ci running" })); process.exit(2)')
  const r = await exec([process.execPath, pending])
  assert.equal(r.exitCode, 2)
  assert.deepEqual(parseScriptResult(r.stdout, 'wait-ci.mjs'), { status: 'pending', reason: 'ci running' })
  assert.equal(typeof r.durationMs, 'number')
})

test('exec runs in cwd with env merged over the parent env', async () => {
  const where = childScript('console.log(JSON.stringify({ status: "ok", cwd: process.cwd(), root: process.env.STATE_ROOT, path: !!process.env.PATH }))')
  const r = await exec([process.execPath, where], { cwd: WORKTREE, env: { STATE_ROOT: '/tmp/x' } })
  assert.deepEqual(parseScriptResult(r.stdout, 'where'), { status: 'ok', cwd: WORKTREE, root: '/tmp/x', path: true })
})

test('exec keeps stderr and a non-zero exit', async () => {
  const bad = childScript('process.stderr.write("boom"); process.exit(3)')
  const r = await exec([process.execPath, bad])
  assert.equal(r.exitCode, 3)
  assert.equal(r.stderr, 'boom')
})

test('exec past timeoutMs is killed and reported, not awaited forever', async () => {
  const slow = childScript('setTimeout(() => {}, 60000)')
  const r = await exec([process.execPath, slow], { timeoutMs: 200 })
  assert.notEqual(r.exitCode, 0)
  assert.equal(r.timedOut, true)
})

test('exec of a missing binary returns exit 127 with the error, never throws', async () => {
  const r = await exec([join(TMP, 'no-such-binary')])
  assert.equal(r.exitCode, 127)
  assert.match(r.stderr, /ENOENT/)
})

test('parseScriptResult: no JSON on the last line is a script-error naming the script', () => {
  const want = { status: 'error', kind: 'script-error', reason: 'no script-result line from state.mjs' }
  assert.deepEqual(parseScriptResult('{"status":"ok"}\nTraceback: boom\n', 'state.mjs'), want)
  assert.deepEqual(parseScriptResult('', 'state.mjs'), want)
  assert.deepEqual(parseScriptResult('[1,2]\n', 'state.mjs'), want)
  assert.deepEqual(parseScriptResult('noise\n{"status":"ok","n":1}\n\n', 'state.mjs'), { status: 'ok', n: 1 })
})

// ------------------------------------------------------------------------------------------ pool

test('pool never runs more than its limit at once and keeps input order', async () => {
  let running = 0, peak = 0
  const thunk = (v, ms) => async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, ms)); running--; return v }
  const out = await pool(2)([thunk('a', 30), thunk('b', 5), thunk('c', 20), thunk('d', 1), thunk('e', 10)])
  assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e'])
  assert.equal(peak, 2)
})

test('pool turns a thrown branch into null and still finishes the others', async () => {
  const out = await pool(3)([async () => 1, async () => { throw new Error('axis died') }, async () => 3])
  assert.deepEqual(out, [1, null, 3])
})

test('pool of an empty list resolves to an empty list', async () => {
  assert.deepEqual(await pool(3)([]), [])
})
