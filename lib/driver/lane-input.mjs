// The exact input of one live lane call, kept under the run's state dir so a verdict can be
// re-asked later with the same prompt, model and files. Secrets never reach disk.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../hitl/secrets.mjs'

const TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]

export function redact(text, literals = []) {
  let s = redactSecrets(text, literals)
  s = s.replace(/\b([A-Z][A-Z0-9_]{2,})=("[^"]*"|'[^']*'|\S+)/g, '$1=<REDACTED>')
  s = s.replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <REDACTED>')
  for (const re of TOKENS) s = s.replace(re, '<REDACTED>')
  return s
}

function gitSha(cwd) {
  if (!cwd || !existsSync(cwd)) return null
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

// Files a lane is pointed at by absolute path in its prompt.
function attached(prompt) {
  const out = []
  for (const m of new Set(String(prompt).match(/(?<![\w.])\/[^\s'"`)(,;]+[^\s'"`)(,;.:]/g) || [])) {
    try {
      if (!statSync(m).isFile()) continue
      out.push({ path: m, sha256: createHash('sha256').update(readFileSync(m)).digest('hex') })
    } catch {}
    if (out.length >= 50) break
  }
  return out
}

export function captureLaneInput(root, { ticket, label, prompt, schema, model, runtime, budgetUsd, agentType, cwd, redactList = [] }) {
  const dir = join(root, 'lane-inputs', String(ticket).replace(/[^A-Za-z0-9._-]+/g, '_'))
  mkdirSync(dir, { recursive: true })
  const base = String(label).replace(/[^A-Za-z0-9._-]+/g, '_')
  let path = join(dir, `${base}.json`)
  for (let i = 2; existsSync(path); i++) path = join(dir, `${base}-${i}.json`)
  const doc = { label, prompt: redact(prompt, redactList), schema, model: model ?? null, runtime, budgetUsd: budgetUsd ?? null, agentType: agentType || null,
    cwd, gitSha: gitSha(cwd), files: attached(prompt), at: new Date().toISOString() }
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  return path
}
