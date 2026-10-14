// The retro script over a synthetic run-state root: the note it writes, what it proposes and what
// it never proposes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORE = resolve(HERE, '..', '..', '..')
const RETRO = join(CORE, 'skills', 'flow-retro', 'bin', 'retro.mjs')
const PROFILE = join(CORE, 'lib', 'testing', 'fixtures', 'acme', 'profile.md')
const DATE = '2026-10-14'
const AT = `${DATE}T10:00:00.000Z`

const writeJson = (p, obj) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n') }
const writeJsonl = (p, lines) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n') }
const result = (ticket, status, reason = null) => ({ ticket, status, reason, reasonFull: null, prUrl: null, headSha: null, decisions: [], calls: [], gate: null })
const lane = (runId, lane, model, outcome, costUsd, usage = {}) => ({ runId, phase: lane, label: `${lane}:${lane}:T3`, lane, model, outcome, durationMs: 1, costUsd, usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, ...usage }, replayed: false, at: AT })
const verdict = (runId, i, lane, model) => ({ kind: 'verdict', id: `${runId}:${lane}:${i}`, runId, phase: lane, lane, model, tier: 'T3', field: `f${i}`, value: 'x', evidenceStatus: 'claimed', at: AT })
const overturned = (runId, id) => ({ kind: 'overturned', verdictId: id, runId, by: 'script', source: 'verify-claim', evidence: 'e', at: AT })
const decision = (runId, ticket, kind, status) => ({ id: `${runId}:${ticket}:${kind}`, runId, ticket, kind, status, question: 'q', why: 'w', blocks: ticket, at: AT })

function syntheticRoot() {
  const root = mkdtempSync(join(tmpdir(), 'flow-retro-'))
  writeJson(join(root, 'run-a', 'tickets', 'ABC-1', 'driver-result.json'), result('ABC-1', 'parked', 'harness-blocked: tool Write denied by rule no-outward-write'))
  writeJson(join(root, 'run-a', 'tickets', 'ABC-2', 'driver-result.json'), result('ABC-2', 'merged'))
  writeJson(join(root, 'run-b', 'tickets', 'ABC-3', 'driver-result.json'), result('ABC-3', 'parked', 'harness-blocked: tool Bash denied by rule sandbox-net'))
  writeJson(join(root, 'run-b', 'tickets', 'ABC-4', 'driver-result.json'), result('ABC-4', 'died', 'drive.mjs killed by SIGTERM'))
  writeJson(join(root, 'run-b', 'day-result.json'), { date: DATE, status: 'done', reason: null, results: [] })
  writeJsonl(join(root, 'run-b', 'decisions.jsonl'), [decision('r2', 'ABC-3', 'question', 'open'), decision('r2', 'ABC-4', 'question', 'open'), decision('r2', 'ABC-4', 'run-died', 'resolved')])
  writeJsonl(join(root, 'run-a', 'tickets', 'ABC-1', 'driver-journal.jsonl'), [
    lane('r1', 'implement', 'opus', 'ok', 8, { input: 100000, output: 5000 }),
    lane('r1', 'review-axis', 'opus', 'schema', 0.5), lane('r1', 'review-axis', 'opus', 'schema', 0.5), lane('r1', 'review-axis', 'opus', 'ok', 1),
    lane('r1', 'premise', 'sonnet', 'ok', 0.1),
  ])
  writeJsonl(join(root, 'run-b', 'tickets', 'ABC-3', 'driver-journal.jsonl'), [lane('r2', 'implement', 'opus', 'ok', 4)])
  writeJsonl(join(root, 'run-a', 'tickets', 'ABC-1', 'verdicts.jsonl'), [
    ...Array.from({ length: 12 }, (_, i) => verdict('r1', i, 'implement', 'opus')), overturned('r1', 'r1:implement:0'), overturned('r1', 'r1:implement:1'), overturned('r1', 'r1:implement:2'),
    ...Array.from({ length: 3 }, (_, i) => verdict('r1', i, 'premise', 'sonnet')),
  ])
  return root
}

const run = (...argv) => {
  const p = spawnSync(process.execPath, [RETRO, ...argv], { encoding: 'utf8', env: { ...process.env, TILLER_RUN_STATE: '' } })
  let r = null
  try { r = JSON.parse(p.stdout.trim().split('\n').pop()) } catch {}
  return { p, r, stdout: p.stdout, stderr: p.stderr }
}
const section = (note, heading) => { const i = note.indexOf(`\n## ${heading}`); const j = note.indexOf('\n## ', i + 1); return note.slice(i, j < 0 ? undefined : j) }

test('the note names every run, the park causes and the open decisions, with the ticket keys as evidence', () => {
  const root = syntheticRoot()
  const out = join(root, 'retro.md')
  const { p, r, stdout, stderr } = run('--profile', PROFILE, '--root', root, '--date', DATE, '--out', out)
  assert.equal(p.status, 0, stdout + stderr)
  assert.equal(r.status, 'ok')
  assert.equal(r.out, out)
  assert.deepEqual({ runs: r.runs, tickets: r.tickets }, { runs: 2, tickets: 4 })
  const note = readFileSync(out, 'utf8')
  assert.match(note, /^# Retro 2026-10-14/)
  assert.match(section(note, 'Runs'), /\| ABC-1 \| parked \| harness-blocked/)
  assert.match(section(note, 'Runs'), /\| ABC-4 \| died \|/)
  assert.match(section(note, 'Park causes'), /\| harness-blocked \| 2 \| ABC-1, ABC-3 \|/)
  assert.match(section(note, 'Open decisions'), /\| question \| 2 \| ABC-3, ABC-4 \|/)
  assert.match(section(note, 'Spend'), /\| opus \| implement \| 2 \| 12\.00 \|/)
  assert.match(section(note, 'Calibration'), /\| opus \| implement \| 12 \| 0\.25 \| 0\.75 \|/)
  assert.match(section(note, 'Calibration'), /sonnet premise \(n=3\)/)
})

test('every proposal names one allowed target and carries evidence lines; authority sections are never a target', () => {
  const root = syntheticRoot()
  const out = join(root, 'retro.md')
  const { p, r, stdout, stderr } = run('--profile', PROFILE, '--root', root, '--date', DATE, '--out', out, '--min-n', '10')
  assert.equal(p.status, 0, stdout + stderr)
  const proposals = section(readFileSync(out, 'utf8'), 'Proposals')
  assert.ok(r.proposals >= 4, stdout)
  // A park cause seen twice proposes an edit to the run policy, with both tickets as evidence.
  assert.match(proposals, /`## run policy`[^\n]*harness-blocked[\s\S]*?evidence: ABC-1[^\n]*no-outward-write/)
  assert.match(proposals, /evidence: ABC-3[^\n]*sandbox-net/)
  // An overturn rate at or above the threshold proposes a routing change for that lane.
  assert.match(proposals, /`## model routing`[^\n]*implement[^\n]*opus[\s\S]*?evidence: 3 of 12 verdicts overturned/)
  // Repeated schema failures on a lane propose its schema or brief.
  assert.match(proposals, /`lib\/contract\/schemas\/lane-review-axis\.json`[\s\S]*?evidence: 2 of 3 review-axis calls ended schema/)
  // Open decisions of one kind propose the escalation section.
  assert.match(proposals, /`## escalation`[^\n]*question[\s\S]*?evidence: ABC-3/)
  for (const line of proposals.split('\n').filter(l => l.startsWith('- '))) {
    assert.match(line, /^- `[^`]+`: /, line)
    assert.doesNotMatch(line, /merge authority|inviolables|owner proxy/, line)
  }
})

test('--dry-run prints the note and writes nothing; the default path is retros/<date>.md beside the profile', () => {
  const root = syntheticRoot()
  const dir = mkdtempSync(join(tmpdir(), 'flow-retro-profile-'))
  copyFileSync(PROFILE, join(dir, 'profile.md'))
  const dry = run('--profile', join(dir, 'profile.md'), '--root', root, '--date', DATE, '--dry-run')
  assert.equal(dry.p.status, 0, dry.stdout + dry.stderr)
  assert.match(dry.stdout, /^# Retro 2026-10-14/)
  assert.equal(dry.r.out, null)
  assert.ok(!existsSync(join(dir, 'retros')))
  const wet = run('--profile', join(dir, 'profile.md'), '--root', root, '--date', DATE)
  assert.equal(wet.p.status, 0, wet.stdout + wet.stderr)
  assert.equal(wet.r.out, join(dir, 'retros', `${DATE}.md`))
  assert.ok(existsSync(wet.r.out))
})

test('a missing run-state root is a script error; a missing profile is a refusal', () => {
  const none = run('--profile', PROFILE, '--root', join(tmpdir(), 'flow-retro-nowhere'), '--dry-run')
  assert.equal(none.p.status, 1)
  assert.equal(none.r.status, 'error')
  const noProfile = run('--root', tmpdir(), '--dry-run')
  assert.equal(noProfile.p.status, 4)
  assert.equal(noProfile.r.status, 'refused')
})
