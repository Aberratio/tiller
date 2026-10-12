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

// A runtime counts as available when its binary is on the lanes' PATH or its endpoint is configured.
const NEEDS = { claude: { bin: 'claude' }, codex: { bin: 'codex' }, 'openai-compat': { env: 'OPENAI_COMPAT_BASE_URL' } }

export function runtimeAvailability(env = process.env) {
  const dirs = laneSandbox({ path: env.PATH || '' }).PATH.split(delimiter).filter(Boolean)
  return Object.fromEntries(adapterNames().map(name => {
    const n = NEEDS[name] || {}
    const available = n.bin ? dirs.some(d => existsSync(join(d, n.bin))) : !!(n.env && env[n.env])
    return [name, { available }]
  }))
}
