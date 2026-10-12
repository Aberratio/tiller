// One pass and one fail case per rule of the hitl-request linter, taken from the rule table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { lint, lintReport } from '../lint.mjs'

const BASE = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixtures/hitl-request/valid-merge-ask.json', import.meta.url)), 'utf8'))
const req = mutate => { const r = structuredClone(BASE); mutate && mutate(r); return r }
const rules = (r, opts) => lint(r, opts).violations.map(v => v.rule)
const fails = (rule, r, opts) => assert.ok(rules(r, opts).includes(rule), `${rule} expected in ${JSON.stringify(lint(r, opts).violations)}`)
const passes = (rule, r, opts) => assert.ok(!rules(r, opts).includes(rule), `${rule} unexpected: ${JSON.stringify(lint(r, opts).violations)}`)

test('the contract fixture is clean under every rule', () => {
  assert.deepEqual(lint(BASE).violations, [])
  assert.equal(lint(BASE).ok, true)
})

test('a violation names its rule, the path and the text', () => {
  const v = lint(req(r => { r.options[0].label = 'no option offered by the lane' })).violations.find(x => x.rule === 'L04')
  assert.equal(v.path, '$.options[0].label')
  assert.match(v.text, /no option offered/)
})

const cases = {
  L01: [req(), req(r => { delete r.ifNoAnswer })],
  L02: [req(), req(r => { r.options[1].recommended = true })],
  'L02 (zero)': [req(), req(r => { r.options[0].recommended = false })],
  L03: [req(r => { r.options[0].reversalCost = { level: 'low', how: 'revert commit c933227' } }), req(r => { r.options[0].reversalCost = 'low' })],
  'L03 (placeholder how)': [req(), req(r => { r.options[1].reversalCost.how = '' })],
  L04: [req(), req(r => { r.options[1].label = 'no option offered by the lane' })],
  'L04 (not stated)': [req(), req(r => { r.options[0].reversalCost.how = 'not stated by the lane' })],
  L05: [req(r => { r.options[0].label = 'Fix in a new run'; r.options[1].label = 'Take over the branch yourself' }),
    req(r => { r.options[0].label = 'retry'; r.options[1].label = 'retry again' })],
  'L05 (gain equals loss)': [req(), req(r => { r.options[0].loss = r.options[0].gain })],
  L06: [req(r => { r.situation = 'The build job on the latest commit was cancelled after twenty five minutes of running tests.' }),
    req(r => { r.situation = 'CI stays red after two fix attempts because publishing, building the image, deploying, linting the frontend, comparing the detector with the readiness gate and checking accuracy were all skipped or cancelled by the runner on the latest commit today.' })],
  'L06 (list joined by semicolons)': [req(r => { r.situation = 'The build job on the latest commit was cancelled after twenty minutes of tests; the deploy job never started because it waits for the build.' }),
    req(r => { r.situation = 'CI stays red on the latest commit after two fix attempts: publish to storage: skipped; build the image: skipped; deploy: skipped; frontend lint and test: cancelled; accuracy check: skipped.' })],
  L07: [req(r => { r.situation = 'A short sentence. '.repeat(13).trim() }), req(r => { r.situation = 'Word. '.repeat(170).trim() })],
  L08: [req(r => { r.ask = 'Merge this pull request?' }), req(r => {
    r.ask = 'Fix forward or take over, and split?'
    r.options.push({ ...structuredClone(r.options[1]), key: 'C', label: 'Split the work', gain: 'Smaller review.', loss: 'A second ticket.' })
  })],
  'L08 (two questions)': [req(), req(r => { r.ask = 'Merge it? Or wait?' })],
  L09: [req(r => { r.situation = 'A merge check is failing.' }), req(r => { r.situation = 'TC3 inconclusive.' })],
  'L09 (D7)': [req(), req(r => { r.options[0].gain = 'Follows the D7 default.' })],
  'L09 (step key)': [req(), req(r => { r.ask = 'Close plan:1 as moot?' })],
  'L09 (gate name)': [req(), req(r => { r.situation = 'The verify-claim check is red.' })],
  'L09 (glossed)': [req(r => { r.situation = 'AC1 is not met.'; r.glossary = { AC1: 'first acceptance criterion: library covers paint' } }), req(r => { r.situation = 'AC1 is not met.' })],
  L10: [req(r => { r.situation = 'AC1 is not met.'; r.glossary = { AC1: 'first acceptance criterion' } }), req(r => { r.glossary = { AC2: 'second acceptance criterion' } })],
  L11: [req(r => { r.situation = 'ABC-101 is waiting on two failing checks.' }), req(r => { delete r.title; r.situation = 'ABC-101 is waiting on two failing checks.' })],
  'L11 (other ticket)': [req(r => { r.situation = 'ABC-103 (camera distance hint) must merge first.'; r.glossary = { 'ABC-103': 'the camera distance hint ticket' } }),
    req(r => { r.situation = 'ABC-103 must merge first.' })],
  L12: [req(r => { r.links[0].url = 'https://github.com/o/r/pull/253' }), req(r => { r.situation = 'See docs/superpowers/decisions/ABC-101.md for the record.' })],
  'L12 (home path)': [req(), req(r => { r.links[0].text = '~/.claude/plans/x' })],
  'L12 (link url)': [req(), req(r => { r.run.runUrl = '/Users/x/run-state/day' })],
  L14: [req(r => { r.links.push({ text: 'commit a78545e', url: 'https://github.com/o/r/commit/a78545e' }) }),
    req(r => { r.ask = 'Merge a78545e943bd0004957a873edae16df7a183289d?' })],
  'L14 (short sha outside a link)': [req(), req(r => { r.situation = 'The checks failed on a78545e.' })],
  L15: [req(r => { r.ifNoAnswer = { happens: 'The PR stays open and BEHIND main.', by: '2026-10-08T09:00:00Z' } }), req(r => { r.ifNoAnswer = {} })],
  'L15 (no state word)': [req(), req(r => { r.ifNoAnswer.happens = 'Nothing.' })],
  L16: [req(r => { r.situation = 'CI is cancelled by a 25-minute time limit.' }), req(r => { r.situation = 'ci-fix cap reached' })],
  'L16 (kind key)': [req(), req(r => { r.situation = 'gate-red on the latest commit.' })],
  L18: [req(), req(r => { r.situation = 'I recommend fixing it in a fresh run.' }), { target: 'pr' }],
  'L18 (attribution, any target)': [req(), req(r => { r.links[0].text = 'Generated with Claude Code' })],
  'L18 (name)': [req(), req(r => { r.options[1].label = 'Alex takes over' }), { target: 'tracker', names: ['Alex'] }],
  L19: [req(), req(r => { r.situation = 'Dwa sprawdzenia nie przechodzą na ostatnim commicie i nie wiadomo, czy to się samo naprawi.' })],
  'L19 (stated language)': [req(), req(), { language: 'pl' }],
  L20: [req(r => { r.situation = 'The access code: <REDACTED> opens the test account.' }), req(r => { r.situation = 'The access code: zzqxwvut opens the test account.' })],
  'L20 (profile redaction list)': [req(), req(r => { r.options[0].gain = 'Uses the zzqxwvut account.' }), { redact: ['zzqxwvut'] }],
}

for (const [name, [pass, fail, opts]] of Object.entries(cases)) {
  const rule = name.split(' ')[0]
  test(`${name}: pass example passes`, () => passes(rule, pass, opts && rule === 'L19' && name.includes('stated') ? {} : opts))
  test(`${name}: fail example fails`, () => fails(rule, fail, opts))
}

test('L18: first person is allowed in a message to the owner, not in a repo-facing target', () => {
  const r = req(x => { x.situation = 'I recommend fixing it in a fresh run.' })
  passes('L18', r, { target: 'chat' })
  fails('L18', r, { target: 'ledger' })
})

test('L09: a profile extends the banned list', () => {
  const r = req(x => { x.situation = 'The STS counter is off.' })
  passes('L09', r)
  fails('L09', r, { banned: ['STS'] })
})

test('L17: a report is numbered 1..N in order and blocked items come last with their return condition', () => {
  const ok = { headline: 'Two merges today.', items: [{ n: 1, do: 'Sign the pull request.', why: 'It waits only on you.' }, { n: 2, do: 'Record the session.', why: 'Blocked on the camera.', blocked: true, returnsWhen: 'The camera is back.' }] }
  assert.deepEqual(lintReport(ok).violations, [])
  const blockedFirst = structuredClone(ok)
  blockedFirst.items.reverse().forEach((x, i) => { x.n = i + 1 })
  assert.ok(lintReport(blockedFirst).violations.some(v => v.rule === 'L17'))
  const gap = structuredClone(ok)
  gap.items[1].n = 3
  assert.ok(lintReport(gap).violations.some(v => v.rule === 'L17'))
  const noReturn = structuredClone(ok)
  delete noReturn.items[1].returnsWhen
  assert.ok(lintReport(noReturn).violations.some(v => v.rule === 'L17'))
})

test('lint is deterministic: the same input gives the same violations', () => {
  const r = req(x => { x.situation = 'TC3 inconclusive on a78545e943bd0004957a873edae16df7a183289d.' })
  assert.deepEqual(lint(r), lint(structuredClone(r)))
})

test('word lists come from config/hitl-words.json, and a profile list extends them', () => {
  const words = JSON.parse(readFileSync(new URL('../../../config/hitl-words.json', import.meta.url), 'utf8'))
  assert.ok(words.stopwords.pl.includes('jest') && words.stateWords.includes('zostaje'))
  const r = req(x => { x.ifNoAnswer.happens = 'Der PR bleibt offen.' })
  assert.ok(lint(r).violations.some(v => v.rule === 'L15'))
  assert.ok(!lint(r, { stateWords: ['bleibt'] }).violations.some(v => v.rule === 'L15'))
  const de = req(x => { x.situation = 'Der PR ist nicht und der Test ist nicht grün und das ist der Stand.' })
  assert.ok(!lint(de, { language: 'en' }).violations.some(v => v.rule === 'L19' && v.path === '$.situation'))
  assert.ok(lint(de, { language: 'en', stopwords: { de: ['der', 'ist', 'nicht', 'und', 'das'] } }).violations.some(v => v.rule === 'L19' && v.path === '$.situation'))
})
