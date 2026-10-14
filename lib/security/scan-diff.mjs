#!/usr/bin/env node
// Scripted security pass over a branch diff, run before any model grades it: what a regex or the
// project's own audit tool can measure is never left to a model's attention.
//
//   scan-diff.mjs --repo <dir> --base <ref> --head <ref> [--profile <profile.md>]
//
// Diffs `base...head` (from their merge base, as a PR shows it) and reports:
// - `credential` (blocker): an added line matching a credential shape. The shapes are the `SECRETS`
//   pattern of lib/leak-guard.sh, read from that file so the two never drift. The value is never echoed.
// - `dependency-change` (medium): a manifest or lockfile added, changed or removed, one per file.
// - `audit` (high): the profile's `## security` `- Audit command:` (one code span) exits non-zero. It
//   runs under `sh -c` in `--repo`. A command that is prose, TODO, not found (126/127), killed or
//   timed out is also high, with `source: "toolchain"`, so the runner holds it for the gate.
//
// Payload: `findings[]` in the confidence-dimension finding shape (id, axis, severity, summary,
// locations, plus `category` and, for tooling, `source`), severest first; `total`; `audit`
// (`{command, exitCode}` or null). Findings that do not fit one stdout line are cut from the end
// and the full list is written to `artifact`. Fails closed: when the diff, the arguments or the
// profile cannot be read, the result is `error`/`script-error` and still carries one high finding.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isRunnableCell } from '../resilience/verify-claim.mjs'

const STDOUT_CAP = 4000
const AUDIT_TIMEOUT_MS = 10 * 60 * 1000
const SEVERITY_ORDER = ['blocker', 'high', 'medium', 'low']
const DEPENDENCY_FILE = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile|Gemfile\.lock|requirements[^/]*\.txt|poetry\.lock|pyproject\.toml|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock)$/
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

// Splits a regex on its top-level `|`, so each credential shape is reported by its own label.
function alternatives(src) {
  const body = src.startsWith('(') && src.endsWith(')') ? src.slice(1, -1) : src
  const out = []
  let depth = 0, inClass = false, cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\') { cur += ch + (body[i + 1] ?? ''); i++; continue }
    if (inClass) { if (ch === ']') inClass = false }
    else if (ch === '[') inClass = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.filter(Boolean)
}

export function credentialPatterns(guardPath = new URL('../leak-guard.sh', import.meta.url)) {
  const text = readFileSync(guardPath, 'utf8')
  const m = /^SECRETS='([^']+)'$/m.exec(text)
  if (!m) throw new Error('lib/leak-guard.sh has no SECRETS=\'...\' line to read the credential shapes from')
  return alternatives(m[1]).map(src => ({ label: src.replace(/\[[^\]]*\]|\{[^}]*\}|[\\()?*+]/g, '').replace(/-+$/, '') || src, re: new RegExp(src) }))
}

// Body of one `## heading`, up to the next `## `.
function section(text, heading) {
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (line.trim().toLowerCase() === `## ${heading}`) { inside = true; continue }
    if (inside && /^##\s/.test(line)) break
    if (inside) out.push(line)
  }
  return inside ? out : null
}

// { command: string|null } or { error } when the profile declares an audit it does not spell as one command.
export function auditCommand(profileText) {
  const body = section(profileText, 'security')
  if (!body) return { command: null }
  const first = body.find(l => l.trim())
  if (!first || /^none\b/i.test(first.trim())) return { command: null }
  const line = body.map(l => /^\s*-\s*Audit command:\s*(.*)$/i.exec(l)).find(Boolean)
  if (!line) return { command: null }
  const cell = line[1].trim()
  if (!isRunnableCell(cell)) return { error: `the profile's audit command is not one runnable code span: ${clip(cell, 120)}` }
  return { command: cell.slice(1, -1) }
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

// Added lines with their new-file line numbers, from a zero-context unified diff.
function addedLines(diff) {
  const out = []
  let file = null, line = 0, inHunk = false
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { file = null; inHunk = false; continue }
    if (!inHunk && raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.slice(4).replace(/^b\//, ''); continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (h) { line = Number(h[1]); inHunk = true; continue }
    if (!inHunk || !file) continue
    if (raw.startsWith('+')) { out.push({ file, line, text: raw.slice(1) }); line++ }
    else if (raw.startsWith(' ')) line++
  }
  return out
}

function finding(id, category, severity, summary, locations, source) {
  return { id, axis: 'security', category, severity, summary: clip(summary, 300), locations, ...(source ? { source } : {}) }
}

function runAudit(command, cwd) {
  const p = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
  const tail = clip(String((p.stdout || '') + '\n' + (p.stderr || '')).trim().split('\n').filter(Boolean).pop() || '', 200)
  if (p.error || p.signal) return { exitCode: p.status ?? null, finding: finding('SEC-AUDIT', 'audit', 'high', `audit command "${clip(command, 120)}" did not finish: ${p.error ? p.error.message : `killed by ${p.signal}`}`, [], 'toolchain') }
  if (p.status === 126 || p.status === 127) return { exitCode: p.status, finding: finding('SEC-AUDIT', 'audit', 'high', `audit command "${clip(command, 120)}" could not run (exit ${p.status}: ${tail})`, [], 'toolchain') }
  if (p.status !== 0) return { exitCode: p.status, finding: finding('SEC-AUDIT', 'audit', 'high', `audit command "${clip(command, 120)}" reports a problem (exit ${p.status}): ${tail}`, []) }
  return { exitCode: 0, finding: null }
}

export function scan({ repo, base, head, profileText }) {
  const range = `${base}...${head}`
  const names = git(repo, ['diff', '--name-only', '--no-renames', range])
  if (names.status !== 0) throw new Error(`git diff ${range} failed in ${repo}: ${clip(names.stderr, 200)}`)
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', '--unified=0', range])
  if (diff.status !== 0) throw new Error(`git diff ${range} failed in ${repo}: ${clip(diff.stderr, 200)}`)

  const findings = []
  const patterns = credentialPatterns()
  let n = 0
  for (const a of addedLines(diff.stdout)) {
    const hit = patterns.find(p => p.re.test(a.text))
    if (hit) findings.push(finding(`SEC-CRED-${++n}`, 'credential', 'blocker', `credential shape ${hit.label} added at ${a.file}:${a.line}; remove it and rotate the credential`, [`${a.file}:${a.line}`]))
  }
  const changed = names.stdout.split('\n').filter(Boolean)
  changed.filter(f => DEPENDENCY_FILE.test(f.split('/').pop())).forEach((f, i) =>
    findings.push(finding(`SEC-DEP-${i + 1}`, 'dependency-change', 'medium', `dependency manifest or lockfile changed: ${f}`, [f])))

  let audit = null
  if (profileText != null) {
    const a = auditCommand(profileText)
    if (a.error) findings.push(finding('SEC-AUDIT', 'audit', 'high', a.error, [], 'toolchain'))
    else if (a.command) {
      const r = runAudit(a.command, repo)
      audit = { command: clip(a.command, 200), exitCode: r.exitCode }
      if (r.finding) findings.push(r.finding)
    }
  }
  findings.sort((x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity))
  return { status: 'ok', base, head, changedFiles: changed.length, total: findings.length, audit, findings }
}

function fit(result) {
  if (JSON.stringify(result).length <= STDOUT_CAP) return result
  const dir = mkdtempSync(join(tmpdir(), 'scan-diff-'))
  const artifact = join(dir, 'findings.json')
  writeFileSync(artifact, JSON.stringify(result.findings, null, 1))
  const out = { ...result, artifact, findings: [...result.findings] }
  while (out.findings.length && JSON.stringify(out).length > STDOUT_CAP) out.findings.pop()
  return out
}

function failClosed(reason) {
  return { status: 'error', kind: 'script-error', reason: clip(reason, 300),
    findings: [finding('SEC-SCAN-ERROR', 'scan-error', 'high', `security scan did not run: ${reason}`, [], 'harness')] }
}

function main() {
  const argv = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opts[argv[i].slice(2)] = argv[++i]
  let result
  try {
    if (!opts.repo || !opts.base || !opts.head) throw new Error('usage: scan-diff.mjs --repo <dir> --base <ref> --head <ref> [--profile <profile.md>]')
    const profileText = opts.profile ? readFileSync(opts.profile, 'utf8') : null
    result = fit(scan({ repo: opts.repo, base: opts.base, head: opts.head, profileText }))
  } catch (e) {
    result = failClosed(e.message)
  }
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exit(result.status === 'ok' ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
