// Every <name>/cases.json pins paths to the authority its profile must give them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { authorityOf } from '../evaluate.mjs'
import { ROOT, renderFacts } from './helpers.mjs'

// The synthetic fixture always runs; local profiles under profiles/ run when present.
const DIRS = [join(ROOT, 'lib', 'testing', 'fixtures'), join(ROOT, 'profiles')]

const named = DIRS.flatMap(dir => existsSync(dir)
  ? readdirSync(dir).filter(n => !n.startsWith('_') && existsSync(join(dir, n, 'cases.json'))).map(n => ({ dir, name: n }))
  : [])
for (const { dir, name } of named) {
  const file = join(dir, name, 'cases.json')
  test(`${name}: merge authority matches its cases`, () => {
    const profile = join(dir, name, 'profile.md')
    assert.ok(existsSync(profile), `${file} has no profile.md`)
    const { mergeAuthority } = renderFacts(profile)
    const { cases } = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(cases.length > 0, `${file} lists no cases`)
    const wrong = cases
      .map(c => ({ ...c, got: authorityOf(c.path, mergeAuthority) }))
      .filter(c => c.got !== c.who)
    assert.deepEqual(wrong, [])
  })
}
