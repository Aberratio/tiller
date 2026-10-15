import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { laneSandbox } from '../proc.mjs'
import claude from './claude.mjs'
import codex from './codex.mjs'
import openaiCompat from './openai-compat.mjs'

const ADAPTERS = { claude, codex, 'openai-compat': openaiCompat }

export const adapterNames = () => Object.keys(ADAPTERS)

export function adapter(name) {
  const a = ADAPTERS[name]
  if (!a) throw new Error(`unknown runtime "${name}"; known: ${adapterNames().join(', ')}`)
  return a
}

// An unknown runtime has no capabilities: every check against it fails closed.
export const runtimeCan = (name, capability) => ADAPTERS[name]?.capabilities?.[capability] === true

// Each adapter says what makes it reachable, given the env and a lookup on the lanes' PATH.
// An adapter that does not say is never available.
export function runtimeAvailability(env = process.env, adapters = ADAPTERS) {
  const dirs = laneSandbox({ path: env.PATH || '' }).PATH.split(delimiter).filter(Boolean)
  const onPath = bin => dirs.some(d => existsSync(join(d, bin)))
  return Object.fromEntries(Object.entries(adapters).map(([name, a]) =>
    [name, { available: typeof a.available === 'function' && a.available(env, { onPath }) === true }]))
}
