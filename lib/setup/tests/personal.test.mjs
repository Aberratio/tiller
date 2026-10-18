// The personal step (`tiller personal new|clone`): the generator and install.sh are real; git is a
// stub whose clone writes a personal repository with one skill.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { calls, GENERATE, out, run, sandbox, snapshot } from './sandbox.mjs'

const CLAUDE = `[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true}'`
// The generator's answers, as lib/install/tests passes them.
const GIT = `if [ "$1" = clone ]; then mkdir -p "$3/skills/say-hi" && printf -- '---\\nname: say-hi\\ndescription: x\\n---\\n' > "$3/skills/say-hi/SKILL.md"; fi`

const box = () => sandbox({ real: ['node', 'jq'], stubs: { claude: CLAUDE, gh: 'exit 1', git: GIT } })
const linkedTo = (sb, skill, dir) => lstatSync(join(sb.skills, skill)).isSymbolicLink() && realpathSync(join(sb.skills, skill)) === realpathSync(dir)

test('new: the generator runs on the nested answers and its skills are linked', () => {
  const sb = box()
  const r = run(sb, ['personal', 'new', 'sam'], { answers: { personal: { generate: GENERATE } } })
  assert.equal(r.status, 0, out(r))
  assert.ok(existsSync(join(sb.personal, 'sam', 'skills', 'write-daily', 'SKILL.md')))
  assert.ok(linkedTo(sb, 'write-like-sam', join(sb.personal, 'sam', 'skills', 'write-like-sam')))
  assert.match(r.stdout, /^done +personal\b/m)
})

test('new without a terminal or the generator answers is exit 4 naming them, and nothing is generated', () => {
  const sb = box()
  const r = run(sb, ['personal', 'new', 'sam'], { env: { USER: 'sam' } })
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /personal\.generate/)
  assert.ok(!existsSync(join(sb.personal, 'sam')))
})

test('the owner defaults to the login name', () => {
  const sb = box()
  const r = run(sb, ['personal'], { answers: { personal: { mode: 'new', generate: GENERATE } }, env: { USER: 'sam' } })
  assert.equal(r.status, 0, out(r))
  assert.ok(existsSync(join(sb.personal, 'sam', 'skills')))
})

test('clone with a git URL: cloned into personal/<owner> and linked', () => {
  const sb = box()
  const r = run(sb, ['personal', 'clone', 'git@example.com:sam/skills.git', 'sam'])
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(calls(sb).filter(c => c.startsWith('git')), [`git clone git@example.com:sam/skills.git ${join(sb.personal, 'sam')}`])
  assert.ok(linkedTo(sb, 'say-hi', join(sb.personal, 'sam', 'skills', 'say-hi')))
})

test('clone with a GitHub account: the URL follows the naming rule', () => {
  const sb = box()
  const r = run(sb, ['personal'], { answers: { personal: { mode: 'clone', owner: 'sam', url: 'sam-gh' } } })
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(calls(sb).filter(c => c.startsWith('git')), [`git clone https://github.com/sam-gh/tiller-personal-sam.git ${join(sb.personal, 'sam')}`])
})

test('a failed clone stops with the command that repeats it', () => {
  const sb = sandbox({ real: ['node', 'jq'], stubs: { claude: CLAUDE, gh: 'exit 1', git: 'exit 128' } })
  const r = run(sb, ['personal', 'clone', 'git@example.com:sam/skills.git', 'sam'])
  assert.equal(r.status, 1, out(r))
  assert.match(r.stderr, /resume: +tiller personal clone git@example\.com:sam\/skills\.git sam$/m)
})

test('generated and linked: the next run is one ok line, runs nothing and changes no file', () => {
  const sb = box()
  assert.equal(run(sb, ['personal', 'new', 'sam'], { answers: { personal: { generate: GENERATE } } }).status, 0)
  const before = snapshot(sb)
  const r = run(sb, ['personal'], { env: { USER: 'sam' } })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +personal\b/m)
  assert.deepEqual(snapshot(sb), before)
  assert.equal(readFileSync(sb.log, 'utf8').includes('git clone'), false)
})

test('generated but a link removed: the next run links again without asking', () => {
  const sb = box()
  assert.equal(run(sb, ['personal', 'new', 'sam'], { answers: { personal: { generate: GENERATE } } }).status, 0)
  const before = snapshot(sb)
  rmSync(join(sb.skills, 'write-like-sam'))
  const r = run(sb, ['personal'], { env: { USER: 'sam' } })
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(snapshot(sb), before)
})
