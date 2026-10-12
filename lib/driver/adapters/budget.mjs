// Harness-side spend cap for a runtime with no native USD cap: tokens priced from config/prices.json,
// plus token, turn and wall-clock ceilings that hold even when the price is zero (self-hosted).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRICES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'prices.json')
export const loadPrices = () => JSON.parse(readFileSync(PRICES_PATH, 'utf8'))

export function priceFor(prices, runtime, model) {
  const m = prices.models || {}
  return m[`${runtime}/${model}`] || m[`${runtime}/*`] || null
}

export function budgetGuard({ runtime, model, budgetUsd, prices = loadPrices(), maxTokens, maxTurns, wallClockMs, now = Date.now }) {
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd < 0) throw new Error(`budgetUsd must be a finite non-negative number, got ${JSON.stringify(budgetUsd) ?? String(budgetUsd)}`)
  const price = priceFor(prices, runtime, model)
  if (!price) throw new Error(`no price for ${runtime}/${model} in config/prices.json; a USD budget cannot be enforced without one`)
  const limits = prices.limits || {}
  const cap = {
    tokens: Math.min(maxTokens ?? Infinity, limits.maxTokens ?? Infinity),
    turns: Math.min(maxTurns ?? Infinity, limits.maxTurns ?? Infinity),
    wallClockMs: Math.min(wallClockMs ?? Infinity, limits.wallClockMs ?? Infinity),
  }
  const started = now()
  const total = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 }
  let micro = 0, turns = 0, breach = null
  const stop = (exitClass, reason) => { breach = breach || { exitClass, reason }; return breach.reason }

  const g = {
    add(u = {}) {
      for (const k of Object.keys(total)) total[k] += u[k] || 0
      micro += (u.in || 0) * price.in + (u.out || 0) * price.out + (u.cacheRead || 0) * price.cacheRead + (u.cacheCreate || 0) * price.cacheCreate
      const tokens = total.in + total.out + total.cacheRead + total.cacheCreate
      if (micro / 1e6 > budgetUsd) return stop('budget', `budget: $${(micro / 1e6).toFixed(4)} over the $${budgetUsd} cap`)
      if (tokens > cap.tokens) return stop('budget', `tokens: ${tokens} over the ${cap.tokens} cap`)
      return g.check()
    },
    turn() {
      turns += 1
      if (turns > cap.turns) return stop('turns', `turns: ${turns} over the ${cap.turns} cap`)
      return g.check()
    },
    check() {
      if (now() - started > cap.wallClockMs) return stop('timeout', `wall clock: over ${cap.wallClockMs}ms`)
      return breach ? breach.reason : null
    },
    remainingMs: () => cap.wallClockMs - (now() - started),
    breach: () => breach,
    usage: () => ({ ...total, costUsd: micro / 1e6, costSource: 'computed' }),
  }
  return g
}
