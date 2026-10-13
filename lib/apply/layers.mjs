// Desired state in layers, later wins: tracked base, the person's layer, this machine's values.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: ${e.message}`)
  }
}

export function readLayers({ tillerHome, personalDir, stateHome }) {
  const baseDir = join(tillerHome, 'config', 'harness')
  const layers = [{ name: 'base', dir: baseDir, data: readJson(join(baseDir, 'base.json')) }]
  if (personalDir && existsSync(personalDir)) {
    const file = join(personalDir, 'harness.json')
    layers.push({ name: 'personal', dir: personalDir, data: existsSync(file) ? readJson(file) : {} })
  }
  const machineFile = join(stateHome, 'machine.json')
  if (existsSync(machineFile)) {
    const { probe, user, ...data } = readJson(machineFile)
    layers.push({ name: 'machine', dir: stateHome, data })
  }
  return layers
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const byId = arr => Array.isArray(arr) && arr.length > 0 && arr.every(e => isPlain(e) && typeof e.id === 'string')

function mergeById(a, b) {
  const out = Array.isArray(a) ? a.map(e => ({ ...e })) : []
  for (const entry of b) {
    const i = out.findIndex(e => e.id === entry.id)
    if (entry.remove === true) {
      if (i >= 0) out.splice(i, 1)
    } else if (i >= 0) {
      out[i] = merge(out[i], entry)
    } else {
      out.push(entry)
    }
  }
  return out
}

function merge(a, b) {
  if (!isPlain(a) || !isPlain(b)) return b
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k]
    else if (byId(v)) out[k] = mergeById(out[k], v)
    else out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v
  }
  return out
}

function expand(v, vars) {
  if (typeof v === 'string') return v.replace(/\$\{(TILLER_HOME|HOME)\}/g, (_, k) => vars[k])
  if (Array.isArray(v)) return v.map(e => expand(e, vars))
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, expand(e, vars)]))
  return v
}

// The instructions file is looked up in each layer's own directory; the last layer holding it wins.
function instructionsBody(layers, file) {
  let body = ''
  if (!file) return body
  for (const layer of layers) {
    const path = join(layer.dir, file)
    if (existsSync(path)) body = readFileSync(path, 'utf8').replace(/\s+$/, '')
  }
  return body
}

export function resolve(layers, { vars }) {
  const merged = expand(layers.reduce((acc, l) => merge(acc, l.data), {}), vars)
  return {
    env: merged.env ?? {},
    hooks: merged.hooks ?? [],
    agents: merged.agents ?? [],
    instructions: { body: instructionsBody(layers, merged.instructions?.file) },
    native: merged.native ?? {},
  }
}
