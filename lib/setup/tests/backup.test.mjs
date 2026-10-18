// The backup offer inside the personal and project steps: a directory the wizard just created gets a
// private GitHub repository. git is real (the commit is inspected), gh is a stub whose sign-in is a
// file in the sandbox and whose account is sam-gh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANSWERS, calls, fixtureRepo, GENERATE, git, out, run, sandbox } from './sandbox.mjs'

const CLAUDE = `[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true}'`

function box({ gh = true, signedIn = true } = {}) {
  const sb = sandbox({ real: ['node', 'git', 'jq'], stubs: { claude: CLAUDE } })
  if (gh) {
    sb.stubGh = `case "$1 $2" in "auth status") [ -e "${sb.root}/gh-in" ] ;; "api user") echo sam-gh ;; esac`
    writeFileSync(join(sb.bin, 'gh'), `#!/bin/bash\necho "gh $*" >> "${sb.log}"\n${sb.stubGh}\n`, { mode: 0o755 })
  }
  if (signedIn) writeFileSync(join(sb.root, 'gh-in'), '')
  return sb
}
const ghCalls = sb => calls(sb).filter(c => c.startsWith('gh repo'))
const tracked = dir => spawnSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
const personalNew = (sb, backup) => run(sb, ['personal', 'new', 'sam'], { answers: { personal: { generate: GENERATE }, ...(backup === undefined ? {} : { backup: { personal: backup } }) } })
const projectNew = (sb, repo, { backup, answers = ANSWERS } = {}) =>
  run(sb, ['project', 'new', 'widget', repo], { answers: { project: { kind: 'code', answers, marker: false }, ...(backup === undefined ? {} : { backup: { project: backup } }) } })

test('personal new, gh signed in, backup accepted: first commit, then a private repository named by the rule', () => {
  const sb = box()
  const r = personalNew(sb, true)
  assert.equal(r.status, 0, out(r))
  const dir = join(sb.personal, 'sam')
  assert.ok(tracked(dir).some(f => f.startsWith('skills/')), 'the generated skills are committed')
  assert.deepEqual(ghCalls(sb), [`gh repo create sam-gh/tiller-personal-sam --private --source ${dir} --push`])
})

test('project new, backup accepted: secrets.env stays out of the commit, the repository is tiller-profiles-<name>', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const r = projectNew(sb, repo, { backup: true })
  assert.equal(r.status, 0, out(r))
  const dir = join(sb.profiles, 'widget')
  assert.ok(existsSync(join(dir, 'secrets.env')))
  assert.ok(tracked(dir).includes('profile.md'))
  assert.ok(!tracked(dir).includes('secrets.env'))
  assert.deepEqual(ghCalls(sb), [`gh repo create sam-gh/tiller-profiles-widget --private --source ${dir} --push`])
})

// Every line here resembles the rule, none is the exact line the template ships.
test('a profile whose .gitignore does not list secrets.env is refused: nothing committed, nothing pushed, the reason named', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const { gates, ...partial } = ANSWERS
  assert.equal(projectNew(sb, repo, { answers: partial }).status, 1)
  const dir = join(sb.profiles, 'widget')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n*.env\nsecrets.env.example\n')
  const r = projectNew(sb, repo, { backup: true })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /\.gitignore.*secrets\.env/)
  assert.deepEqual(ghCalls(sb), [])
  assert.ok(!existsSync(join(dir, '.git')))
})

test('--yes takes the default, which is yes', () => {
  const sb = box()
  const r = run(sb, ['personal', 'new', 'sam', '--yes'], { answers: { personal: { generate: GENERATE } } })
  assert.equal(r.status, 0, out(r))
  assert.equal(ghCalls(sb).length, 1)
})

test('backup declined: no repository, no git history', () => {
  const sb = box()
  const r = personalNew(sb, false)
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(ghCalls(sb), [])
  assert.ok(!existsSync(join(sb.personal, 'sam', '.git')))
})

for (const [why, opts] of [['gh is not installed', { gh: false }], ['gh is signed out', { signedIn: false }]]) {
  test(`${why}: no question, one line with the command for later`, () => {
    const sb = box(opts)
    const r = personalNew(sb)
    assert.equal(r.status, 0, out(r))
    assert.match(r.stdout, /gh repo create <account>\/tiller-personal-sam --private --source .* --push/)
    assert.deepEqual(ghCalls(sb), [])
  })
}

test('gh signed in, no terminal and no answer: exit 4 naming backup.personal', () => {
  const sb = box()
  const r = personalNew(sb)
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /backup\.personal/)
})

test('a directory that already has an origin is not offered a backup', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const { gates, ...partial } = ANSWERS
  assert.equal(projectNew(sb, repo, { answers: partial }).status, 1)
  const dir = join(sb.profiles, 'widget')
  git(dir, 'init', '-q')
  git(dir, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
  const r = projectNew(sb, repo)
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(ghCalls(sb), [])
  assert.doesNotMatch(out(r), /backup/i)
})

test('history already there: no second first commit, the repository is created from it', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const { gates, ...partial } = ANSWERS
  assert.equal(projectNew(sb, repo, { answers: partial }).status, 1)
  const dir = join(sb.profiles, 'widget')
  git(dir, 'init', '-q'); git(dir, 'add', 'profile.md'); git(dir, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'mine')
  const r = projectNew(sb, repo, { backup: true })
  assert.equal(r.status, 0, out(r))
  assert.equal(spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), '1')
  assert.equal(ghCalls(sb).length, 1)
})

test('a create that fails: exit 0 with the command to repeat by hand, not a stop', () => {
  const sb = box()
  writeFileSync(join(sb.bin, 'gh'), `#!/bin/bash\necho "gh $*" >> "${sb.log}"\n${sb.stubGh}\n[ "$1 $2" = "repo create" ] && exit 1\nexit 0\n`, { mode: 0o755 })
  const r = personalNew(sb, true)
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /still yours: .*gh repo create sam-gh\/tiller-personal-sam --private --source .* --push/)
})
