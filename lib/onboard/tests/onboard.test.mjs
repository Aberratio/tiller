import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { branchConvention, classifyScripts, commitStyle, detect, integrateMain, parseWorkflow, redactUrl, ticketKeys } from '../detect.mjs'
import { questions, render, secretIn, siblingValues } from '../profile.mjs'
import { authorityOf } from '../../gates/evaluate.mjs'
import { profileFacts, renderFacts } from '../../gates/tests/helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const CLI = join(ROOT, 'lib', 'onboard', 'onboard.mjs')

// Every fixture directory, removed once the file's tests are done.
const temps = []
function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// The developer's own ~/.gitconfig must not decide what these fixtures look like: a `commit.gpgsign`,
// an `init.defaultBranch` or a commit template would change what detection reads.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

// A clone with an origin, five ticket branches and a package with tests and lint.
function fixtureRepo(subject = (i) => `[WID-${i}] feat(core): change ${i}`) {
  const base = tmp('onboard-test-')
  const origin = join(base, 'origin.git')
  const repo = join(base, 'widget')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, repo)
  git(repo, 'config', 'user.email', 't@t.invalid'); git(repo, 'config', 'user.name', 't')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', 'test:e2e': 'playwright test' } }))
  writeFileSync(join(repo, 'package-lock.json'), '{}')
  writeFileSync(join(repo, 'CONTRIBUTING.md'), 'rebase\n')
  for (let i = 1; i <= 6; i++) { writeFileSync(join(repo, `f${i}`), `${i}`); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', subject(i)) }
  git(repo, 'push', '-q', 'origin', 'main')
  for (let i = 1; i <= 5; i++) git(repo, 'push', '-q', 'origin', `main:refs/heads/WID-${i}-some-work`)
  git(repo, 'remote', 'set-head', 'origin', 'main')
  return { base, repo }
}

function cli(profilesDir, ...args) { return cliWith({}, profilesDir, ...args) }
function cliWith({ today = '2026-10-06', input, env = {} }, profilesDir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', input, env: { ...process.env, ...GIT_ENV, ...env, TILLER_PROFILES_DIR: profilesDir, ONBOARD_TODAY: today } })
  return { code: r.status, out: r.stdout + r.stderr }
}

const ANSWERS = [['tracker.kind', 'jira'], ['identity.jiraKey', 'WID'], ['tracker.site', 'example.atlassian.net'],
  ['tracker.startStatus', 'In', 'Progress'], ['branching.integrateMain', 'rebase'], ['runPolicy.dayCeiling', '5'],
  ['runPolicy.maxParallel', '1'], ['inviolables', 'none'], ['escalation.human', 'Tech', 'lead'], ['escalation.doubtLog', 'doubts.md'],
  ['gates', 'check: *']]

// A launch-safe generated profile for the fixture repo.
function onboarded() {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  assert.equal(cli(dir, 'new', 'widget', repo, '--no-network').code, 4)
  for (const a of ANSWERS) {
    const r = cli(dir, 'answer', 'widget', ...a)
    assert.ok([0, 4].includes(r.code), `${a[0]}: ${r.out}`)
  }
  const md = join(dir, 'widget', 'profile.md')
  return { repo, dir, md, read: () => readFileSync(md, 'utf8'), answers: () => readFileSync(join(dir, 'widget', 'answers.json'), 'utf8') }
}

function profilesDir() {
  const dir = tmp('onboard-profiles-')
  return dir
}

test('ticket keys need three sightings and skip encoding names', () => {
  assert.deepEqual(ticketKeys(['ABC-1-a', 'ABC-2', 'fix ABC-3', 'UTF-8', 'UTF-8', 'UTF-8', 'X-1']), [{ key: 'ABC', count: 3 }])
})

test('a branch convention needs half the work branches', () => {
  assert.equal(branchConvention(['ABC-1-a', 'ABC-2-b', 'ABC-3-c', 'misc', 'main']).value, '`<KEY>-<number>-<details>`')
  assert.equal(branchConvention(['ABC-1-a', 'x', 'y', 'z', 'w']).value, null)
  assert.equal(branchConvention(['ABC-1-a']).value, null)
})

test('commit style ignores bot subjects', () => {
  const s = ['[ABC-1] fix(a): x', '[ABC-2] feat: y', '[ABC-3] fix(b): z', 'Bump lodash', 'Bump x', 'Bump y', '[ABC-4] chore: w']
  assert.match(commitStyle(s).value, /\[<KEY>-<number>\]/)
})

test('integrating main is called only on enough evidence', () => {
  assert.equal(integrateMain(Array(3).fill("Merge branch 'main' into ABC-1"), 10, 'main').value, 'merge')
  assert.equal(integrateMain([], 10, 'main').value, 'rebase')
  assert.equal(integrateMain(["Merge branch 'main' into x"], 10, 'main').value, null)
})

test('scripts are sorted into lanes and e2e never becomes a static check', () => {
  const c = classifyScripts({ test: 'jest', lint: 'eslint', typecheck: 'tsc', 'test:e2e': 'playwright test', build: 'vite' })
  assert.deepEqual(c, { test: ['test'], static: [['lint', 'lint'], ['typecheck', 'typecheck']], e2e: ['test:e2e'] })
  assert.deepEqual(classifyScripts({ test: 'echo "Error: no test specified" && exit 1' }).test, [])
})

test('a script name that would break the command cell is dropped, not rendered', () => {
  // Every lane an unanchored pattern can reach: a backtick closes the code span, a newline ends
  // the table row, a pipe opens a new cell.
  const c = classifyScripts({ 'e2e `x`': 'jest', 'e2e|pipe': 'jest', 'smoke': 'playwright test\nrm -rf /', 'test:unit': 'jest' })
  assert.deepEqual(c, { test: ['test:unit'], static: [], e2e: ['smoke'] })
})

test('a credential in a remote URL never reaches the reason a human reads', () => {
  assert.equal(redactUrl('https://u:ghp_secret@github.corp/x/y.git'), 'https://***@github.corp/x/y.git')
  assert.equal(redactUrl('u:p@a.example:org/r'), '***@a.example:org/r')
  assert.equal(redactUrl('https://u:p@a/x https://v:q@b/y'), 'https://***@a/x https://***@b/y')
  assert.equal(redactUrl('git@gitlab.example:org/repo.git'), 'git@gitlab.example:org/repo.git')
  assert.equal(redactUrl('https://ghp_secret@github.corp/x/y.git'), 'https://***@github.corp/x/y.git')
  // Userinfo in a URL with a scheme goes whether or not it holds a colon, so an ssh URL loses a
  // harmless `git@` too; the host, which is what the reason is about, stays.
  assert.equal(redactUrl('ssh://git@gitlab.example/org/repo.git'), 'ssh://***@gitlab.example/org/repo.git')
})

test('a credential in a remote URL never reaches the files on disk either', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  const token = 'ghp_' + 'a'.repeat(30)
  git(repo, 'remote', 'set-url', 'origin', `https://${token}@git.example.invalid/x/y.git`)
  cli(dir, 'new', 'widget', repo, '--no-network')
  for (const f of [join(dir, 'widget', 'profile.md'), join(dir, 'widget', 'detected.json')]) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), new RegExp(token), f)
  }
})

test('workflow jobs and triggers are read without a YAML library', () => {
  const w = parseWorkflow('name: CI\non:\n  pull_request:\n  push:\njobs:\n  build:\n    name: Build and test\n    runs-on: x\n  lint:\n    runs-on: y\n')
  assert.deepEqual(w, { name: 'CI', triggers: ['pull_request', 'push'], jobs: [{ id: 'build', name: 'Build and test' }, { id: 'lint', name: null }] })
})

test('merge authority defaults to unconfirmed and no answer means TODO', () => {
  const det = { name: 'r', path: '/x/r', measured: '2026-10-06', mainBranch: { value: 'main' }, workflows: [],
    toolchain: { packages: [], generated: [], derivedUnknown: [] }, integrateMain: { value: null, reason: 'n' } }
  const md = render({ name: 'p', globs: ['*/r'], dets: [det], answers: {}, today: '2026-10-06' })
  assert.match(md, /\| `\*\*` everything \| `unconfirmed` \|/)
  assert.match(md, /- Integrating main: TODO/)
  assert.match(md, /## owner proxy\n\nnone/)
  assert.ok(questions([det], {}).find(q => q.id === 'mergeAuthority').options[0].value === 'unconfirmed')
})

test('credentials are recognised', () => {
  assert.ok(secretIn('token ghp_' + 'a'.repeat(30)))
  assert.ok(secretIn('sk-ant-api03-' + 'a'.repeat(30)))
  assert.equal(secretIn('github_pat_' + 'a'.repeat(30)), 'GitHub token')
  assert.equal(secretIn('ATATT' + 'a'.repeat(30)), 'Atlassian token')
  assert.equal(secretIn('sk_live_' + 'a'.repeat(30)), 'API key')
  assert.equal(secretIn('Test users: 1Password item "QA team"'), null)
  // Known token formats only, by design: a plain password passes rather than every long word
  // being refused. The profile names where a secret lives, and a human reads what they type.
  assert.equal(secretIn('the staging password is hunter2'), null)
})

test('end to end: new refuses to launch, answers make it launch-safe, drift reads the repo', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  const first = cli(dir, 'new', 'widget', repo, '--no-network', '--force')
  assert.equal(first.code, 4, first.out)
  const md = () => readFileSync(join(dir, 'widget', 'profile.md'), 'utf8')
  assert.match(md(), /`<KEY>-<number>-<details>` — 5 of 5 remote branches/)
  assert.match(md(), /\| `widget` \| lint \| `npm run lint` \|/)
  assert.match(md(), /`npm run test:e2e`/)

  for (const a of [['tracker.kind', 'jira'], ['identity.jiraKey', 'WID'], ['tracker.site', 'example.atlassian.net'],
    ['tracker.startStatus', 'In', 'Progress'], ['branching.integrateMain', 'rebase'], ['runPolicy.dayCeiling', '5'],
    ['runPolicy.maxParallel', '1'], ['inviolables', 'none'], ['escalation.human', 'Tech', 'lead'], ['escalation.doubtLog', 'doubts.md']]) {
    const r = cli(dir, 'answer', 'widget', ...a)
    // 4 while the profile is still incomplete, 0 once it is not; anything else is a refusal.
    assert.ok([0, 4].includes(r.code), `${a[0]}: ${r.code} ${r.out}`)
  }
  assert.equal(cli(dir, 'answer', 'widget', 'gates', 'pipeline green').code, 2)
  assert.equal(cli(dir, 'answer', 'widget', 'mergeAuthority', 'maybe').code, 2)
  const agent = cli(dir, 'answer', 'widget', 'mergeAuthority', 'agent')
  assert.equal(agent.code, 3)
  assert.match(agent.out, /only by a human running `ask` in a terminal/)
  const last = cli(dir, 'answer', 'widget', 'gates', 'check: *')
  assert.equal(last.code, 0, last.out)
  const piped = cliWith({ input: '\n3\n' }, dir, 'ask', 'widget')
  assert.match(piped.out, /only by a human running `ask` in a terminal — asked again/)
  assert.ok(!JSON.parse(readFileSync(join(dir, 'widget', 'answers.json'), 'utf8')).mergeAuthority)
  assert.match(md(), /Start status: `In Progress`/)

  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc' } }))
  const drift = cli(dir, 'drift', 'widget', '--no-network')
  assert.equal(drift.code, 5, drift.out)
  assert.match(drift.out, /detected `npm run typecheck` is not in the profile/)
})

test('a render names the hand edits it overwrites, and nothing when there are none', () => {
  const p = onboarded()
  assert.doesNotMatch(cli(p.dir, 'render', 'widget').out, /hand edits/)
  writeFileSync(p.md, p.read().replace('## known issues\n\n- TODO', '## known issues\n\n- the login page is flaky'))
  const r = cli(p.dir, 'render', 'widget')
  assert.match(r.out, /hand edits are being overwritten in known issues; delete the `onboarding: generated` line first/)
  assert.doesNotMatch(r.out, /overwritten in [^\n]*release/)
  assert.match(p.read(), /## known issues\n\n- TODO/)
  assert.doesNotMatch(cli(p.dir, 'render', 'widget').out, /hand edits/)
})

test('a hand-written profile is never overwritten', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  mkdirSync(join(dir, 'widget'))
  writeFileSync(join(dir, 'widget', 'profile.md'), '---\nprofile: widget\n---\n')
  assert.equal(cli(dir, 'new', 'widget', repo, '--no-network', '--force').code, 3)
  assert.equal(readFileSync(join(dir, 'widget', 'profile.md'), 'utf8'), '---\nprofile: widget\n---\n')
})

test('two review bots get two gate names', () => {
  const det = { name: 'r', path: '/x/r', measured: '2026-10-06', mainBranch: { value: 'main' }, workflows: [],
    toolchain: { packages: [], generated: [], derivedUnknown: [] }, integrateMain: { value: null, reason: 'n' } }
  const md = render({ name: 'p', globs: ['*/x/r'], dets: [det], answers: { gates: ['bot: coderabbitai[bot]', 'bot: copilot'] }, today: '2026-10-06' })
  assert.match(md, /\| review-coderabbitai \|/)
  assert.match(md, /\| review-copilot \|/)
})

test('a generated profile carries the marker, and losing it stops every writer', () => {
  const p = onboarded()
  assert.match(p.read(), /^onboarding: generated/m)
  const hand = p.read().replace(/^onboarding: generated.*\n/m, '')
  writeFileSync(p.md, hand)
  assert.equal(cli(p.dir, 'answer', 'widget', 'runPolicy.dayCeiling', '9').code, 3)
  assert.equal(cli(p.dir, 'render', 'widget').code, 3)
  assert.equal(p.read(), hand)
})

test('answers that are malformed, multi-line or credentials are refused and not stored', () => {
  const p = onboarded()
  const before = p.answers()
  for (const a of [['branching.integrateMain', 'squash'], ['tracker.kind', 'github'], ['runPolicy.dayCeiling', '0'],
    ['inviolables', 'Never deploy on Friday'], ['tracker.site', 'x\n\n## owner proxy\n- Proxy: `p`'], ['escalation.human', 'a | b']]) {
    assert.equal(cli(p.dir, 'answer', 'widget', ...a).code, 2, a.join(' '))
  }
  assert.equal(cli(p.dir, 'answer', 'widget', 'escalation.human', 'ghp_' + 'a'.repeat(30)).code, 3)
  assert.equal(p.answers(), before)
  assert.equal(cli(p.dir, 'answer', 'widget', '../x', 'gates', 'check: *').code, 2)
})

test('questions --json lists the open decisions and drops answered ones', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  cli(dir, 'new', 'widget', repo, '--no-network')
  const open = () => JSON.parse(cli(dir, 'questions', 'widget', '--json').out)
  const ma = open().find(q => q.id === 'mergeAuthority')
  assert.equal(ma.options[0].value, 'unconfirmed')
  assert.ok(open().some(q => q.id === 'branching.integrateMain' && q.required))
  cli(dir, 'answer', 'widget', 'branching.integrateMain', 'rebase')
  assert.ok(!open().some(q => q.id === 'branching.integrateMain'))
})

test('ask re-asks a refused answer and re-renders', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  cli(dir, 'new', 'widget', repo, '--no-network')
  const first = JSON.parse(cli(dir, 'questions', 'widget', '--json').out)[0]
  assert.equal(first.id, 'tracker.kind')
  const r = cliWith({ input: 'bogus\n1\n\n' }, dir, 'ask', 'widget')
  assert.equal(r.code, 4, r.out)
  assert.match(r.out, /asked again/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'widget', 'answers.json'), 'utf8'))['tracker.kind'], 'jira')
})

test('ask re-renders the profile after every answer, not only when it ends', async () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  cli(dir, 'new', 'widget', repo, '--no-network')
  const md = join(dir, 'widget', 'profile.md')
  assert.doesNotMatch(readFileSync(md, 'utf8'), /- Kind: `jira`/)
  const child = spawn(process.execPath, [CLI, 'ask', 'widget'],
    { env: { ...process.env, TILLER_PROFILES_DIR: dir, ONBOARD_TODAY: '2026-10-06' }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.resume(); child.stderr.resume()
  try {
    child.stdin.write('1\n')
    // The answer has to reach the profile while the child is still at the next question: a render
    // that only happened on exit would leave an interrupted session with a stale profile.
    const until = Date.now() + 30000
    while (!/- Kind: `jira`/.test(readFileSync(md, 'utf8')) && child.exitCode === null && Date.now() < until) await delay(50)
    assert.match(readFileSync(md, 'utf8'), /- Kind: `jira`/)
    assert.equal(child.exitCode, null, 'ask exited before the profile was re-read')
  } finally {
    child.stdin.end()
    await once(child, 'exit')
  }
})

test('new refuses a repo another profile already claims, unless forced', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  mkdirSync(join(dir, 'other'))
  writeFileSync(join(dir, 'other', 'profile.md'), '---\nprofile: other\nrepo_globs:\n  - "*/widget"\n---\n')
  const r = cli(dir, 'new', 'widget', repo, '--no-network')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /already resolves to .*other\/profile\.md/)
  assert.equal(cli(dir, 'new', 'widget', repo, '--no-network', '--force').code, 4)
})

test('drift reads only, and reports what it could not compare', () => {
  const p = onboarded()
  const files = ['profile.md', 'detected.json', 'answers.json'].map(f => join(p.dir, 'widget', f))
  const snap = () => files.map(f => readFileSync(f, 'utf8'))
  const before = snap()
  const clean = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(clean.code, 0, clean.out)
  assert.match(clean.out, /^no drift in what was compared$/m)
  assert.match(clean.out, /note: .*--no-network/)
  assert.match(clean.out, /note: \d+ TODO\(s\) left/)
  assert.deepEqual(snap(), before)

  const stale = cliWith({ today: '2027-06-01' }, p.dir, 'drift', 'widget', '--no-network')
  assert.equal(stale.code, 5)
  assert.match(stale.out, /stale: .*measured more than 90 days ago/)

  writeFileSync(join(p.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:e2e': 'playwright test' } }))
  assert.match(cli(p.dir, 'drift', 'widget', '--no-network').out, /calls a script lint that .* no longer has/)

  writeFileSync(join(p.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', 'test:e2e': 'playwright test' } }))
  // A hand-written row without backticks is still a row, as it is for profile-facts.sh.
  writeFileSync(p.md, p.read().replace(/^\| `widget` \| `([^`]+)` \| (.*)$/m, '| widget | $1 | $2'))
  const plain = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(plain.code, 0, plain.out)
  assert.doesNotMatch(plain.out, /no repo rows/)

  writeFileSync(p.md, p.read().replace(/^## repos\n[\s\S]*?(?=^## )/m, '## repos\n\nsee the wiki\n\n'))
  const none = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(none.code, 5)
  assert.match(none.out, /no repo rows parsed/)
})

// A `gh` on PATH answering for acme/widget: one ruleset check, classic protection hidden (403),
// coderabbitai on three PRs. GH_FAIL names an endpoint fragment that fails instead.
function ghStub(protection = 'echo "HTTP 403: Resource not accessible" >&2; exit 1') {
  const bin = tmp('onboard-gh-')
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
[ "$1" = auth ] && exit 0
[ -n "$GH_FAIL" ] && [[ "$2" == *"$GH_FAIL"* ]] && { echo "HTTP 502" >&2; exit 1; }
case "$2" in
  repos/acme/widget/rules/branches/main) echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"build"}]}}]' ;;
  repos/acme/widget/branches/main/protection/required_status_checks) ${protection} ;;
  repos/acme/widget) echo '{"description":"Widget | app","allow_squash_merge":true}' ;;
  repos/acme/widget/environments) echo '{"environments":[{"name":"staging"}]}' ;;
  repos/acme/widget/pulls*) echo '[{"number":1},{"number":2},{"number":3}]' ;;
  *reviews*|*comments*) echo '[{"user":{"login":"coderabbitai[bot]","type":"Bot"}}]' ;;
  *) echo "HTTP 404: Not Found" >&2; exit 1 ;;
esac
`)
  chmodSync(join(bin, 'gh'), 0o755)
  return { PATH: `${bin}:${process.env.PATH}` }
}

function githubFixture() {
  const f = fixtureRepo()
  git(f.repo, 'remote', 'set-url', 'origin', 'git@github.com:acme/widget.git')
  return f
}

test('forge facts: a hidden branch protection is unknown, never an empty list', () => {
  const { repo } = githubFixture()
  const dir = profilesDir()
  cliWith({ env: ghStub() }, dir, 'new', 'widget', repo)
  const det = JSON.parse(readFileSync(join(dir, 'widget', 'detected.json'), 'utf8')).repos[0]
  assert.equal(det.forge.requiredChecks.value, null)
  assert.match(det.forge.requiredChecks.reason, /403/)
  assert.deepEqual(det.forge.reviewBots.value, [{ login: 'coderabbitai[bot]', prs: 3 }])
  assert.match(readFileSync(join(dir, 'widget', 'profile.md'), 'utf8'), /\| `widget` \| `[^`]+` \| Widget  ?app \| `main` \|/)
})

test('forge facts: readable checks become gate candidates, and drift compares them', () => {
  const { repo } = githubFixture()
  const dir = profilesDir()
  const env = ghStub('echo \'{"contexts":["lint-ci"]}\'')
  cliWith({ env }, dir, 'new', 'widget', repo)
  const gates = JSON.parse(cliWith({ env }, dir, 'questions', 'widget', '--json').out).find(q => q.id === 'gates')
  const values = gates.options.map(o => o.value)
  for (const v of ['check: build', 'check: lint-ci', 'bot: coderabbitai']) assert.ok(values.includes(v), values.join(', '))
  cliWith({ env }, dir, 'answer', 'widget', 'gates', 'check: build')
  const drift = cliWith({ env }, dir, 'drift', 'widget')
  assert.equal(drift.code, 5)
  assert.match(drift.out, /required check `lint-ci` on main is not a declared gate/)
  assert.match(drift.out, /review bot `coderabbitai` active on 3 recent PRs is not a declared gate/)
  assert.doesNotMatch(drift.out, /`build` on main/)
  const failed = cliWith({ env: { ...env, GH_FAIL: 'comments' } }, dir, 'drift', 'widget')
  assert.match(failed.out, /note: .*review bots not compared — 3 review\/comment read\(s\) failed/)
  // A longer declared name is a different gate: `lint-ci` is not answered by `lint-ci-extended`.
  cliWith({ env }, dir, 'answer', 'widget', 'gates', 'check: lint-ci-extended', 'bot: coderabbitai-preview')
  const wider = cliWith({ env }, dir, 'drift', 'widget')
  assert.equal(wider.code, 5)
  assert.match(wider.out, /required check `lint-ci` on main is not a declared gate/)
  assert.match(wider.out, /review bot `coderabbitai` active on 3 recent PRs is not a declared gate/)
})

test('a directory that is not a clone is refused with its reason, not a stack trace', () => {
  const dir = profilesDir()
  const plain = tmp('onboard-plain-')
  const r = cli(dir, 'new', 'widget', plain, '--no-network', '--force')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /not a git repository/)
  assert.doesNotMatch(r.out, /at .*detect\.mjs/)
  // And the same clone going missing between two renders.
  const p = onboarded()
  rmSync(p.repo, { recursive: true, force: true })
  const refresh = cli(p.dir, 'render', 'widget', '--refresh', '--no-network')
  assert.equal(refresh.code, 3, refresh.out)
  assert.match(refresh.out, /--refresh: not a git repository/)
})

test('render --refresh re-detects, and needs detected facts to exist', () => {
  const p = onboarded()
  writeFileSync(join(p.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc' } }))
  assert.ok([0, 4].includes(cli(p.dir, 'render', 'widget', '--refresh', '--no-network').code))
  assert.match(p.read(), /`npm run typecheck`/)
  assert.match(readFileSync(join(p.dir, 'widget', 'detected.json'), 'utf8'), /typecheck/)
  rmSync(join(p.dir, 'widget', 'detected.json'))
  assert.equal(cli(p.dir, 'render', 'widget', '--refresh', '--no-network').code, 3)
})

test('new keeps answers only for the same repos', () => {
  const p = onboarded()
  const other = fixtureRepo()
  const r = cli(p.dir, 'new', 'widget', other.repo, '--no-network')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /already has \d+ answer\(s\) for other repos/)
  assert.match(cli(p.dir, 'new', 'widget', p.repo, '--no-network').out, /keeping \d+ earlier answer\(s\)/)
})

test('new refuses answers whose repos it cannot check, and --force keeps them', () => {
  const p = onboarded()
  const other = fixtureRepo()
  rmSync(join(p.dir, 'widget', 'detected.json'))
  const r = cli(p.dir, 'new', 'widget', other.repo, '--no-network')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /no .*widget\/detected\.json to say which repos they were made for/)
  const forced = cli(p.dir, 'new', 'widget', other.repo, '--no-network', '--force')
  assert.match(forced.out, /keeping \d+ earlier answer\(s\)/)
})

test('ask skips a blank answer and reaches the next question, and never writes a hand-written file', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  cli(dir, 'new', 'widget', repo, '--no-network')
  const r = cliWith({ input: '\n1\n' }, dir, 'ask', 'widget')
  assert.match(r.out, /skipped/)
  const answers = JSON.parse(readFileSync(join(dir, 'widget', 'answers.json'), 'utf8'))
  assert.equal(answers['tracker.kind'], undefined)
  assert.equal(Object.keys(answers).filter(k => !k.startsWith('_')).length, 1)
  const md = join(dir, 'widget', 'profile.md')
  const hand = readFileSync(md, 'utf8').replace(/^onboarding: generated.*\n/m, '')
  writeFileSync(md, hand)
  assert.equal(cliWith({ input: '1\n' }, dir, 'ask', 'widget').code, 3)
  assert.equal(readFileSync(md, 'utf8'), hand)
})

test('drift names a missing clone and a changed main branch', () => {
  const p = onboarded()
  writeFileSync(p.md, p.read().replace(/(\| `widget` \| `[^`]+` \|[^|]*\| )`main`/, '$1`trunk`'))
  const changed = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(changed.code, 5, changed.out)
  assert.match(changed.out, /widget: main is main on origin\/HEAD, profile says trunk/)
  writeFileSync(p.md, p.read().replace(/(\| `widget` \| )`[^`]+`/, '$1`/nowhere/widget`'))
  const missing = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(missing.code, 5, missing.out)
  assert.match(missing.out, /local path \/nowhere\/widget does not exist/)
})

test('drift fails on a lockfile missing from the profile, and on a stale measurement', () => {
  const p = onboarded()
  assert.match(p.read(), /`package-lock\.json`/)
  writeFileSync(p.md, p.read().replace(/^\| `widget` \| `package-lock\.json` \| [^\n]*\n/m, ''))
  const lock = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(lock.code, 5, lock.out)
  assert.match(lock.out, /widget: lockfile `package-lock\.json` is not in ## generated files/)

  const fresh = onboarded()
  // Measured 2026-10-06; a day later nothing is stale at the default 90 days, everything is at 0.
  const far = (days) => cliWith({ today: '2026-10-07' }, fresh.dir, 'drift', 'widget', '--no-network', ...days)
  assert.equal(far([]).code, 0, far([]).out)
  const stale = far(['--stale-days', '0'])
  assert.equal(stale.code, 5, stale.out)
  assert.match(stale.out, /stale: \d+ fact\(s\) measured more than 0 days ago \(oldest 2026-10-06\)/)
})

test('a repo whose lockfile is not in the clone says TODO, never "no test script detected"', () => {
  const { repo } = fixtureRepo()
  rmSync(join(repo, 'package-lock.json'))
  writeFileSync(join(repo, '.gitignore'), 'package-lock.json\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', '[WID-7] chore: ignore the lockfile')
  const dir = profilesDir()
  const r = cli(dir, 'new', 'widget', repo, '--no-network')
  assert.equal(r.code, 4, r.out)
  const md = readFileSync(join(dir, 'widget', 'profile.md'), 'utf8')
  // `none` here would make profile-facts.sh skip the requirement entirely: a profile launch-safe on
  // a fact nobody measured.
  assert.match(md, /## test toolchain\n\nTODO — no lockfile beside `widget\/package\.json`/)
  assert.doesNotMatch(md, /no test script detected/)
})

test('a credential among the detected facts stops the write, on the way in and on the way out', () => {
  const { base, repo } = fixtureRepo()
  const token = 'ghp_' + 'b'.repeat(30)
  const tainted = join(base, `widget-${token}`)
  renameSync(repo, tainted)
  const dir = profilesDir()
  const r = cli(dir, 'new', 'widget', tainted, '--no-network')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /refusing to write .*widget\/detected\.json: a detected value looks like a credential \(GitHub token\)/)
  assert.ok(!existsSync(join(dir, 'widget', 'detected.json')))

  // Nothing re-checks detected.json once it is on disk, so the rendered text is checked as well:
  // these are two guards on two paths, not one guard written twice.
  const p = onboarded()
  const stored = JSON.parse(readFileSync(join(p.dir, 'widget', 'detected.json'), 'utf8'))
  stored.project = `proj-${token}`
  writeFileSync(join(p.dir, 'widget', 'detected.json'), JSON.stringify(stored))
  const re = cli(p.dir, 'render', 'widget')
  assert.equal(re.code, 3, re.out)
  assert.match(re.out, /refusing to write a profile containing what looks like a credential \(GitHub token\)/)
  assert.doesNotMatch(p.read(), new RegExp(token))
})

test('a flag that takes a value refuses a missing one, and --stale-days refuses a non-number', () => {
  const p = onboarded()
  const bad = cli(p.dir, 'drift', 'widget', '--no-network', '--stale-days', 'soon')
  assert.equal(bad.code, 2, bad.out)
  assert.match(bad.out, /--stale-days: a whole number of days/)
  // The flag must not eat the next flag: that would both disable the staleness gate and put the
  // network back on in a command that asked for neither.
  const eaten = cliWith({ today: '2027-06-01' }, p.dir, 'drift', 'widget', '--stale-days', '--no-network')
  assert.equal(eaten.code, 2, eaten.out)
  assert.match(eaten.out, /--stale-days needs a value/)
  assert.equal(cli(p.dir, 'drift', 'widget', '--no-network', '--stale-days').code, 2)
})

test('new refuses a repo whose .tiller-profile names a profile that is not there', () => {
  const { repo } = fixtureRepo()
  const dir = profilesDir()
  writeFileSync(join(repo, '.tiller-profile'), 'ghost\n')
  const r = cli(dir, 'new', 'widget', repo, '--no-network')
  assert.equal(r.code, 3, r.out)
  assert.match(r.out, /no profile 'ghost'; fix it, or --force/)
  assert.ok([0, 4].includes(cli(dir, 'new', 'widget', repo, '--no-network', '--force').code))
})

test('a jira key is an uppercase key', () => {
  const p = onboarded()
  assert.equal(cli(p.dir, 'answer', 'widget', 'identity.jiraKey', 'wid', 'project').code, 2)
})

test('sibling profiles offer their values, never their placeholders', () => {
  const v = siblingValues(['- Site: `a.atlassian.net`\n- Start status: `In Progress`\n- Human: `Tech lead`', '- Site: `TODO`\n- Start status: `<status a started ticket moves to>`'])
  assert.deepEqual(v, { site: ['a.atlassian.net'], startStatus: ['In Progress'], mergedStatus: [], human: ['Tech lead'] })
})

// One repo per manifest shape, committed so `git ls-files` sees it.
function toolchainRepo(files) {
  const repo = tmp('onboard-toolchain-')
  git(repo, 'init', '-q', '-b', 'main')
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(repo, dirname(f)), { recursive: true }); writeFileSync(join(repo, f), body) }
  git(repo, 'add', '-A')
  return detect(repo, { network: false, today: '2026-10-06' }).toolchain
}

test('toolchain detection per ecosystem, with a cd prefix below the root', () => {
  const cases = [
    [{ Gemfile: '', 'Gemfile.lock': '    rspec-core (3.13.0)\n    rubocop (1.60.0)\n' },
      { ecosystem: 'bundler', install: 'bundle install', test: [['unit', 'bundle exec rspec']], static: [['lint', 'bundle exec rubocop']] }, [['Gemfile.lock', 'bundle install']]],
    [{ 'api/pyproject.toml': '[tool.pytest]\n[tool.ruff]\n[tool.mypy]\n', 'api/uv.lock': '' },
      { ecosystem: 'uv', install: 'cd api && uv sync --frozen', test: [['unit', 'cd api && uv run pytest']], static: [['lint', 'cd api && uv run ruff check .'], ['typecheck', 'cd api && uv run mypy .']] }, [['api/uv.lock', 'cd api && uv lock']]],
    [{ 'pyproject.toml': 'pytest\n', 'poetry.lock': '' },
      { ecosystem: 'poetry', install: 'poetry install --no-root', test: [['unit', 'poetry run pytest']], static: [] }, [['poetry.lock', 'poetry lock']]],
    [{ 'go.mod': 'module x\n', 'go.sum': '' },
      { ecosystem: 'go', install: 'go mod download', test: [['unit', 'go test ./...']], static: [['vet', 'go vet ./...']] }, [['go.sum', 'go mod tidy']]],
    [{ 'Cargo.toml': '[package]\n' },
      { ecosystem: 'cargo', install: 'cargo fetch', test: [['unit', 'cargo test']], static: [['lint', 'cargo clippy -- -D warnings']] }, []],
  ]
  for (const [files, want, generated] of cases) {
    const t = toolchainRepo(files)
    assert.equal(t.packages.length, 1, JSON.stringify(t))
    const { ecosystem, install, test: lanes, static: checks } = t.packages[0]
    assert.deepEqual({ ecosystem, install, test: lanes, static: checks }, want)
    assert.deepEqual(t.generated, generated)
  }
  const pnpm = toolchainRepo({ 'web/package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }), 'web/pnpm-lock.yaml': '' })
  assert.deepEqual(pnpm.packages[0].test, [['unit', 'cd web && pnpm test']])
  assert.deepEqual(pnpm.packages[0].static, [['lint', 'cd web && pnpm run lint']])
  const yarn = toolchainRepo({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' })
  assert.deepEqual(yarn.packages[0].test, [['unit', 'yarn test']])
  // A workspace member without its own lockfile is installed by the root, so it is not a package of its own.
  const ws = toolchainRepo({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'package-lock.json': '{}', 'packages/a/package.json': JSON.stringify({ scripts: { test: 'jest' } }) })
  assert.deepEqual(ws.packages.map(p => p.dir), ['.'])
})

test('two packages in one repo get distinct check names', () => {
  const repo = tmp('onboard-two-pkg-')
  const files = {
    'package.json': JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }),
    'package-lock.json': '{}',
    'packages/ui/package.json': JSON.stringify({ scripts: { test: 'jest', lint: 'eslint .' } }),
    'packages/ui/package-lock.json': '{}',
  }
  git(repo, 'init', '-q', '-b', 'main')
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(repo, dirname(f)), { recursive: true }); writeFileSync(join(repo, f), body) }
  git(repo, 'add', '-A')
  const det = detect(repo, { network: false, today: '2026-10-06' })
  const md = render({ name: 'widget', project: 'Widget', globs: [], dets: [det], answers: {}, today: '2026-10-06' })
  for (const heading of ['worktree setup', 'static checks']) {
    const body = md.split(`## ${heading}`)[1].split('\n## ')[0]
    const names = body.split('\n').filter(l => l.startsWith('| `')).map(l => l.split('|')[2].trim())
    assert.ok(names.length >= 2, `${heading}: ${body}`)
    assert.equal(new Set(names).size, names.length, `${heading}: ${names.join(', ')}`)
  }
})

function renameTo(repo, name) {
  const to = join(dirname(repo), name)
  renameSync(repo, to)
  return to
}

test('two repos get cd-prefixed commands, and drift checks scripts in the package the command enters', () => {
  const a = fixtureRepo()
  const b = fixtureRepo()
  b.repo = renameTo(b.repo, 'gadget')
  mkdirSync(join(b.repo, 'web'))
  writeFileSync(join(b.repo, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }))
  writeFileSync(join(b.repo, 'web', 'package-lock.json'), '{}')
  git(b.repo, 'add', '-A'); git(b.repo, 'commit', '-qm', 'web')
  const dir = profilesDir()
  const r = cli(dir, 'new', 'pair', a.repo, b.repo, '--no-network', '--force')
  assert.ok([0, 4].includes(r.code), r.out)
  const md = join(dir, 'pair', 'profile.md')
  const text = readFileSync(md, 'utf8')
  assert.match(text, /`cd "[^"]+gadget" && cd web && npm test`/)
  assert.match(text, /^\| `gadget` `web` \| [^|]+ \| `cd web && npm run lint` \|$/m)
  const clean = cli(dir, 'drift', 'pair', '--no-network')
  assert.doesNotMatch(clean.out, /no longer has/, clean.out)

  writeFileSync(join(b.repo, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
  const removed = cli(dir, 'drift', 'pair', '--no-network')
  assert.equal(removed.code, 5, removed.out)
  assert.match(removed.out, /calls a script lint that .*web\/package\.json no longer has/)
})

test('drift resolves a relative cd against the repo, not the working directory', () => {
  const p = onboarded()
  mkdirSync(join(p.repo, 'web'))
  writeFileSync(join(p.repo, 'web', 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }))
  writeFileSync(p.md, p.read().replace(/^## static checks\n/m, '## static checks\n\n- extra: `cd web && npm run lint`\n'))
  const r = spawnSync(process.execPath, [CLI, 'drift', 'widget', '--no-network'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, TILLER_PROFILES_DIR: p.dir, ONBOARD_TODAY: '2026-10-06' } })
  assert.equal(r.status, 5, r.stdout + r.stderr)
  // The path named must be the repo's own: `<cwd>/web` would satisfy a looser pattern.
  assert.ok(r.stdout.includes(`calls a script lint that ${join(realpathSync(p.repo), 'web', 'package.json')} no longer has`), r.stdout)
  rmSync(join(p.repo, 'web', 'package.json'))
  const gone = spawnSync(process.execPath, [CLI, 'drift', 'widget', '--no-network'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, TILLER_PROFILES_DIR: p.dir, ONBOARD_TODAY: '2026-10-06' } })
  assert.equal(gone.status, 5, gone.stdout)
  assert.ok(gone.stdout.includes(`runs in ${join(realpathSync(p.repo), 'web')}, which has no package.json`), gone.stdout)
})

test('drift walks a command chain step by step, and says so when it cannot', () => {
  const p = onboarded()
  mkdirSync(join(p.repo, 'web'))
  writeFileSync(join(p.repo, 'web', 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }))
  const lines = ['- a: `cd web && npm run build && cd .. && npm run nope`',
    '- b: `npm run -w web build`', '- c: `cd $REPO/web && npm run build`', '- d: `cd web && npm run build`']
  writeFileSync(p.md, p.read().replace(/^## static checks\n/m, `## static checks\n\n${lines.join('\n')}\n`))
  const r = cli(p.dir, 'drift', 'widget', '--no-network')
  assert.equal(r.code, 5, r.out)
  // Each step runs where the cd's before it left it: `build` exists in web, `nope` is checked in the root.
  assert.ok(r.out.includes(`calls a script nope that ${join(realpathSync(p.repo), 'package.json')} no longer has`), r.out)
  assert.doesNotMatch(r.out, /script build /)
  // `-w` is a flag, not a script, and the member it names is not the directory the command stands in.
  assert.match(r.out, /note: command `npm run -w web build` not compared — it runs in a workspace member/)
  assert.doesNotMatch(r.out, /script -w/)
  // An unexpandable variable is a note; joining it literally would invent drift.
  assert.match(r.out, /note: command `cd \$REPO\/web && npm run build` not compared — `cd \$REPO\/web` is not a literal path/)
})

test('drift never lends one repo the commands of a missing sibling', () => {
  const a = fixtureRepo()
  const b = fixtureRepo()
  b.repo = renameTo(b.repo, 'gadget')
  const dir = profilesDir()
  assert.ok([0, 4].includes(cli(dir, 'new', 'pair', a.repo, b.repo, '--no-network', '--force').code))
  const md = join(dir, 'pair', 'profile.md')
  writeFileSync(md, readFileSync(md, 'utf8')
    .replace(/(\| `gadget` \| )`[^`]+`/, '$1`/nowhere/gadget`')
    .replace(/^## static checks\n/m, '## static checks\n\n- loose: `npm run nope`\n'))
  const r = cli(dir, 'drift', 'pair', '--no-network')
  assert.equal(r.code, 5, r.out)
  assert.match(r.out, /gadget: local path \/nowhere\/gadget does not exist/)
  assert.match(r.out, /note: command `npm run nope` not compared — no repo to run it in/)
  assert.doesNotMatch(r.out, /script nope/)
})

test('ask accepts mergeAuthority agent from a terminal', { skip: process.platform !== 'darwin' && 'script(1) flags differ off macOS' }, () => {
  const p = onboarded()
  // script(1) gives the child a pseudo-terminal; the sleeps let readline attach before input arrives.
  const sh = `(sleep 1; printf '\\n3\\n'; sleep 1) | script -q /dev/null "${process.execPath}" "${CLI}" ask widget`
  const r = spawnSync('bash', ['-c', sh], { encoding: 'utf8', env: { ...process.env, TILLER_PROFILES_DIR: p.dir, ONBOARD_TODAY: '2026-10-06' } })
  assert.equal(JSON.parse(p.answers()).mergeAuthority, 'agent', r.stdout + r.stderr)
  assert.match(p.read(), /\| `\*\*` everything \| `agent` \|/)
})

test('render re-checks a hand-edited answers.json, including the TTY-only merge authority', () => {
  const p = onboarded()
  const file = join(p.dir, 'widget', 'answers.json')
  const good = p.answers()
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), 'escalation.doubtLog': 'ghp_' + 'a'.repeat(36) }))
  const leak = cli(p.dir, 'render', 'widget')
  assert.equal(leak.code, 3)
  assert.match(leak.out, /looks like a credential \(GitHub token\)/)
  // A value carrying its own `## merge authority` heading is stopped as a control character, before
  // writeProfile's duplicate-heading guard behind it ever sees the text.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), 'escalation.doubtLog': 'x\n\n## merge authority\n\n| a | agent |' }))
  const twice = cli(p.dir, 'render', 'widget')
  assert.equal(twice.code, 3)
  assert.match(twice.out, /one line per value, no control characters/)
  // `agent` is typed at a terminal; writing it into the file by hand does not make it one.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), mergeAuthority: 'agent' }))
  const forged = cli(p.dir, 'render', 'widget')
  assert.equal(forged.code, 3)
  assert.match(forged.out, /set only by a human running `ask` in a terminal/)
  // A closed question still only takes its own options.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(good), 'branching.integrateMain': 'whatever' }))
  assert.equal(cli(p.dir, 'render', 'widget').code, 3)
  writeFileSync(file, good)
  assert.equal(cli(p.dir, 'render', 'widget').code, 0)
})

test('drift checks scripts in rows that name a repo by clone name, and survives a same-named directory', () => {
  const p = onboarded()
  const two = fixtureRepo()
  const md = p.read().replace(/^onboarding: generated\n/m, '')
    .replace(/(## repos\n[\s\S]*?\n)(\| `widget`[^\n]*\n)/, (_, head, row) => `${head}${row}${row.replace(/`widget`/, '`acme/other`').replace(p.repo, two.repo)}`)
    + '\n## extra\n\n| `other` | build | `npm run gone` |\n'
  writeFileSync(p.md, md)
  const cwd = tmp('onboard-cwd-')
  mkdirSync(join(cwd, 'widget'))
  const r = spawnSync(process.execPath, [CLI, 'drift', 'widget', '--no-network'], { cwd, encoding: 'utf8', env: { ...process.env, TILLER_PROFILES_DIR: p.dir, ONBOARD_TODAY: '2026-10-06' } })
  assert.equal(r.status, 5, r.stdout + r.stderr)
  assert.match(r.stdout, /calls a script gone that .*package\.json no longer has/)
})

const TEMPLATE = readFileSync(join(ROOT, 'profiles', '_template', 'profile.md'), 'utf8')
const bare = (extra = {}) => ({ name: 'r', path: '/x/r', measured: '2026-10-06', mainBranch: { value: 'main' }, workflows: [],
  toolchain: { packages: [], generated: [], derivedUnknown: [] }, integrateMain: { value: null, reason: 'n' }, ...extra })
const sectionOf = (md, h) => (new RegExp(`^## ${h}\\n\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(md) || [])[1]
const renderBare = (extra, answers = {}, template = TEMPLATE) =>
  render({ name: 'p', globs: [], dets: [bare(extra)], answers, today: '2026-10-06', template })

test('a rendered profile carries every template heading in the template order, worktree setup after the toolchain', () => {
  const md = renderBare()
  const want = TEMPLATE.match(/^## .*$/gm)
  assert.deepEqual(md.match(/^## .*$/gm).filter(h => want.includes(h)), want)
  assert.ok(md.indexOf('## worktree setup') > md.indexOf('## test toolchain'))
  assert.ok(md.indexOf('## worktree setup') < md.indexOf('## static checks'))
})

test('a template heading the generator does not know stops the render', () => {
  assert.throws(() => renderBare({}, {}, `${TEMPLATE}\n## mystery\n\nnone\n`), /## mystery/)
})

test('tools name each default role, and the tracker carries a QA statuses line', () => {
  const md = renderBare()
  for (const role of ['chat', 'docs', 'calendar', 'email']) assert.match(sectionOf(md, 'tools'), new RegExp(`^\\| ${role} \\| default \\| default \\|$`, 'm'))
  assert.doesNotMatch(sectionOf(md, 'tools'), /^\| tracker /m)
  assert.match(sectionOf(md, 'tracker'), /^- QA statuses: TODO/m)
})

test('commits follow the style measured on main, and an unread style is a required question', () => {
  const keys = { value: [{ key: 'ABC', count: 9 }] }
  const bracket = renderBare({ ticketKeys: keys, commitStyle: { value: 'x', kind: 'ticket-bracket', source: '9 of 9' } })
  assert.match(sectionOf(bracket, 'commits'), /^- Format: `\[<ticket>\] <type>\(<scope>\): <subject>`\n- Ticket from branch: `ABC-\[0-9\]\+`\n- Without ticket: `<type>\(<scope>\): <subject>`/m)
  const conventional = renderBare({ ticketKeys: keys, commitStyle: { value: 'x', kind: 'conventional', source: '9 of 9' } })
  assert.match(sectionOf(conventional, 'commits'), /^none — plain Conventional Commits, 9 of 9 \(measured 2026-10-06\)/)
  const colon = bare({ ticketKeys: keys, commitStyle: { value: 'x', kind: 'ticket-colon', source: '9 of 9' } })
  assert.match(sectionOf(render({ name: 'p', globs: [], dets: [colon], today: '2026-10-06', template: TEMPLATE }), 'commits'), /TODO/)
  assert.equal(questions([colon]).find(q => q.id === 'commits').required, true)
  assert.equal(questions([bare({ commitStyle: { value: 'x', kind: 'conventional', source: 's' } })]).find(q => q.id === 'commits').required, false)
  const answered = render({ name: 'p', globs: [], dets: [colon], answers: { commits: 'conventional' }, today: '2026-10-06', template: TEMPLATE })
  assert.match(sectionOf(answered, 'commits'), /^none — plain Conventional Commits/)
  assert.doesNotMatch(sectionOf(answered, 'conventions'), /Commits in/)
})

test('a fresh profile is launch-safe once the required answers are given', () => {
  const p = onboarded()
  const r = profileFacts(p.md, true)
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /Launch-safe\.\s*$/)
  assert.match(sectionOf(p.read(), 'commits'), /^- Ticket from branch: `WID-\[0-9\]\+`$/m)
})

test('new scaffolds the profile directory from the template', () => {
  const p = onboarded()
  const d = join(p.dir, 'widget')
  assert.equal(statSync(join(d, 'secrets.env')).mode & 0o777, 0o600)
  assert.match(readFileSync(join(d, 'leak-terms.txt'), 'utf8'), /^\\bwidget\\b$/m)
  for (const f of ['README.md', 'secrets.env.example', 'leak-terms.txt.example']) assert.ok(!existsSync(join(d, f)), f)
})

test('cases.json follows the merge authority until someone edits it', () => {
  const p = onboarded()
  const file = join(p.dir, 'widget', 'cases.json')
  const agrees = () => {
    const { mergeAuthority } = renderFacts(p.md)
    for (const c of JSON.parse(readFileSync(file, 'utf8')).cases) assert.equal(authorityOf(c.path, mergeAuthority), c.who)
  }
  agrees()
  assert.equal(cli(p.dir, 'answer', 'widget', 'mergeAuthority', 'human').code, 0)
  agrees()
  assert.match(readFileSync(file, 'utf8'), /"who": "human"/)
  const own = '{"cases":[{"path":"docs/x.md","who":"human"}]}\n'
  writeFileSync(file, own)
  cli(p.dir, 'answer', 'widget', 'mergeAuthority', 'unconfirmed')
  assert.equal(readFileSync(file, 'utf8'), own)
})

test('a repo on plain Conventional Commits renders commits none; a ticket-colon repo asks', () => {
  const conv = fixtureRepo((i) => `feat(core): change ${i}`)
  const dir = profilesDir()
  cli(dir, 'new', 'widget', conv.repo, '--no-network')
  assert.match(readFileSync(join(dir, 'widget', 'profile.md'), 'utf8'), /## commits\n\nnone — plain Conventional Commits/)

  const colon = fixtureRepo((i) => `WID-${i}: change ${i}`)
  const dir2 = profilesDir()
  cli(dir2, 'new', 'widget', colon.repo, '--no-network')
  const open = JSON.parse(cli(dir2, 'questions', 'widget', '--json').out)
  assert.ok(open.some(q => q.id === 'commits' && q.required))
  assert.equal(cli(dir2, 'answer', 'widget', 'commits', 'squash').code, 2)
  cli(dir2, 'answer', 'widget', 'commits', 'ticket-bracket')
  assert.match(readFileSync(join(dir2, 'widget', 'profile.md'), 'utf8'), /- Ticket from branch: `WID-\[0-9\]\+`/)
})

test('an unread branch convention is a required question, and the answer is rendered', () => {
  const unread = bare({ branchConvention: { value: null, reason: 'only 1 work branches to read' } })
  const q = questions([unread]).find(x => x.id === 'branching.convention')
  assert.equal(q.required, true)
  assert.ok(q.options.some(o => o.value === '<type>/<details>'))
  assert.equal(questions([bare({ branchConvention: { value: '`<KEY>-<number>`', source: 's' } })]).find(x => x.id === 'branching.convention').required, false)
  const md = render({ name: 'p', globs: [], dets: [unread], answers: { 'branching.convention': '<type>/<details>' }, today: '2026-10-06', template: TEMPLATE })
  assert.match(sectionOf(md, 'branching'), /^- Convention: `<type>\/<details>` — answered at onboarding$/m)
})
