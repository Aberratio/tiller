import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InvalidNativeFile, plan } from '../merge.mjs'
import { hashValue } from '../manifest.mjs'

const PATH = '/h/.copilot/settings.json'
const target = items => ({ path: PATH, kind: 'jsonc', items })
const step = (t, current, entry = null) => plan(t, current, entry, [])
const entryOf = p => ({ kind: 'jsonc', items: p.next.items })
const strip = text => JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))

const USER = `{
  // my model
  "model": "x", /* trailing note */
  "theme": {
    // keep me
    "name": "dark"
  }
}
`

test('a new nested key is inserted and every comment of the user survives', () => {
  const p = step(target([{ id: '/theme/accent', value: 'blue' }, { id: '/a/b', value: [1, 2] }]), USER)
  assert.equal(p.write, true)
  const text = p.next.text
  for (const c of ['// my model', '/* trailing note */', '// keep me']) assert.ok(text.includes(c), c)
  assert.deepEqual(strip(text), { model: 'x', theme: { name: 'dark', accent: 'blue' }, a: { b: [1, 2] } })
  assert.ok(text.endsWith('}\n'))
})

test('a second plan on the written text changes nothing', () => {
  const t = target([{ id: '/theme/accent', value: 'blue' }, { id: '/a/b', value: { c: true } }])
  const first = step(t, USER)
  const again = step(t, first.next.text, entryOf(first))
  assert.deepEqual([again.changes, again.drift, again.write], [[], [], false])
})

test('an owned value is replaced in place and the comment beside it is kept', () => {
  const t1 = target([{ id: '/model', value: 'x' }])
  const own = step(t1, USER)
  assert.deepEqual(own.changes.map(c => c.op), ['own'])
  const p = step(target([{ id: '/model', value: 'y' }]), USER, entryOf(own))
  assert.equal(p.next.text, USER.replace('"model": "x"', '"model": "y"'))
})

test('an owned key no longer desired is removed, the rest keeps its bytes', () => {
  const t = target([{ id: '/theme/accent', value: 'blue' }])
  const first = step(t, USER)
  const removed = step(target([]), first.next.text, entryOf(first))
  assert.deepEqual(removed.changes.map(c => [c.id, c.op]), [['/theme/accent', 'remove']])
  assert.equal(removed.next.text, USER)
})

test('removing the first member of an object keeps the following members and comments', () => {
  const text = '{\n  "a": 1,\n  // about b\n  "b": 2\n}\n'
  const p = plan(target([]), text, { kind: 'jsonc', items: { '/a': hashValue(1) } }, [])
  assert.equal(p.next.text, '{\n  // about b\n  "b": 2\n}\n')
})

test('a missing file is created as plain JSON with two-space indent', () => {
  const p = step(target([{ id: '/x/y', value: 1 }]), null)
  assert.equal(p.next.text, '{\n  "x": {\n    "y": 1\n  }\n}\n')
})

test('an empty object gains its first member on its own line', () => {
  const p = step(target([{ id: '/k', value: 'v' }]), '{}\n')
  assert.equal(p.next.text, '{\n  "k": "v"\n}\n')
})

test('the file indent is kept', () => {
  const p = step(target([{ id: '/k', value: { a: 1 } }]), '{\n    "m": 1\n}\n')
  assert.equal(p.next.text, '{\n    "m": 1,\n    "k": {\n        "a": 1\n    }\n}\n')
})

test('a string holding comment-like text is a value, not a comment', () => {
  const text = '{ "url": "https://x//y", "s": "/* no */" }\n'
  const p = step(target([{ id: '/url', value: 'https://x//y' }]), text)
  assert.deepEqual(p.changes.map(c => c.op), ['own'])
  assert.equal(p.next.text, text)
})

test('invalid JSONC, a trailing comma and a non-object are refused', () => {
  for (const text of ['{ "a": 1', '{ "a": 1, }', '[1]', '{ /* open', '{ "a": 1 } x']) {
    assert.throws(() => step(target([{ id: '/a', value: 1 }]), text), InvalidNativeFile, text)
  }
})

test('drift is reported for an edited owned value', () => {
  const t = target([{ id: '/model', value: 'x' }])
  const own = step(t, USER)
  const p = step(t, USER.replace('"x"', '"z"'), entryOf(own))
  assert.deepEqual(p.drift.map(d => [d.id, d.reason, d.current]), [['/model', 'edited', 'z']])
  assert.equal(p.write, false)
})

test('removing the only member of a nested object leaves an empty object', () => {
  const text = '{\n  "a": {\n    "b": 1\n  },\n  "c": 2\n}\n'
  const p = plan(target([]), text, { kind: 'jsonc', items: { '/a/b': hashValue(1) } }, [])
  assert.equal(p.next.text, '{\n  "a": {},\n  "c": 2\n}\n')
})
