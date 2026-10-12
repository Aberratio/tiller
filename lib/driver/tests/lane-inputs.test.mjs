import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildArgs, tmpRoot } from '../../../skills/flow-run-ticket/tests/dryrun.mjs'
import { createContext } from '../core.mjs'
import { journalPath, readJournal } from '../journal.mjs'
import { redact } from '../lane-input.mjs'

const ARGS = buildArgs(tmpRoot('lane-inputs-args'))
const inputs = (root, ticket = ARGS.ticket) => join(root, 'lane-inputs', ticket)

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lane-inputs-repo-'))
  const git = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(dir, 'plan.md'), '# the plan\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return { dir, sha: git('rev-parse', 'HEAD').stdout.trim() }
}

function context(root, wt, lane) {
  const c = createContext({ ...ARGS, stateRoot: root }, { lane, exec: async () => ({}), log: () => {} })
  c.cur = 'plan'
  c.out.start = { branch: 'b' }
  c.wt = wt
  return c
}
const ok = async ({ model }) => ({ result: { ok: true }, usage: {}, costUsd: 0, durationMs: 0, model })

test('every lane call leaves its exact input under the run\'s state dir', async () => {
  const root = tmpRoot('lane-inputs')
  const { dir, sha } = repo()
  const plan = join(dir, 'plan.md')
  const c = context(root, dir, ok)
  await c.lane('premise', `Read the plan at ${plan} and judge it.`, 'ticket')
  const files = readdirSync(inputs(root))
  assert.equal(files.length, 1)
  const got = JSON.parse(readFileSync(join(inputs(root), files[0]), 'utf8'))
  assert.equal(got.label, 'plan:premise:T2:ticket')
  assert.equal(got.prompt, `Read the plan at ${plan} and judge it.`)
  assert.equal(got.schema, 'premise')
  assert.equal(got.model, ARGS.tiers.T2)
  assert.equal(got.runtime, 'claude')
  assert.equal(got.cwd, dir)
  assert.equal(got.gitSha, sha)
  assert.deepEqual(got.files, [{ path: plan, sha256: createHash('sha256').update('# the plan\n').digest('hex') }])
})

test('a retried lane keeps both inputs, one file each', async () => {
  const root = tmpRoot('lane-inputs-retry')
  let n = 0
  const c = context(root, repo().dir, async req => { if (n++ === 0) throw Object.assign(new Error('bad'), { exitClass: 'schema', usage: {}, costUsd: 0 }); return ok(req) })
  await c.lane('premise', 'p', 'ticket')
  assert.equal(readdirSync(inputs(root)).length, 2)
})

test('secrets in a lane input are redacted before they reach disk', async () => {
  const root = tmpRoot('lane-inputs-secret')
  const c = context(root, repo().dir, ok)
  const ghTok = 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
  await c.lane('premise', `Run with GH_TOKEN=${ghTok} and Authorization: Bearer abc.def.ghi`, 'ticket')
  const [f] = readdirSync(inputs(root))
  const text = readFileSync(join(inputs(root), f), 'utf8')
  assert.ok(!text.includes('ghp_abc'), text)
  assert.ok(!text.includes('abc.def.ghi'), text)
  assert.match(text, /GH_TOKEN=<REDACTED>/)
})

test('redact covers env assignments and common token shapes, and leaves prose alone', () => {
  assert.equal(redact('OPENAI_API_KEY=sk-1234567890abcdefghij'), 'OPENAI_API_KEY=<REDACTED>')
  assert.equal(redact('export AWS_SECRET_ACCESS_KEY="x/y+z"'), 'export AWS_SECRET_ACCESS_KEY=<REDACTED>')
  assert.equal(redact('key ' + 'sk-' + 'ant-api03-abcdefghijklmnopqrstu end'), 'key <REDACTED> end')
  assert.equal(redact('slack ' + 'xo' + 'xb-123-456-abc end'), 'slack <REDACTED> end')
  assert.equal(redact('The plan at /tmp/a.md says X=1 is fine.'), 'The plan at /tmp/a.md says X=1 is fine.')
})

test('redact covers keyword secrets in the shapes they are written in prompts', () => {
  for (const s of ['access code: zzqxwvut', 'password=hunter22', 'token: abc123def', 'api_key=XYZ123', 'the Access-Code = zzqxwvut,'])
    assert.ok(!/zzqxwvut|hunter22|abc123def|XYZ123/.test(redact(s)), `${s} -> ${redact(s)}`)
  assert.equal(redact('access code: zzqxwvut'), 'access code: <REDACTED>')
})

test('the hitl linter and lane-input redaction share one secret matcher', async () => {
  const { lint } = await import('../../hitl/lint.mjs')
  for (const s of ['password=hunter22', 'api_key=XYZ123', 'access code: zzqxwvut']) {
    const r = lint({ situation: s }, {})
    assert.ok(r.violations.some(v => v.rule === 'L20'), s)
    assert.ok(!lint({ situation: redact(s) }, {}).violations.some(v => v.rule === 'L20'), redact(s))
  }
})

test('a literal on the profile\'s redaction list never reaches disk', async () => {
  const root = tmpRoot('lane-inputs-literal')
  const c = createContext({ ...ARGS, stateRoot: root, facts: { ...ARGS.facts, redact: ['zzqxwvut'] } }, { lane: ok, exec: async () => ({}), log: () => {} })
  c.cur = 'plan'; c.out.start = { branch: 'b' }; c.wt = repo().dir
  await c.lane('premise', 'Log in as the test user with zzqxwvut and check the CTA.', 'ticket')
  const [f] = readdirSync(inputs(root))
  assert.ok(!readFileSync(join(inputs(root), f), 'utf8').includes('zzqxwvut'))
})

test('two tickets of one day run keep their lane inputs apart under their own keys', async () => {
  const root = tmpRoot('lane-inputs-day')
  const dir = repo().dir
  await context(root, dir, ok).lane('premise', 'p one', 'ticket')
  const other = createContext({ ...ARGS, ticket: 'ABC-2', stateRoot: root }, { lane: ok, exec: async () => ({}), log: () => {} })
  other.cur = 'plan'; other.out.start = { branch: 'b' }; other.wt = dir
  await other.lane('premise', 'p two', 'ticket')
  const [a] = readdirSync(inputs(root))
  const [b] = readdirSync(inputs(root, 'ABC-2'))
  assert.equal(JSON.parse(readFileSync(join(inputs(root), a), 'utf8')).prompt, 'p one')
  assert.equal(JSON.parse(readFileSync(join(inputs(root, 'ABC-2'), b), 'utf8')).prompt, 'p two')
})

test('a lane input that cannot be written is journaled as a warning and the lane still runs', async () => {
  const root = tmpRoot('lane-inputs-disk')
  writeFileSync(join(root, 'lane-inputs'), 'not a directory')
  const r = await context(root, repo().dir, ok).lane('premise', 'p', 'ticket')
  assert.equal(r.ok, true)
  const warn = readJournal(journalPath(root, ARGS.ticket)).filter(l => l.kind === 'warning')
  assert.equal(warn.length, 1)
  assert.match(warn[0].message, /lane input not captured/)
})
