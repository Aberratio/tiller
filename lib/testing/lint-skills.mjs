#!/usr/bin/env node
// Structural linter for skills/*/SKILL.md.
//
//   node lib/testing/lint-skills.mjs [--root <repo>]
//
// Prints `file:line: message` per violation and exits 1 when there is any, 0 when clean.
// Company and person names are not hardcoded: they come from the git-ignored
// profiles/*/leak-terms.txt and personal/*/leak-terms.txt, when readable.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(HERE, '..', '..')
const MAX_DESCRIPTION = 400

// Vendor-specific names that belong in adapters and config, not in skill procedure.
// `allow` is a path prefix (relative to the repo root) where the token is legitimate.
const VENDOR_TOKENS = [
  { re: /mcp__claude_ai_/, label: 'mcp__claude_ai_', allow: [] },
  // A skill that launches an unattended run may name the CLI it hands over to.
  { re: /\bclaude -p\b/, label: 'claude -p', allow: ['skills/flow-run-'] },
]

// $TILLER_HOME paths that are produced at run time or live outside the repo.
const GENERATED_PATHS = new Set([
  'config/measured.json', // written by `harness.mjs calibrate`, git-ignored
])
// Local, git-ignored directories that exist only on a machine that set them up.
const LOCAL_PREFIXES = ['helm', 'brains', 'personal', 'profiles']
// `## <word>` in prose that stands for any heading, not a real profile section.
const PLACEHOLDER_SECTIONS = new Set(['section'])

const read = p => readFileSync(p, 'utf8')
const lineOf = (text, index) => text.slice(0, index).split('\n').length

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  const fields = {}
  for (const [i, line] of m[1].split('\n').entries()) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/)
    if (kv) fields[kv[1]] = { value: kv[2], line: i + 2 }
  }
  return fields
}

export function declaredSections(root) {
  const schema = read(join(root, 'docs', 'profile-schema.md'))
  const set = new Set()
  for (const m of schema.matchAll(/`## ([^`]+)`/g)) set.add(m[1].trim().toLowerCase())
  for (const m of schema.matchAll(/^#{2,3} (.+)$/gm)) set.add(m[1].trim().toLowerCase())
  return set
}

function leakTerms(root) {
  const terms = []
  const dirs = [['profiles', '_template'], ['personal', '_templates']]
  for (const [top, skip] of dirs) {
    const base = join(root, top)
    if (!existsSync(base)) continue
    for (const d of readdirSync(base)) {
      if (d === skip) continue
      const f = join(base, d, 'leak-terms.txt')
      let body
      try { body = read(f) } catch { continue }
      for (const line of body.split('\n')) {
        if (!line.trim() || line.trim().startsWith('#')) continue
        try { terms.push(new RegExp(line.trim(), 'i')) } catch { /* a bad regex is leak-guard's to report */ }
      }
    }
  }
  return terms
}

export function lintSkills(root = DEFAULT_ROOT) {
  const violations = []
  const add = (file, line, msg) => violations.push({ file: relative(root, file), line, msg })
  const skillsDir = join(root, 'skills')
  const sections = declaredSections(root)
  const terms = leakTerms(root)

  const skillDirs = readdirSync(skillsDir).filter(d => existsSync(join(skillsDir, d, 'SKILL.md')))
  for (const dir of skillDirs) {
    const file = join(skillsDir, dir, 'SKILL.md')
    const text = read(file)

    // 1. Frontmatter
    const fm = parseFrontmatter(text)
    if (!fm) { add(file, 1, 'missing frontmatter'); continue }
    if (!fm.name) add(file, 1, 'frontmatter has no name')
    else if (fm.name.value.trim() !== dir) add(file, fm.name.line, `name "${fm.name.value}" must equal the directory name "${dir}"`)
    if (!fm.description) add(file, 1, 'frontmatter has no description')
    else {
      const d = fm.description.value
      if (d.length > MAX_DESCRIPTION) add(file, fm.description.line, `description is ${d.length} chars, limit ${MAX_DESCRIPTION}`)
      if (!/"[^"]{3,}"/.test(d)) add(file, fm.description.line, 'description has no quoted trigger phrase')
    }

    // 2. Step -1 (standard, or the documented pre-profile variant)
    const step = text.match(/^(?:#{2,3} |\*\*)Step [−-]1\b.*$/m)
    if (!step) add(file, 1, 'no Step −1 block (resolve the profile, or use the pre-profile variant in skills/_shared/resolve-profile.md)')

    // 3. Path references
    for (const m of text.matchAll(/\$TILLER_HOME\/([^\s`'")\]]+)/g)) {
      let rel = m[1].replace(/[.,;:]+$/, '')
      if (/[<>*{}$|]/.test(rel)) continue // a template, not a path
      if (GENERATED_PATHS.has(rel)) continue
      if (LOCAL_PREFIXES.some(p => rel === p || rel.startsWith(`${p}/`))) continue
      if (!existsSync(join(root, rel))) add(file, lineOf(text, m.index), `$TILLER_HOME/${rel} does not exist`)
    }
    for (const m of text.matchAll(/(?<![\w$/}])skills\/_shared\/([^\s`'")\]]+)/g)) {
      add(file, lineOf(text, m.index), `repo-relative reference skills/_shared/${m[1]}; use $TILLER_HOME/skills/_shared/...`)
    }
    for (const m of text.matchAll(/\$TILLER_HOME\/skills\/_shared\/([^\s`'")\]]+)/g)) {
      const rel = `skills/_shared/${m[1].replace(/[.,;:]+$/, '')}`
      if (!existsSync(join(root, rel))) add(file, lineOf(text, m.index), `${rel} does not exist`)
    }

    // 4. Profile sections the skill says it reads
    for (const m of text.matchAll(/`## ([a-z][a-z -]*[a-z])`/g)) {
      if (PLACEHOLDER_SECTIONS.has(m[1].toLowerCase())) continue
      if (!sections.has(m[1].toLowerCase())) {
        add(file, lineOf(text, m.index), `profile section "## ${m[1]}" is not declared in docs/profile-schema.md`)
      }
    }
  }

  // 5. Forbidden tokens across everything a skill ships
  for (const file of walk(skillsDir)) {
    if (!/\.(md|mjs|sh|json|py)$/.test(file)) continue
    const rel = relative(root, file)
    const text = read(file)
    const inTests = rel.split('/').includes('tests')
    for (const t of VENDOR_TOKENS) {
      if (inTests || t.allow.some(p => rel.startsWith(p))) continue
      const m = t.re.exec(text)
      if (m) add(file, lineOf(text, m.index), `vendor-specific "${t.label}" belongs in an adapter, not in a skill`)
    }
    for (const re of terms) {
      const m = re.exec(text)
      if (m) add(file, lineOf(text, m.index), 'matches a leak term from a local leak-terms.txt')
    }
  }
  return violations
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--root')
  const root = i > 0 ? process.argv[i + 1] : DEFAULT_ROOT
  const found = lintSkills(root)
  for (const v of found) console.log(`${v.file}:${v.line}: ${v.msg}`)
  const n = readdirSync(join(root, 'skills')).filter(d => existsSync(join(root, 'skills', d, 'SKILL.md'))).length
  console.log(found.length ? `lint-skills: ${found.length} violation(s) in ${n} skills` : `lint-skills: ${n} skills clean`)
  process.exit(found.length ? 1 : 0)
}
