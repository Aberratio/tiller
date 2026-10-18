// The project step's kinds (code, document, notes) and project folders. onboard, profile-facts,
// brain-access and git are real; gh is a stub that answers nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANSWERS, fixtureRepo, git, out, REPO, run, sandbox, snapshot } from './sandbox.mjs'

const CLAUDE = `[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true}'`
const box = () => sandbox({ real: ['node', 'git', 'jq'], stubs: { claude: CLAUDE, gh: 'exit 1' } })
const check = (sb, name) => spawnSync('bash', [join(REPO, 'lib', 'profile-facts.sh'), '--check', '--profile', join(sb.profiles, name, 'profile.md')], { encoding: 'utf8' })
const profile = (sb, name) => readFileSync(join(sb.profiles, name, 'profile.md'), 'utf8')
const resolveIn = (sb, dir) => spawnSync('bash', ['-c', `. "${REPO}/lib/profile-name.sh"; profile_name "$1" "$2"`, '_', sb.profiles, dir], { encoding: 'utf8' }).stdout.trim()

test('without a terminal and without project.kind: exit 4 naming it, nothing onboarded', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const r = run(sb, ['project', 'new', 'widget', repo], { answers: { project: { answers: ANSWERS, marker: true } } })
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /project\.kind/)
  assert.ok(!existsSync(join(sb.profiles, 'widget')))
})

test('an unknown project.kind is a usage error', () => {
  const sb = box()
  const r = run(sb, ['project', 'new', 'widget', fixtureRepo(sb).repo], { answers: { project: { kind: 'book', answers: ANSWERS } } })
  assert.equal(r.status, 2, out(r))
  assert.match(r.stderr, /code, document or notes/)
})

// Pin: the fixtures were rendered by the project step before kinds existed (same answers, no kind).
test('kind code is the project step as it was, byte for byte: profile and output', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb)
  const r = run(sb, ['project', 'new', 'widget', repo], { answers: { project: { kind: 'code', answers: ANSWERS, marker: true } } })
  assert.equal(r.status, 0, out(r))
  const norm = s => s.split(sb.root).join('<root>').split(REPO).join('<repo>').replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
  const fixture = f => readFileSync(join(REPO, 'lib', 'setup', 'tests', 'fixtures', f), 'utf8')
  assert.equal(norm(profile(sb, 'widget')), fixture('code-project.profile.md'))
  assert.equal(norm(r.stdout), fixture('code-project.stdout'))
})

const DOC = { 'branching.integrateMain': 'rebase', 'runPolicy.dayCeiling': '5', 'runPolicy.maxParallel': '1', inviolables: 'none', 'escalation.human': 'Author' }

test('document: no tracker, gates, tests or static checks, merge authority human by default, launch-safe', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb, 'book')
  const r = run(sb, ['project', 'new', 'book', repo, '--yes'], { answers: { project: { kind: 'document', answers: DOC }, backup: { project: false } } })
  assert.equal(r.status, 0, out(r))
  const md = profile(sb, 'book')
  assert.match(md, /- Kind: `document`/)
  assert.match(md, /## tracker\n\n- Kind: `none`\n/)
  for (const h of ['gates', 'test toolchain', 'static checks']) assert.match(md, new RegExp(`## ${h}\\n\\nnone\\n`), h)
  assert.match(md, /\| `\*\*` everything \| `human` \|/)
  assert.equal(check(sb, 'book').status, 0)
})

test('document: project.merge is asked, and project.answers.mergeAuthority still wins over it', () => {
  const sb = box()
  const { repo } = fixtureRepo(sb, 'book')
  const asked = run(sb, ['project', 'new', 'book', repo], { answers: { project: { kind: 'document', answers: DOC, marker: false } } })
  assert.equal(asked.status, 4, out(asked))
  assert.match(asked.stderr, /project\.merge/)
  const r = run(sb, ['project', 'new', 'book', repo], { answers: { project: { kind: 'document', merge: 'human', answers: { ...DOC, mergeAuthority: 'unconfirmed' }, marker: false } } })
  assert.equal(r.status, 0, out(r))
  assert.match(profile(sb, 'book'), /\| `\*\*` everything \| `unconfirmed` \|/)
})

// A project folder <root>/<project>/<repo>: one clone now, a second one added after onboarding.
function shelf(sb) {
  const dir = join(sb.root, 'src', 'shelf')
  mkdirSync(dir, { recursive: true })
  git(dir, 'clone', '-q', fixtureRepo(sb, 'draft').origin, 'draft')
  return dir
}

test('a project folder: one glob for the folder, no .tiller-profile, and a repository added later resolves to it', () => {
  const sb = box()
  const dir = shelf(sb)
  const r = run(sb, ['project', 'new', 'shelf', dir], { answers: { project: { kind: 'code', folder: true, answers: ANSWERS }, backup: { project: false } } })
  assert.equal(r.status, 0, out(r))
  assert.match(profile(sb, 'shelf'), /^repo_globs:\n {2}- "\*\/src\/shelf"\n---/m)
  assert.ok(!existsSync(join(dir, 'draft', '.tiller-profile')))
  git(dir, 'clone', '-q', fixtureRepo(sb, 'notes').origin, 'appendix')
  assert.equal(resolveIn(sb, join(dir, 'appendix')), 'shelf')
  assert.equal(resolveIn(sb, join(sb.root, 'src', 'notes')), '')
})

test('a project folder with no repository yet stops with the command to resume', () => {
  const sb = box()
  const dir = join(sb.root, 'src', 'empty')
  mkdirSync(dir, { recursive: true })
  const r = run(sb, ['project', 'new', 'empty', dir], { answers: { project: { kind: 'code', folder: true, answers: ANSWERS } } })
  assert.equal(r.status, 1, out(r))
  assert.match(out(r), /no git repository/)
  assert.match(r.stderr, /resume: +tiller project new empty /m)
})

test('a directory that is not a repository: without a terminal and without project.folder, exit 4 naming it', () => {
  const sb = box()
  const dir = shelf(sb)
  const r = run(sb, ['project', 'new', 'shelf', dir], { answers: { project: { kind: 'code', answers: ANSWERS } } })
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /project\.folder/)
})

// TILLER_BRAINS_HOME stands in for the checkout, so the real matrix is never written.
const notesEnv = sb => ({ TILLER_BRAINS_HOME: join(sb.home, 'tiller') })
const matrix = sb => JSON.parse(readFileSync(join(sb.home, 'tiller', 'brains', 'access.json'), 'utf8'))

test('notes: no profile; a brain from the template with its own git, granted read through brain-access', () => {
  const sb = box()
  mkdirSync(join(sb.home, 'tiller'))
  const dir = join(sb.root, 'plan')
  mkdirSync(dir)
  const r = run(sb, ['project', 'new', 'plan', dir, '--yes'], { answers: { project: { kind: 'notes' } }, env: notesEnv(sb) })
  assert.equal(r.status, 0, out(r))
  const brain = join(sb.home, 'tiller', 'brains', 'plan')
  assert.equal(readFileSync(join(brain, 'README.md'), 'utf8'), readFileSync(join(REPO, 'brains', '_template', 'README.md'), 'utf8'))
  assert.ok(existsSync(join(brain, '.git')))
  assert.deepEqual(matrix(sb), { _none: { plan: 'read' } })
  assert.ok(!existsSync(join(sb.profiles, 'plan')))
  assert.match(r.stdout, /flow-\* skills stop/)
})

test('notes: project.brain and project.access are asked; without a terminal, exit 4 naming them', () => {
  const sb = box()
  mkdirSync(join(sb.home, 'tiller'))
  const brain = run(sb, ['project', 'new', 'plan', sb.root], { answers: { project: { kind: 'notes' } }, env: notesEnv(sb) })
  assert.equal(brain.status, 4, out(brain))
  assert.match(brain.stderr, /project\.brain/)
  const access = run(sb, ['project', 'new', 'plan', sb.root], { answers: { project: { kind: 'notes', brain: true } }, env: notesEnv(sb) })
  assert.equal(access.status, 4, out(access))
  assert.match(access.stderr, /project\.access/)
})

test('notes: write is granted when asked; declining the brain writes nothing at all', () => {
  const sb = box()
  mkdirSync(join(sb.home, 'tiller'))
  const before = snapshot(sb)
  const no = run(sb, ['project', 'new', 'plan', sb.root], { answers: { project: { kind: 'notes', brain: false } }, env: notesEnv(sb) })
  assert.equal(no.status, 0, out(no))
  assert.deepEqual(snapshot(sb), before)
  const r = run(sb, ['project', 'new', 'plan', sb.root], { answers: { project: { kind: 'notes', brain: true, access: 'write' } }, env: notesEnv(sb) })
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(matrix(sb), { _none: { plan: 'write' } })
})

test('notes, run again with nothing answered: one ok line, no question, no file changed', () => {
  const sb = box()
  mkdirSync(join(sb.home, 'tiller'))
  assert.equal(run(sb, ['project', 'new', 'plan', sb.root, '--yes'], { answers: { project: { kind: 'notes' } }, env: notesEnv(sb) }).status, 0)
  const before = snapshot(sb)
  const r = run(sb, ['project', 'new', 'plan', sb.root], { env: notesEnv(sb) })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +project\b.*plan/m)
  assert.deepEqual(snapshot(sb), before)
})
