// The ownership manifest (<stateHome>/owned.json): which items of which native files tiller wrote,
// each with the hash of the value it wrote, so a later apply can tell its own value from an edit;
// and which skill links and rendered agent files are tiller's.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const empty = () => ({ version: 1, files: {}, released: {}, links: {} })

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export const hashValue = v => createHash('sha256').update(canonical(v)).digest('hex')

export function loadManifest(stateHome) {
  const file = join(stateHome, 'owned.json')
  if (!existsSync(file)) return empty()
  try {
    return { ...empty(), ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    throw new Error(`${file}: ${e.message}`)
  }
}

export function saveManifest(stateHome, m) {
  mkdirSync(stateHome, { recursive: true })
  const file = join(stateHome, 'owned.json')
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n')
  renameSync(tmp, file)
}
