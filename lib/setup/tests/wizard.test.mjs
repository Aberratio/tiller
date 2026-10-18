// The wizard engine: steps checked against the world before anything is asked, answers from a file,
// --yes or a terminal, a failure that names the command to resume with, and a doctor verdict.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { calls, finished, out, run, sandbox, snapshot, stub } from './sandbox.mjs'

// macOS shape for prereqs.sh: brew present, and the stub installs nothing. gh and claude are stubs
// so that the plan never reaches for the network; claude is signed in, so the providers step only
// links.
const STUBS = { brew: '', gh: '', claude: `[ "$1 $2" = "auth status" ] && echo '{"loggedIn": true}'` }
const withoutJq = () => sandbox({ real: ['node', 'git'], stubs: STUBS })

test('tools: every required tool present is one ok line, and nothing is installed', () => {
  const sb = finished(sandbox({ stubs: STUBS }))
  const r = run(sb, ['setup', '--yes'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +tools\b/m)
  assert.deepEqual(calls(sb).filter(c => c.startsWith('brew')), [])
})

test('tools: a missing tool without a terminal, --yes or an answer is exit 4 naming the question, and nothing runs', () => {
  const sb = withoutJq()
  const r = run(sb, ['setup'])
  assert.equal(r.status, 4, out(r))
  assert.match(r.stderr, /tools\.install/)
  assert.match(r.stderr, /--yes|--answers/)
  assert.deepEqual(calls(sb), [])
})

test('tools: --yes shows the plan, runs it, and stops with the resume command when the tool is still missing', () => {
  const sb = withoutJq()
  const r = run(sb, ['setup', '--yes'])
  assert.equal(r.status, 1, out(r))
  assert.match(out(r), /brew install jq/)
  assert.deepEqual(calls(sb), ['brew install jq'])
  assert.match(r.stderr, /resume: +tiller setup$/m)
  assert.doesNotMatch(r.stdout, /^Ready/m, 'a failed step never ends in a verdict')
})

test('tools: an answers file supplies the confirmation', () => {
  const sb = withoutJq()
  const r = run(sb, ['setup'], { answers: { tools: { install: true } } })
  assert.equal(r.status, 1, out(r))
  assert.deepEqual(calls(sb), ['brew install jq'])
})

test('tools: declining the install stops the wizard with the resume command and runs nothing', () => {
  const sb = withoutJq()
  const r = run(sb, ['setup'], { answers: { tools: { install: false } } })
  assert.equal(r.status, 1, out(r))
  assert.deepEqual(calls(sb), [])
  assert.match(r.stderr, /resume: +tiller setup$/m)
})

test('a terminal answer is read from the prompt', () => {
  const sb = withoutJq()
  const r = run(sb, ['setup'], { input: 'n\n', env: { TILLER_INTERACTIVE: '1' } })
  assert.equal(r.status, 1, out(r))
  assert.deepEqual(calls(sb), [], '"n" at the prompt declines')
})

test('Node absent: the plan runs from bash, and a Node still not on PATH stops with "open a new terminal"', () => {
  const sb = sandbox({ real: ['git', 'jq'], stubs: STUBS })
  const r = run(sb, ['setup', '--yes'])
  assert.equal(r.status, 1, out(r))
  assert.equal(calls(sb)[0], 'brew install node')
  assert.match(r.stderr, /open a new terminal and run +tiller setup +again/)
})

test('Node absent and no terminal or --yes: exit 4 from the bash step, nothing installed', () => {
  const sb = sandbox({ real: ['git', 'jq'], stubs: STUBS })
  const r = run(sb, ['setup'])
  assert.equal(r.status, 4, out(r))
  assert.deepEqual(calls(sb), [])
})

test('verdict: doctor runs at the end with TILLER_HOME set, then the report', () => {
  const sb = finished(sandbox({ stubs: STUBS }))
  const r = run(sb, ['setup', '--yes'], { env: { TILLER_HOME: undefined } })
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /^ok +TILLER_HOME\b/m, 'doctor saw this checkout as TILLER_HOME')
  assert.match(r.stdout, /^Ready\./m)
  assert.match(r.stdout, /brains\/_template\/README\.md/, 'brains are mentioned, not set up')
})

test('optional: --yes and a run without a terminal skip the helm question silently', () => {
  const sb = finished(sandbox({ stubs: STUBS }))
  for (const args of [['setup', '--yes'], ['setup']]) {
    const r = run(sb, args)
    assert.equal(r.status, 0, out(r))
    // Not /helm/: the flow-helm skill is named when the providers step links it.
    assert.doesNotMatch(out(r), /private helm|--helm|^(ok|done) +optional/im)
    assert.ok(!existsSync(join(sb.root, 'helm')), 'nothing was cloned')
  }
})

test('a second run over a finished sandbox asks nothing and changes no file', () => {
  const sb = finished(sandbox({ stubs: STUBS }))
  assert.equal(run(sb, ['setup', '--yes']).status, 0)
  const before = snapshot(sb)
  const r = run(sb, ['setup'])
  assert.equal(r.status, 0, out(r))
  assert.deepEqual(snapshot(sb), before)
})

test('an unknown option is a usage error', () => {
  const sb = sandbox({ stubs: STUBS })
  const r = run(sb, ['setup', '--nope'])
  assert.equal(r.status, 2, out(r))
})
