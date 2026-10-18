// The project step (`tiller project new|clone|ask`): onboard, new-profile and profile-facts are real,
// git is real (onboard reads the repository), gh is a stub that answers nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANSWERS, calls, fixtureRepo, git, out, REPO, run, sandbox, snapshot } from './sandbox.mjs'

const CLAUDE = `[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true}'`

const box = () => sandbox({ real: ['node', 'git', 'jq'], stubs: { claude: CLAUDE, gh: 'exit 1' } })

const newProject = (sb, repo, extra = {}) => run(sb, ['project', 'new', 'widget', repo], { answers: { project: { kind: 'code', answers: ANSWERS, marker: true, ...extra } } })
const check = (sb, name) => spawnSync('bash', [join(REPO, 'lib', 'profile-facts.sh'), '--check', '--profile', join(sb.profiles, name, 'profile.md')], { encoding: 'utf8' })

test('new: onboarded, answered, marked, launch-safe, and the next command named', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const r = newProject(sb, repo)
  assert.equal(r.status, 0, out(r))
  assert.equal(check(sb, 'widget').status, 0)
  assert.equal(readFileSync(join(repo, '.tiller-profile'), 'utf8'), 'widget\n')
  assert.match(r.stdout, /\.tiller-profile.*commit/)
  assert.match(r.stdout, /^done +project\b/m)
  assert.match(r.stdout, new RegExp(`cd ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && claude`))
})

test('new with the marker declined: no .tiller-profile, the profile still names the repo by glob', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const r = newProject(sb, repo, { marker: false })
  assert.equal(r.status, 0, out(r))
  assert.ok(!existsSync(join(repo, '.tiller-profile')))
  assert.match(readFileSync(join(sb.profiles, 'widget', 'profile.md'), 'utf8'), /"\*\/src\/widget"/)
})

test('new with decisions left open: stops with the refusal and `tiller project ask <name>`', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const { gates, ...partial } = ANSWERS
  const r = newProject(sb, repo, { answers: partial })
  assert.equal(r.status, 1, out(r))
  assert.match(out(r), /would be refused/)
  assert.match(r.stderr, /resume: +tiller project ask widget$/m)
  assert.ok(existsSync(join(sb.profiles, 'widget', 'profile.md')), 'the profile is kept for ask')
})

test('new given a git URL instead of a directory: cloned next to where tiller runs, then onboarded', () => {
  const sb = box()
  const { origin } = fixtureRepo(sb)
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd)
  const r = run(sb, ['project', 'new', 'widget', `file://${origin}`], { cwd, answers: { project: { kind: 'code', answers: ANSWERS, marker: true } } })
  assert.equal(r.status, 0, out(r))
  assert.equal(readFileSync(join(cwd, 'widget', '.tiller-profile'), 'utf8'), 'widget\n')
})

test('new without a terminal or a project name is exit 4 naming it', () => {
  const sb = box()
  const r = run(sb, ['project'], { answers: { project: { mode: 'new', kind: 'code' } } })
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /project\.name/)
})

test('new under --yes: a project name has no default, so it is still exit 4 naming it', () => {
  const r = run(box(), ['project', '--yes'], { answers: { project: { mode: 'new' } } })
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /project\.name/)
})

test('new beside a launch-safe profile: the named profile is the one that has to be launch-safe', () => {
  const sb = box()
  assert.equal(newProject(sb, fixtureRepo(sb).repo).status, 0)
  const { repo } = fixtureRepo(sb, 'gadget')
  const r = run(sb, ['project', 'new', 'gadget', repo], { answers: { project: { kind: 'code', answers: ANSWERS, marker: false } } })
  assert.equal(r.status, 0, out(r))
  assert.ok(existsSync(join(sb.profiles, 'gadget', 'profile.md')), 'gadget was onboarded, not skipped')
})

// A profile repository as the backup step would leave it: the generated profile, its skills, and a
// .gitignore that keeps secrets.env out.
function profileRepo(sb, answers = ANSWERS) {
  const { repo } = fixtureRepo(sb)
  assert.equal(newProject(sb, repo, { answers }).status, answers === ANSWERS ? 0 : 1)
  const dir = join(sb.profiles, 'widget')
  mkdirSync(join(dir, 'skills', 'widget-hi'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'widget-hi', 'SKILL.md'), '---\nname: widget-hi\ndescription: x\n---\n')
  writeFileSync(join(dir, 'secrets.env.example'), 'TRACKER_TOKEN=\nFORGE_TOKEN=\nSITE=example.org\n')
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A')
  git(dir, '-c', 'user.email=t@t.invalid', '-c', 'user.name=t', 'commit', '-qm', 'profile')
  const bare = join(sb.root, 'src', 'tiller-profiles-widget.git')
  git(sb.root, 'clone', '-q', '--bare', dir, bare)
  return bare
}

test('clone: into profiles/<name>, secrets.env from the example at 600 with the empty keys listed, skills linked', () => {
  const bare = profileRepo(box())
  const sb = box()
  const r = run(sb, ['project', 'clone', `file://${bare}`])
  assert.equal(r.status, 0, out(r))
  const secrets = join(sb.profiles, 'widget', 'secrets.env')
  assert.equal(statSync(secrets).mode & 0o777, 0o600)
  assert.match(r.stdout, /TRACKER_TOKEN, FORGE_TOKEN/)
  assert.doesNotMatch(r.stdout, /SITE/)
  assert.ok(lstatSync(join(sb.skills, 'widget-hi')).isSymbolicLink())
  assert.equal(realpathSync(join(sb.skills, 'widget-hi')), realpathSync(join(sb.profiles, 'widget', 'skills', 'widget-hi')))
  assert.match(r.stdout, /^done +project\b/m)
})

// The profile is cloned but not launch-safe, so the step runs over it instead of reporting ok.
test('clone over a profile already there: no second clone, secrets.env kept, the refusal printed', () => {
  const { gates, ...partial } = ANSWERS
  const bare = profileRepo(box(), partial)
  const sb = box()
  mkdirSync(join(sb.profiles, 'widget'), { recursive: true })
  git(join(sb.profiles, 'widget'), 'clone', '-q', bare, '.')
  writeFileSync(join(sb.profiles, 'widget', 'secrets.env'), 'TRACKER_TOKEN=abc\n', { mode: 0o600 })
  const r = run(sb, ['project', 'clone', `file://${bare}`, 'widget'])
  assert.equal(r.status, 1, out(r))
  assert.match(r.stderr, /resume: +tiller project ask widget$/m)
  assert.match(r.stdout, /A launch against this profile would be refused/)
  assert.equal(readFileSync(join(sb.profiles, 'widget', 'secrets.env'), 'utf8'), 'TRACKER_TOKEN=abc\n')
})

test('a launch-safe profile: the next run is one ok line naming every profile, and changes no file', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  assert.equal(newProject(sb, repo).status, 0)
  mkdirSync(join(sb.profiles, 'other'))
  writeFileSync(join(sb.profiles, 'other', 'profile.md'), '# other\n')
  const before = snapshot(sb)
  const r = run(sb, ['project'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +project\b.*widget.*other|^ok +project\b.*other.*widget/m)
  assert.deepEqual(snapshot(sb), before)
  assert.ok(!calls(sb).some(c => c.startsWith('git ')))
})

test('`project ask` with no name is a usage error', () => {
  const r = run(box(), ['project', 'ask'])
  assert.equal(r.status, 2, out(r))
})

test('`project ask <name>` hands over to onboard ask', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const { gates, ...partial } = ANSWERS
  newProject(sb, repo, { answers: partial })
  const r = run(sb, ['project', 'ask', 'widget'], { input: 'check: *\n\n\n\n\n\n\n\n' })
  assert.match(out(r), /gates/i)
})
