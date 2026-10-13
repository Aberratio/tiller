import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, parseEntries, status } from '../register.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VALID = join(HERE, '..', '..', 'testing', 'fixtures', 'discovery', 'valid')

const temps = []
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }) })

// A copy of the valid brain with one file rewritten, so each test names exactly one fault.
function brain(edit = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'discovery-'))
  temps.push(dir)
  cpSync(VALID, dir, { recursive: true })
  for (const [file, fn] of Object.entries(edit)) {
    const p = join(dir, file)
    if (fn === null) unlinkSync(p)
    else writeFileSync(p, fn(readFileSync(p, 'utf8')))
  }
  return dir
}

test('parseEntries reads ids, titles, fields and lines', () => {
  const e = parseEntries('# D\n\n### D-001 — Title\n- Area: scope\n- Status: agreed\n')
  assert.deepEqual(e, [{ id: 'D-001', title: 'Title', line: 3, fields: { Area: 'scope', Status: 'agreed' } }])
})

test('parseEntries accepts CRLF and a plain dash', () => {
  const e = parseEntries('### Q-010 - Who?\r\n- Owner: me\r\n')
  assert.equal(e[0].id, 'Q-010')
  assert.equal(e[0].fields.Owner, 'me')
})

test('the valid brain has no violations, including against its spec', () => {
  const dir = brain()
  assert.deepEqual(check(dir, { specDir: join(dir, 'spec') }), [])
})

const faults = [
  ['duplicate id', { 'decisions.md': t => t + '\n### D-001 — Again\n- Area: scope\n- Status: proposed\n' }, /D-001 duplicate/],
  ['agreed without confirmation', { 'decisions.md': t => t.replace('- Confirmed by: e-mail 2026-01-06 "Re: Kickoff recap"\n\n### D-002', '\n### D-002') }, /D-001 agreed without Confirmed by/],
  ['superseded without successor', { 'decisions.md': t => t.replace('- Superseded by: D-003\n', '').replace('- Supersedes: D-002\n', '') }, /D-002 superseded without Superseded by/],
  ['successor missing', { 'decisions.md': t => t.replace('Superseded by: D-003', 'Superseded by: D-009').replace('- Supersedes: D-002\n', '') }, /D-002 Superseded by D-009, which does not exist/],
  ['supersedes not mirrored', { 'decisions.md': t => t.replace('- Supersedes: D-002\n', '') }, /D-002 Superseded by D-003, but D-003 does not list it in Supersedes/],
  ['unknown status', { 'decisions.md': t => t.replace('Status: proposed', 'Status: maybe') }, /D-004 Status "maybe"/],
  ['unknown area', { 'questions.md': t => t.replace('Area: other', 'Area: colour') }, /Q-002 Area "colour"/],
  ['bad Blocks spec', { 'questions.md': t => t.replace('Blocks spec: no', 'Blocks spec: maybe') }, /Q-002 Blocks spec "maybe"/],
]
for (const [name, edit, msg] of faults) {
  test(`check reports: ${name}`, () => {
    const out = check(brain(edit))
    assert.equal(out.length, 1, out.join('\n'))
    assert.match(out[0], msg)
  })
}

test('Supersedes with two ids is checked for both', () => {
  const dir = brain({ 'decisions.md': t => t.replace('- Supersedes: D-002\n', '- Supersedes: D-002, D-004\n') })
  assert.match(check(dir).join('\n'), /D-003 Supersedes D-004, but D-004 is not superseded by D-003/)
})

test('spec citing a superseded or missing decision', () => {
  const dir = brain({ 'spec/spec.md': t => t + '- Postgres (D-002), mobile (D-077).\n' })
  const out = check(dir, { specDir: join(dir, 'spec') }).join('\n')
  assert.match(out, /cites D-002, which is superseded/)
  assert.match(out, /cites D-077, which does not exist/)
})

test('a brain without register files is empty, not an error', () => {
  const dir = brain({ 'decisions.md': null, 'questions.md': null })
  assert.deepEqual(check(dir), [])
  assert.deepEqual(status(dir), { awaiting: [], open: {}, blocking: [], ready: true })
})

test('status: awaiting confirmation, open questions, readiness', () => {
  const dir = brain()
  assert.deepEqual(status(dir), { awaiting: ['D-004'], open: { other: ['Q-002'] }, blocking: [], ready: true })
  const blocked = brain({ 'questions.md': t => t.replace('Blocks spec: no', 'Blocks spec: yes') })
  assert.deepEqual(status(blocked).blocking, ['Q-002'])
  assert.equal(status(blocked).ready, false)
})

for (const [name, heading] of [['wrong level', '## D-005 — x'], ['no dash', '### D-005 Something'], ['en dash', '### D-005 – x'], ['short number', '### D-5 — x']]) {
  test(`check reports an unparsed heading: ${name}`, () => {
    const dir = brain({ 'decisions.md': t => t + `\n${heading}\n\n- Status: agreed\n- Confirmed by: nobody\n` })
    const line = readFileSync(join(dir, 'decisions.md'), 'utf8').split('\n').indexOf(heading) + 1
    const out = check(dir)
    assert.deepEqual(out, [`decisions.md:${line}: unparsed heading`])
    assert.equal(parseEntries(readFileSync(join(dir, 'decisions.md'), 'utf8')).at(-1).fields.Status, 'proposed')
  })
}
