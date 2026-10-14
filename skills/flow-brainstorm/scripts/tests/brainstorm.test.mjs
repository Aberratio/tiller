import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'brainstorm.mjs')
const DATE = '2026-01-02'

function session(over = {}) {
  return {
    goal: 'Tell the owner about a parked decision before the day ends',
    area: 'tech',
    evidence: [
      { claim: 'the day summary is written once, at the end of the run', measured: { command: 'grep -n summary lib/driver/day.mjs', output: '41: writeSummary(state)' } },
      { claim: 'the owner reads the tracker more often than the summary', assumption: true, settle: 'ask the owner which surface they check during a run' },
    ],
    options: [
      { id: 'A', name: 'Comment on the ticket', summary: 'Post the parked question as a tracker comment', against: 'a comment is an outward channel, and every hard-stop list blocks it by default', reversalCost: '1 file, about 30 minutes to remove the call', touches: ['## escalation'] },
      { id: 'B', name: 'Append to the doubt log as it happens', summary: 'Write the park to the doubt log immediately instead of at the end', against: 'the owner still has to open a file to see it', reversalCost: '1 function in 1 file, 15 minutes', touches: ['## escalation'] },
      { id: 'C', name: 'Do nothing; shorten the day', summary: 'Lower the stop hour so the summary arrives sooner', against: 'trades throughput for latency on every day, parked or not', reversalCost: 'one profile line, 2 minutes', touches: ['## run policy'], minimal: true },
    ],
    recommendation: 'B',
    beat: 'A',
    why: 'keeps every write inside the harness; A would need a channel the hard-stop list closes by default',
    ...over,
  }
}

function tmp() { return mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'brainstorm-')) }
function file(obj) { const p = join(tmp(), 's.json'); writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); return p }
function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const problems = obj => run(['check', file(obj)]).out

test('a well-formed session passes check with exit 0', () => {
  const r = run(['check', file(session())])
  assert.equal(r.code, 0, r.out + r.err)
  assert.match(r.out, /^ok/m)
})

test('fewer than three options is refused', () => {
  const s = session()
  s.options = s.options.slice(0, 2)
  s.options[1].minimal = true
  const r = run(['check', file(s)])
  assert.equal(r.code, 1)
  assert.match(r.out, /at least 3 options/)
})

test('every option needs against, reversalCost and touches', () => {
  const s = session()
  delete s.options[0].against
  s.options[1].reversalCost = ''
  delete s.options[2].touches
  const out = problems(s)
  assert.match(out, /A: against missing/)
  assert.match(out, /B: reversalCost missing/)
  assert.match(out, /C: touches missing/)
})

test('a reversal cost with no number is an adjective, not a cost', () => {
  const s = session()
  s.options[0].reversalCost = 'low'
  assert.match(problems(s), /A: reversalCost "low" names no quantity/)
})

test('two options with the same strongest case against are one option', () => {
  const s = session()
  s.options[1].against = s.options[0].against.toUpperCase() + '  '
  assert.match(problems(s), /B: same strongest case against as A/)
})

test('duplicate ids or names are refused', () => {
  const s = session()
  s.options[1].id = 'A'
  s.options[2].name = 'comment on the ticket'
  const out = problems(s)
  assert.match(out, /duplicate id A/)
  assert.match(out, /duplicate name/)
})

test('one option must be the minimal one', () => {
  const s = session()
  delete s.options[2].minimal
  assert.match(problems(s), /no option is marked minimal/)
})

test('touches entries are a profile section, an inviolable, or none alone', () => {
  const s = session()
  s.options[0].touches = ['the build']
  s.options[1].touches = ['none', '## escalation']
  s.options[2].touches = []
  const out = problems(s)
  assert.match(out, /A: touches "the build"/)
  assert.match(out, /B: "none" cannot be combined/)
  assert.match(out, /C: touches missing/)
})

test('recommendation and beat must name two different existing options', () => {
  assert.match(problems(session({ recommendation: 'Z' })), /recommendation Z is not an option/)
  assert.match(problems(session({ beat: 'B' })), /beat must differ from the recommendation/)
  assert.match(problems(session({ why: '' })), /why missing/)
})

test('every claim is measured or an assumption with a way to settle it', () => {
  const s = session()
  s.evidence.push({ claim: 'nobody reads the summary' })
  s.evidence.push({ claim: 'x', assumption: true })
  s.evidence.push({ claim: 'y', measured: { command: 'ls' } })
  const out = problems(s)
  assert.match(out, /evidence 3: neither measured nor an assumption/)
  assert.match(out, /evidence 4: assumption without settle/)
  assert.match(out, /evidence 5: measured needs command and output/)
})

test('an area outside the register vocabulary is refused', () => {
  assert.match(problems(session({ area: 'ux' })), /area "ux" not one of/)
})

test('with facts, an inviolable must be one the profile declares', () => {
  const facts = file({ inviolables: ['Customer data never leaves the region'] })
  const s = session()
  s.options[0].touches = ['inviolable: Something else']
  const r = run(['check', file(s), '--facts', facts])
  assert.equal(r.code, 1)
  assert.match(r.out, /A: inviolable "Something else" is not declared/)
})

test('a recommendation touching an inviolable passes check but is reported as a park', () => {
  const facts = file({ inviolables: ['Customer data never leaves the region'] })
  const s = session()
  s.options[1].touches = ['inviolable: Customer data never leaves the region']
  const r = run(['check', file(s), '--facts', facts])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^park: recommendation B touches inviolable "Customer data never leaves the region"/m)
})

test('with a profile, a touched section must be a heading in it', () => {
  const dir = tmp()
  const profile = join(dir, 'profile.md')
  writeFileSync(profile, '# p\n\n## escalation\n- Human: owner\n\n## run policy\n- Stop hour: 18\n')
  assert.equal(run(['check', file(session()), '--profile', profile]).code, 0)
  const s = session()
  s.options[0].touches = ['## owner proxy']
  const r = run(['check', file(s), '--profile', profile])
  assert.equal(r.code, 1)
  assert.match(r.out, /A: "## owner proxy" is not a section of the profile/)
})

test('a long measured output is clipped visibly, never silently', () => {
  const s = session()
  s.evidence[0].measured.output = 'x'.repeat(300)
  const r = run(['render', file(s)])
  assert.match(r.out, /x{160}… \(clipped; 300 chars\)/)
})

test('malformed JSON is a usage error', () => {
  assert.equal(run(['check', file('{nope')]).code, 2)
})

test('render refuses a session that fails check', () => {
  const s = session()
  delete s.options[0].against
  const r = run(['render', file(s)])
  assert.equal(r.code, 1)
  assert.equal(r.out.includes('| Option'), false)
})

test('the table puts the recommendation first and labels assumptions', () => {
  const r = run(['render', file(session())])
  assert.equal(r.code, 0, r.err)
  const rows = r.out.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Option') && !l.startsWith('| ---'))
  assert.match(rows[0], /Append to the doubt log as it happens \(Recommended\)/)
  assert.equal(rows.length, 3)
  assert.match(r.out, /Beat: A — Comment on the ticket/)
  assert.match(r.out, /Assumption: the owner reads the tracker more often than the summary — settle: ask the owner/)
  assert.match(r.out, /Measured: the day summary is written once, at the end of the run — `grep -n summary lib\/driver\/day.mjs`/)
})

test('a pipe inside a cell does not break the table', () => {
  const s = session()
  s.options[0].against = 'a | b'
  assert.match(run(['render', file(s)]).out, /a \\\| b/)
})

test('the plain-text question is numbered, recommendation first, one question', () => {
  const r = run(['render', file(session()), '--as', 'question'])
  assert.equal(r.code, 0)
  const lines = r.out.trim().split('\n')
  assert.match(lines[0], /\?$/)
  assert.match(lines[1], /^1\. Append to the doubt log as it happens \(Recommended\)/)
  assert.match(lines[2], /^2\. /)
  assert.match(lines[3], /^3\. /)
  assert.match(r.out, /Reply with a number/)
})

test('awaiting renders the harness decision shape', () => {
  const a = JSON.parse(run(['render', file(session()), '--as', 'awaiting']).out)
  assert.equal(a.kind, 'question')
  assert.equal(a.options.length, 3)
  assert.match(a.recommendation, /^B: /)
  assert.equal(a.reversalCost, '1 function in 1 file, 15 minutes')
  assert.ok(a.question.length > 0)
})

test('the ledger line follows the decision-ledger grammar', () => {
  const line = run(['render', file(session()), '--as', 'ledger', '--date', DATE]).out.trim()
  assert.match(line, /^- 2026-01-02 · spec · Append to the doubt log as it happens — keeps every write inside the harness; .*beat Comment on the ticket; reversal: 1 function in 1 file, 15 minutes · self$/)
  const agreed = run(['render', file(session()), '--as', 'ledger', '--date', DATE, '--tag', 'both', '--agreed-with', 'the ticket owner, brainstorm']).out.trim()
  assert.match(agreed, /^- 2026-01-02 · both · .* · agreed with the ticket owner, brainstorm$/)
  assert.equal(run(['render', file(session()), '--as', 'ledger', '--tag', 'nope']).code, 2)
})

test('the doubt block carries the decision, the settle line and the table', () => {
  const r = run(['render', file(session()), '--as', 'doubt', '--date', DATE])
  assert.match(r.out, /^## 2026-01-02 · brainstorm · Tell the owner/m)
  assert.match(r.out, /- Decision: B — Append to the doubt log/)
  assert.match(r.out, /- Settle: ask the owner which surface they check during a run/)
  assert.match(r.out, /\| Option \|/)
})

function brain({ client = false, decisions = '# Decisions\n', questions = '# Questions\n' } = {}) {
  const dir = tmp()
  writeFileSync(join(dir, 'decisions.md'), decisions)
  writeFileSync(join(dir, 'questions.md'), questions)
  if (client) writeFileSync(join(dir, 'client.md'), '# Client\n')
  return dir
}

test('record writes the session file, the next D-nnn and a Q-nnn per assumption', () => {
  const dir = brain({ decisions: '# Decisions\n\n### D-001 — earlier\n- Area: scope\n- Status: proposed\n', questions: '# Questions\n\n### Q-004 — older\n- Area: tech\n' })
  const r = run(['record', file(session()), '--brain', dir, '--date', DATE])
  assert.equal(r.code, 0, r.err)
  const dec = readFileSync(join(dir, 'decisions.md'), 'utf8')
  assert.match(dec, /### D-002 — Append to the doubt log as it happens\n- Area: tech\n- Status: proposed\n- Proposed in: brainstorms\/2026-01-02-tell-the-owner-about-a-parked-decision-before-the-day-ends\.md\n- Confirmed by: -\n/)
  const que = readFileSync(join(dir, 'questions.md'), 'utf8')
  assert.match(que, /### Q-005 — the owner reads the tracker more often than the summary\n- Area: tech\n- Owner: me\n- Blocks spec: no\n- Opened in: brainstorms\/2026-01-02-/)
  const files = readdirSync(join(dir, 'brainstorms'))
  assert.equal(files.length, 1)
  const body = readFileSync(join(dir, 'brainstorms', files[0]), 'utf8')
  assert.match(body, /^# Tell the owner/)
  assert.match(body, /Recorded as: D-002; open: Q-005/)
  assert.match(r.out, /D-002/)
})

test('an assumption marked flips blocks the spec', () => {
  const dir = brain()
  const s = session()
  s.evidence[1].flips = true
  run(['record', file(s), '--brain', dir, '--date', DATE])
  assert.match(readFileSync(join(dir, 'questions.md'), 'utf8'), /- Blocks spec: yes/)
})

test('a second session with the same goal on the same day gets its own file', () => {
  const dir = brain()
  run(['record', file(session()), '--brain', dir, '--date', DATE])
  run(['record', file(session()), '--brain', dir, '--date', DATE])
  assert.equal(readdirSync(join(dir, 'brainstorms')).length, 2)
  assert.match(readFileSync(join(dir, 'decisions.md'), 'utf8'), /### D-002 — /)
})

test('confirmed by self makes it agreed in a pet brain and is refused in a client brain', () => {
  const pet = brain()
  assert.equal(run(['record', file(session()), '--brain', pet, '--date', DATE, '--confirmed-by', 'self']).code, 0)
  assert.match(readFileSync(join(pet, 'decisions.md'), 'utf8'), /- Status: agreed\n- Proposed in: .*\n- Confirmed by: self\n/)
  const client = brain({ client: true })
  const r = run(['record', file(session()), '--brain', client, '--date', DATE, '--confirmed-by', 'self'])
  assert.equal(r.code, 3)
  assert.match(r.err, /client brain/)
  assert.equal(existsSync(join(client, 'brainstorms')), false)
})

test('a brain without a register is refused and left untouched', () => {
  const dir = tmp()
  mkdirSync(join(dir, 'notes'))
  const r = run(['record', file(session()), '--brain', dir, '--date', DATE])
  assert.equal(r.code, 3)
  assert.match(r.err, /no decisions\.md/)
  assert.deepEqual(readdirSync(dir), ['notes'])
})

test('record refuses an invalid session without writing', () => {
  const dir = brain()
  const s = session()
  delete s.options[0].against
  assert.equal(run(['record', file(s), '--brain', dir, '--date', DATE]).code, 1)
  assert.equal(existsSync(join(dir, 'brainstorms')), false)
  assert.equal(readFileSync(join(dir, 'decisions.md'), 'utf8'), '# Decisions\n')
})

test('a brain recorded into still passes the discovery register check', () => {
  const LIB = join(dirname(SCRIPT), '..', '..', '..', 'lib', 'discovery')
  const DISCOVERY = join(LIB, 'discovery.mjs')
  const root = tmp()
  const env = { ...process.env, TILLER_BRAINS_DIR: root }
  // The pet scaffold of `discovery.mjs new`, without its git init.
  mkdirSync(join(root, 'demo'))
  for (const f of ['decisions.md', 'questions.md']) writeFileSync(join(root, 'demo', f), readFileSync(join(LIB, 'templates', f)))
  const s = session()
  s.evidence[1].flips = true
  assert.equal(run(['record', file(s), '--brain', join(root, 'demo'), '--date', DATE, '--confirmed-by', 'self']).code, 0)
  const check = spawnSync('node', [DISCOVERY, 'check', 'demo'], { env, encoding: 'utf8' })
  assert.equal(check.status, 0, check.stdout)
  const status = spawnSync('node', [DISCOVERY, 'status', 'demo'], { env, encoding: 'utf8' })
  assert.match(status.stdout, /spec: blocked by Q-001/)
})

test('unknown commands and formats are usage errors', () => {
  assert.equal(run(['frobnicate']).code, 2)
  assert.equal(run(['render', file(session()), '--as', 'pdf']).code, 2)
  assert.equal(run(['record', file(session())]).code, 2)
})
