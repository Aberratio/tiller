// Decision records as the harness wrote them on 2026-10-06/07, codes redacted. Each was put to a person and
// could not be answered without opening the run state; the linter must refuse every one of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lint } from '../lint.mjs'
import { fromDecision } from '../request.mjs'

const load = p => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'))
const rulesOf = d => new Set(lint(fromDecision(d), { target: 'ledger' }).violations.map(v => v.rule))

const REPLAY = {
  // CI cap reached: full sha, a list of skipped job names in one sentence, internal cap name as the whole situation.
  'ABC-101-D4': ['L03', 'L06', 'L09', 'L14', 'L16'],
  // Gate red: gate names a person cannot decode, full sha, "low: the PR stays open" as a bare string.
  'ABC-101-D5': ['L03', 'L09', 'L14'],
  // The padded one: placeholder options, internal step keys and decision numbers.
  'ABC-102-D2': ['L04', 'L09'],
}

for (const [id, expected] of Object.entries(REPLAY)) {
  test(`${id} as recorded fails the linter on ${expected.join(', ')}`, () => {
    const got = rulesOf(load(`./fixtures/replay/${id}.json`))
    for (const rule of expected) assert.ok(got.has(rule), `${rule} missing from ${[...got]}`)
  })
}

test('the same ABC-101-D5 decision rewritten as a hitl-request passes', () => {
  const r = load('../../contract/fixtures/hitl-request/valid-merge-ask.json')
  assert.equal(r.id, 'ABC-101-D5')
  assert.deepEqual(lint(r, { target: 'ledger' }).violations, [])
})
