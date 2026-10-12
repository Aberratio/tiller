// Step log: every completed driver step is recorded, so a resumed run replays finished steps instead of
// repeating their side effects.
//
//   const steps = openSteps({ root, ticket, runId })
//   await steps.withScope('review', () => steps.step('lane', { prompt, model, schema }, () => callLane()))
//
// File <root>/tickets/<ticket>/steps.jsonl, lines {runId, step, inputHash, result, at} and
// {runId, invalidateFrom}. A step is named <scope…>/<name>#<n>, n counting calls of that name in that scope.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const stable = v => {
  if (Array.isArray(v)) return `[${v.map(x => x === undefined ? 'null' : stable(x)).join(',')}]`
  if (v && typeof v === 'object') {
    if (typeof v.toJSON === 'function') return stable(v.toJSON())
    return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v === undefined ? null : v)
}

export const hashInput = input => createHash('sha256').update(stable(input)).digest('hex')

function load(path, runId) {
  const live = new Map()
  if (!existsSync(path)) return { live, count: 0 }
  let text = readFileSync(path, 'utf8')
  // A kill mid-append leaves a line without its newline; close it so the next record starts a line of its own.
  if (text && !text.endsWith('\n')) { appendFileSync(path, '\n'); text += '\n' }
  const rows = text.split('\n').slice(0, -1)
  rows.forEach((raw, index) => {
    let line
    try { line = JSON.parse(raw) } catch { return }
    if (line?.runId !== runId) return
    if (Number.isInteger(line.invalidateFrom)) {
      for (const [name, rec] of live) if (rec.index >= line.invalidateFrom) live.delete(name)
    } else if (typeof line.step === 'string' && !line.volatile) {
      live.set(line.step, { index, inputHash: line.inputHash, result: line.result })
    }
  })
  return { live, count: rows.length }
}

export function openSteps({ root, ticket, runId }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket || '')) throw new Error(`invalid ticket "${ticket}"`)
  if (!runId) throw new Error('openSteps needs a runId')
  const path = join(root, 'tickets', ticket, 'steps.jsonl')
  mkdirSync(dirname(path), { recursive: true })
  const { live, count } = load(path, runId)
  let lines = count
  const counters = new Map()
  const scopes = new AsyncLocalStorage()
  const stats = { replayed: 0, live: 0, invalidated: 0 }

  const append = obj => {
    appendFileSync(path, JSON.stringify(obj) + '\n')
    return lines++
  }

  const withScope = (scope, fn) => scopes.run([...(scopes.getStore() || []), String(scope)], fn)

  async function step(name, input, fn, { volatile = false } = {}) {
    const key = [...(scopes.getStore() || []), name].join('/')
    const n = (counters.get(key) || 0) + 1
    counters.set(key, n)
    const stepName = `${key}#${n}`
    const inputHash = hashInput(input)
    if (!volatile) {
      const rec = live.get(stepName)
      if (rec && rec.inputHash === inputHash) { stats.replayed++; return rec.result }
      if (rec) {
        append({ runId, invalidateFrom: rec.index })
        for (const [k, r] of live) if (r.index >= rec.index) live.delete(k)
        stats.invalidated++
      }
    }
    let result
    try { result = await fn() } catch (e) {
      // A failed attempt gives its number back, so the retry that succeeds is recorded under the same name.
      if (counters.get(key) === n) counters.set(key, n - 1)
      throw e
    }
    const index = append({ runId, step: stepName, inputHash, result, at: new Date().toISOString(), ...(volatile ? { volatile: true } : {}) })
    if (!volatile) live.set(stepName, { index, inputHash, result })
    stats.live++
    return result
  }

  return { step, withScope, stats }
}
