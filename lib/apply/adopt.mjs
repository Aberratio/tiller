// `tiller apply --adopt`: what an agent's native files hold that the layers do not, and the writer
// that puts adopted values into the personal layer. Drift adopt shares the writer.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK_HEADER, leaves } from '../adapters/claude.mjs'
import { JsoncError, parseJsonc } from './jsonc.mjs'
import { hashValue } from './manifest.mjs'
import { InvalidNativeFile, openNative, writeAtomic } from './merge.mjs'

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Folds this machine's paths back into their variables so the layer applies on another machine.
// A match must end at a path boundary, so `/home/sam` does not claim `/home/samuel`.
export function portable(value, vars, platform = process.platform) {
  if (typeof value !== 'string') return value
  const forms = Object.entries(vars).flatMap(([k, path]) => {
    const out = [[path, k]]
    if (platform === 'win32') out.push([path.replace(/\\/g, '/'), k])
    return out
  }).filter(([path]) => path).sort((a, b) => b[0].length - a[0].length)
  let s = value
  for (const [path, k] of forms) s = s.replace(new RegExp(`${escapeRe(path)}(?=$|[/\\\\])`, 'g'), `\${${k}}`)
  return s
}

const portableDeep = (v, vars, platform) =>
  Array.isArray(v) ? v.map(e => portableDeep(e, vars, platform))
    : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, portableDeep(e, vars, platform)]))
      : portable(v, vars, platform)

// Claude's /env pointers come from the neutral env; every other pointer is the agent's native key.
export function writeLayer(personalDir, adopted, { vars, platform = process.platform }) {
  mkdirSync(personalDir, { recursive: true })
  const file = join(personalDir, 'harness.json')
  const layer = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const written = new Set()
  for (const { agent, id, value: raw } of adopted) {
    const value = portableDeep(raw, vars, platform)
    if (id === 'block') {
      const body = String(value ?? '').replace(new RegExp(`^${escapeRe(BLOCK_HEADER)}\\n?`), '')
      const target = join(personalDir, 'instructions.md')
      writeAtomic(target, body ? body + '\n' : '')
      written.add(target)
      continue
    }
    const segs = id.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    let node = agent === 'claude' && segs[0] === 'env' ? layer : ((layer.native ??= {})[agent] ??= {})
    for (const s of segs.slice(0, -1)) node = node[s] ??= {}
    if (value === undefined) delete node[segs.at(-1)]
    else node[segs.at(-1)] = value
    written.add(file)
  }
  if (written.has(file)) writeAtomic(file, JSON.stringify(layer, null, 2) + '\n')
  return [...written]
}

function parseDoc(path, kind, text) {
  if (text == null) return {}
  let doc
  try {
    doc = kind === 'jsonc' ? parseJsonc(text).value : JSON.parse(text)
  } catch (e) {
    if (kind === 'jsonc' && !(e instanceof JsoncError)) throw e
    throw new InvalidNativeFile(path, `invalid JSON${kind === 'jsonc' ? ' with comments' : ''} (${e.message})`)
  }
  if (!isPlain(doc)) throw new InvalidNativeFile(path, 'not a JSON object')
  return doc
}

const isTillerHook = entry => Array.isArray(entry?.hooks) && entry.hooks.every(h => String(h?.command ?? '').startsWith('TILLER_HOOK='))

// Hooks are rendered from the neutral list and have no layer key, so user entries stay where they are.
function hookLines(path, id, value) {
  const entries = (Array.isArray(value) ? value : [value]).filter(e => !isTillerHook(e))
  if (!entries.length) return []
  const n = entries.length
  return [{ path, what: `${id.slice(1).replace(/\//g, '.')}: ${n} user ${n === 1 ? 'entry' : 'entries'} stay${n === 1 ? 's' : ''} native` }]
}

export function adoptable(agent, targets, currents) {
  const items = [], left = []
  let same = 0
  for (const target of targets) {
    const { path, kind } = target
    const current = currents.get(path) ?? null
    if (kind === 'block') {
      const body = openNative(path, kind, current).get()
      if (body === undefined) { if (current != null) left.push({ path, what: 'no managed block' }); continue }
      if (hashValue(body) === hashValue(target.body)) same++
      else items.push({ path, id: 'block', value: body, op: 'set' })
      continue
    }
    // Copilot's only JSON target is tiller's own hooks file.
    if (agent === 'copilot' && kind === 'json') continue
    const rendered = new Map(target.items.map(i => [i.id, hashValue(i.value)]))
    for (const { id, value } of leaves(parseDoc(path, kind, current))) {
      if (agent === 'claude' && id.startsWith('/hooks/')) { left.push(...hookLines(path, id, value)); continue }
      if (rendered.get(id) === hashValue(value)) same++
      else items.push({ path, id, value, op: 'set' })
    }
  }
  return { items, same, left }
}
