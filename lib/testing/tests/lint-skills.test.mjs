import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { lintSkills } from '../lint-skills.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GOOD = `---
name: flow-demo
description: Demo skill. Use for "demo this" or "run the demo".
---

## Step −1 — Resolve the project profile

Read \`$TILLER_HOME/skills/_shared/resolve-profile.md\` and follow it; no profile resolves → stop.

Reads \`## tracker\`. See \`$TILLER_HOME/docs/profile-schema.md\`.
`

function makeRoot(skill = GOOD, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lint-skills-'))
  const put = (rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body) }
  put('docs/profile-schema.md', '## Required sections\n\n| `## tracker` | x | y |\n')
  put('skills/_shared/resolve-profile.md', '## Step −1\n')
  put('skills/flow-demo/SKILL.md', skill)
  for (const [rel, body] of Object.entries(extra)) put(rel, body)
  return root
}
const messages = root => lintSkills(root).map(v => `${v.file}:${v.line}: ${v.msg}`)

test('a well-formed skill is clean', () => {
  assert.deepEqual(messages(makeRoot()), [])
})

test('the real skills pass', () => {
  assert.deepEqual(messages(REPO), [])
})

test('name must equal the directory', () => {
  const m = messages(makeRoot(GOOD.replace('name: flow-demo', 'name: flow-other')))
  assert.match(m.join('\n'), /skills\/flow-demo\/SKILL\.md:2: name "flow-other" must equal/)
})

test('a description over 400 chars or without a quoted trigger is reported', () => {
  const long = GOOD.replace(/description: .*/, `description: "x" ${'a'.repeat(420)}`)
  assert.match(messages(makeRoot(long)).join('\n'), /limit 400/)
  const bare = GOOD.replace(/description: .*/, 'description: Demo skill with no trigger.')
  assert.match(messages(makeRoot(bare)).join('\n'), /no quoted trigger phrase/)
})

test('a skill without Step −1 is reported; the pre-profile variant passes', () => {
  const none = GOOD.replace(/## Step −1[^\n]*\n/, '## Setup\n')
  assert.match(messages(makeRoot(none)).join('\n'), /no Step −1 block/)
  const variant = GOOD.replace('Resolve the project profile', 'Resolve the project profile (may be absent)')
  assert.deepEqual(messages(makeRoot(variant)), [])
})

test('a missing $TILLER_HOME path and a repo-relative _shared reference are reported', () => {
  const body = `${GOOD}\nSee \`$TILLER_HOME/lib/nope.sh\` and \`skills/_shared/resolve-profile.md\`.\n`
  const m = messages(makeRoot(body)).join('\n')
  assert.match(m, /\$TILLER_HOME\/lib\/nope\.sh does not exist/)
  assert.match(m, /repo-relative reference skills\/_shared\/resolve-profile\.md/)
})

test('an undeclared profile section is reported', () => {
  const m = messages(makeRoot(`${GOOD}\nAlso reads \`## invented\`.\n`)).join('\n')
  assert.match(m, /"## invented" is not declared/)
})

test('vendor tokens are reported outside the allowed skills and tests', () => {
  const body = `${GOOD}\nCall mcp__claude_ai_Slack__x or run claude -p.\n`
  const m = messages(makeRoot(body)).join('\n')
  assert.match(m, /"mcp__claude_ai_"/)
  assert.match(m, /"claude -p"/)
  const ok = messages(makeRoot(GOOD, { 'skills/flow-demo/tests/a.test.mjs': 'mcp__claude_ai_Slack__x claude -p' }))
  assert.deepEqual(ok, [])
})

test('leak terms from a local leak-terms.txt are applied', () => {
  const root = makeRoot(`${GOOD}\nMentions Zorblax once.\n`, { 'profiles/p/leak-terms.txt': '# c\nzorblax\n' })
  assert.match(messages(root).join('\n'), /matches a leak term/)
})

test('the CLI exits non-zero with file:line on a violation and zero when clean', () => {
  const run = root => spawnSync('node', [join(REPO, 'lib/testing/lint-skills.mjs'), '--root', root], { encoding: 'utf8' })
  const bad = run(makeRoot(GOOD.replace('name: flow-demo', 'name: x')))
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^skills\/flow-demo\/SKILL\.md:2:/m)
  assert.equal(run(makeRoot()).status, 0)
})
