// Expected texts are written out by hand from the layout in the plan, not produced by the renderer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { render } from '../render.mjs'

const BASE = JSON.parse(readFileSync(fileURLToPath(new URL('../../contract/fixtures/hitl-request/valid-merge-ask.json', import.meta.url)), 'utf8'))
const req = mutate => { const r = structuredClone(BASE); mutate && mutate(r); return r }

test('terminal: fixed order, recommended first and marked, wrapped at 80 columns, no markup', () => {
  assert.equal(render(BASE, 'terminal'), [
    'Practice screen shows the camera hint - ABC-101-D5',
    'Situation: Two merge checks are failing on the latest commit. The build job was',
    '  cancelled by its 25-minute time limit.',
    'Question: Should a fresh run fix the failing checks?',
    '  1. A (Recommended) Fix in a fresh run',
    '     gain: No one has to touch the branch.',
    '     loss: Another hour of build time.',
    '     undo: low - Stop the run; the pull request stays open.',
    '  2. B Take over the branch yourself',
    '     gain: The fix lands today.',
    '     loss: Your afternoon goes to build failures.',
    '     undo: low - Hand the branch back with a comment.',
    'If nobody answers: The pull request stays open and falls behind main. (by',
    '  2026-10-08T09:00:00Z, then A)',
    'Links:',
    '  Pull request 251: https://github.com/o/r/pull/251',
    '  Run: https://example.com/runs/day-2026-10-06',
    'Reply with: A or B (+ optional note)',
    '',
  ].join('\n'))
})

test('markdown: a numbered choice list with gain, loss and undo per option', () => {
  assert.equal(render(BASE, 'markdown'), [
    '**Practice screen shows the camera hint** - ABC-101-D5',
    '',
    '**Situation:** Two merge checks are failing on the latest commit. The build job was cancelled by its 25-minute time limit.',
    '',
    '**Question:** Should a fresh run fix the failing checks?',
    '',
    '1. **A (Recommended): Fix in a fresh run**',
    '   - Gain: No one has to touch the branch.',
    '   - Loss: Another hour of build time.',
    '   - Undo: low - Stop the run; the pull request stays open.',
    '2. **B: Take over the branch yourself**',
    '   - Gain: The fix lands today.',
    '   - Loss: Your afternoon goes to build failures.',
    '   - Undo: low - Hand the branch back with a comment.',
    '',
    '**If nobody answers:** The pull request stays open and falls behind main. (by 2026-10-08T09:00:00Z, then A)',
    '',
    '**Links:** [Pull request 251](https://github.com/o/r/pull/251) · [Run](https://example.com/runs/day-2026-10-06)',
    '',
    'Reply with: A or B (+ optional note)',
    '',
  ].join('\n'))
})

const glossed = req(r => {
  r.situation = 'AC1 is not met on the latest commit.'
  r.glossary = { AC1: 'first acceptance criterion: library covers paint', 'ABC-900': 'an unrelated ticket' }
})

test('forge comment: markdown with the glossary collapsed, only the terms the text uses', () => {
  const out = render(glossed, 'forge-comment')
  assert.ok(out.includes('<details><summary>Terms</summary>\n\n- **AC1**: first acceptance criterion: library covers paint\n\n</details>\n'), out)
  assert.ok(!out.includes('ABC-900'), 'an unused glossary entry is not printed')
})

test('markdown and terminal print the glossary inline', () => {
  assert.ok(render(glossed, 'markdown').includes('**Terms:**\n- **AC1**: first acceptance criterion: library covers paint\n'))
  assert.ok(render(glossed, 'terminal').includes('Terms:\n  AC1 = first acceptance criterion: library covers paint\n'))
})

test('the recommended option is printed first whatever its key', () => {
  const r = req(x => { x.options[0].recommended = false; x.options[1].recommended = true })
  const out = render(r, 'terminal')
  assert.ok(out.includes('  1. B (Recommended) Take over the branch yourself\n'), out)
  assert.ok(out.includes('  2. A Fix in a fresh run\n'), out)
})

test('a request with no deadline says the run waits; three options are offered as A, B or C', () => {
  const r = req(x => {
    x.ifNoAnswer = { happens: 'The run waits.', by: 'never' }
    x.options.push({ ...structuredClone(x.options[1]), key: 'C', label: 'Close the pull request' })
  })
  const out = render(r, 'terminal')
  assert.ok(out.includes('If nobody answers: The run waits. (no deadline)\n'), out)
  assert.ok(out.includes('Reply with: A, B or C (+ optional note)\n'), out)
})

test('markdown escapes text that would turn into markup or HTML', () => {
  const out = render(req(x => { x.situation = 'A *bold* <details> claim.' }), 'markdown')
  assert.ok(out.includes('**Situation:** A \\*bold\\* \\<details\\> claim.'), out)
})

test('a pull request URL not already linked is added to the links', () => {
  const out = render(req(x => { x.links = [{ text: 'Ticket', url: 'https://example.com/t' }] }), 'markdown')
  assert.ok(out.includes('[Ticket](https://example.com/t) · [Pull request](https://github.com/o/r/pull/251) · [Run]('), out)
})

test('same input, byte-identical output; the machine kind is never printed', () => {
  for (const t of ['markdown', 'terminal', 'forge-comment']) {
    assert.equal(render(BASE, t), render(structuredClone(BASE), t))
    assert.ok(!render(BASE, t).includes('gate-red'))
  }
})

test('terminal lines never exceed 80 columns unless one word is longer', () => {
  const r = req(x => { x.situation = 'word '.repeat(55).trim() + '.' })
  for (const line of render(r, 'terminal').split('\n')) assert.ok(line.length <= 80, line)
})

test('an unknown target is refused', () => {
  assert.throws(() => render(BASE, 'slack'), /unknown target/)
})
