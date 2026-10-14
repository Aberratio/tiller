import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkArtefacts, parseArgs } from '../check-artefacts.mjs'
import { check } from '../../../../lib/contract/validate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'check-artefacts.mjs')

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-artefacts-test-'))
  const since = Date.now() - 60_000
  const fresh = join(dir, 'trace.zip')
  writeFileSync(fresh, 'trace')
  const empty = join(dir, 'shot.png')
  writeFileSync(empty, '')
  const stale = join(dir, 'old.webm')
  writeFileSync(stale, 'video')
  const old = new Date(since - 3_600_000)
  utimesSync(stale, old, old)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  return { dir, since, fresh, empty, stale, folder, missing: join(dir, 'nope.png') }
}

const cli = args => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { code: r.status, doc: JSON.parse(r.stdout.trim()), stdout: r.stdout }
}

test('a non-empty file written after the run start passes', () => {
  const f = fixture()
  assert.deepEqual(checkArtefacts([f.fresh], f.since), { checked: 1, pass: true, failures: [] })
})

test('missing, empty, stale and non-file artefacts each fail with their own problem', () => {
  const f = fixture()
  const r = checkArtefacts([f.fresh, f.missing, f.empty, f.stale, f.folder], f.since)
  assert.equal(r.checked, 5)
  assert.equal(r.pass, false)
  assert.deepEqual(r.failures.map(x => [x.path, x.problem]), [
    [f.missing, 'missing'],
    [f.empty, 'empty'],
    [f.stale, 'older-than-run'],
    [f.folder, 'not-a-file'],
  ])
})

test('usage errors are reported, never treated as a pass', () => {
  assert.ok(parseArgs(['a.png']).error)
  assert.ok(parseArgs(['--since', 'yesterday-ish', 'a.png']).error)
  assert.ok(parseArgs(['--since', '2026-01-01T00:00:00Z']).error)
})

test('CLI: a failing artefact is still status ok, exit 0, with pass false', () => {
  const f = fixture()
  const { code, doc } = cli(['--since', new Date(f.since).toISOString(), f.fresh, f.empty])
  assert.equal(code, 0)
  assert.equal(doc.pass, false)
  assert.deepEqual(doc.failures.map(x => x.problem), ['empty'])
  assert.deepEqual(check('script-result', doc, code), [])
})

test('CLI: bad usage is status error, kind script-error, exit 1', () => {
  const { code, doc } = cli(['only-a-path.png'])
  assert.equal(code, 1)
  assert.equal(doc.kind, 'script-error')
  assert.deepEqual(check('script-result', doc, code), [])
})

test('CLI: a result over the stdout cap moves to an artefact file', () => {
  const f = fixture()
  const many = Array.from({ length: 80 }, (_, i) => join(f.dir, `missing-${i}-${'x'.repeat(40)}.png`))
  const { code, doc, stdout } = cli(['--since', new Date(f.since).toISOString(), ...many])
  assert.equal(code, 0)
  assert.ok(stdout.length < 4096)
  assert.equal(doc.pass, false)
  assert.equal(doc.failureCount, 80)
  assert.ok(doc.artifact)
  assert.deepEqual(check('script-result', doc, code), [])
})
