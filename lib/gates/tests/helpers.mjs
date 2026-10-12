import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..', '..')
export const FIXTURE = join(HERE, 'fixtures', 'profile.md')
const FACTS = join(ROOT, 'lib', 'profile-facts.sh')

export function profileFacts(profilePath, check = false) {
  const args = [FACTS, ...(check ? ['--check'] : []), '--profile', profilePath]
  const r = spawnSync('bash', args, { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

export function renderFacts(profilePath) {
  const r = profileFacts(profilePath)
  if (r.code !== 0) throw new Error(`profile-facts exit ${r.code}: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

// A copy of the fixture profile with `edit` applied to its text, written to a temp dir.
export function variant(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'gates-test-'))
  const path = join(dir, 'profile.md')
  writeFileSync(path, edit(readFileSync(FIXTURE, 'utf8')))
  return path
}

export const dropSection = (text, heading) =>
  text.replace(new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## )`, 'm'), '')

export const replaceSection = (text, heading, body) =>
  text.replace(new RegExp(`(^## ${heading}\\n)[\\s\\S]*?(?=^## )`, 'm'), `$1\n${body}\n\n`)
