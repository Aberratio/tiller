import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fromDecision, decisionFields, violationLines } from '../request.mjs'
import { lint } from '../lint.mjs'

const GOOD = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixtures/hitl-request/valid-merge-ask.json', import.meta.url)), 'utf8'))

test('fromDecision moves the caller\'s words and adds nothing', () => {
  const r = fromDecision({ ticket: 'T-1', kind: 'split', key: 'review:1', question: 'Split?', why: 'two findings open', options: ['split', 'lift the cap'], recommendation: 'split', reversalCost: 'low' })
  assert.deepEqual(r, { schema: 'hitl-request/1', id: 'review:1', situation: 'two findings open', ask: 'Split?', kind: 'split', run: { ticket: 'T-1' },
    options: [{ key: 'A', label: 'split', recommended: true, reversalCost: 'low' }, { key: 'B', label: 'lift the cap', recommended: false, reversalCost: 'low' }] })
  assert.equal(r.ifNoAnswer, undefined)
  assert.equal(r.links, undefined)
})

test('a missing recommendation stays missing and the linter says so', () => {
  const r = fromDecision({ key: 'plan:1', question: 'Go?', why: 'x', options: ['go'] })
  assert.ok(lint(r).violations.some(v => v.rule === 'L02'))
})

test('decisionFields derives the machine fields from the recommended option', () => {
  assert.deepEqual(decisionFields(GOOD), { question: GOOD.ask, why: GOOD.situation, options: ['Fix in a fresh run', 'Take over the branch yourself'],
    recommendation: 'Fix in a fresh run', reversalCost: 'low: Stop the run; the pull request stays open.' })
})

test('violation lines name rule, path and text', () => {
  assert.deepEqual(violationLines([{ rule: 'L03', path: '$.options[0].reversalCost', text: 'needs { level, how }' }]), ['L03 $.options[0].reversalCost: needs { level, how }'])
})
