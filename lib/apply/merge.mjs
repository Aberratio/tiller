// Owned-item merge into a native file. Only items the manifest records as tiller's are written;
// anything else is the user's and is left as it was. An item whose current value is neither
// tiller's recorded value nor the desired one is drift, and drift is never resolved silently.
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import { hashValue } from './manifest.mjs'
import { JsoncError, parseJsonc } from './jsonc.mjs'

export class InvalidNativeFile extends Error {
  constructor(path, why) {
    super(`${path}: ${why}`)
    this.path = path
  }
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const MISSING = Symbol('missing')

// --- locating an item in a parsed JSON document -------------------------------------------------

const segments = pointer => pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
const hookId = id => /^hook:([^:]+):(.+)$/.exec(id)

function hookGroups(doc, event) {
  const groups = isPlain(doc.hooks) && Array.isArray(doc.hooks[event]) ? doc.hooks[event] : []
  return groups
}

const hookIndex = (groups, id) => groups.findIndex(g =>
  isPlain(g) && Array.isArray(g.hooks) && g.hooks.some(h => typeof h?.command === 'string' && h.command.startsWith(`TILLER_HOOK=${id} `)))

function getItem(doc, id) {
  const hook = hookId(id)
  if (hook) {
    const groups = hookGroups(doc, hook[1])
    const i = hookIndex(groups, hook[2])
    return i >= 0 ? groups[i] : undefined
  }
  let node = doc
  for (const s of segments(id)) {
    if (!isPlain(node) || !(s in node)) return undefined
    node = node[s]
  }
  return node
}

function setItem(doc, id, value) {
  const hook = hookId(id)
  if (hook) {
    if (!isPlain(doc.hooks)) doc.hooks = {}
    if (!Array.isArray(doc.hooks[hook[1]])) doc.hooks[hook[1]] = []
    const groups = doc.hooks[hook[1]]
    const i = hookIndex(groups, hook[2])
    if (i >= 0) groups[i] = value
    else groups.push(value)
    return
  }
  const segs = segments(id)
  let node = doc
  for (const s of segs.slice(0, -1)) {
    if (node[s] === undefined) node[s] = {}
    if (!isPlain(node[s])) throw new Error(`cannot set ${id}: "${s}" is not an object`)
    node = node[s]
  }
  node[segs.at(-1)] = value
}

function removeItem(doc, id) {
  const hook = hookId(id)
  if (hook) {
    const groups = hookGroups(doc, hook[1])
    const i = hookIndex(groups, hook[2])
    if (i >= 0) groups.splice(i, 1)
    return
  }
  const segs = segments(id)
  let node = doc
  for (const s of segs.slice(0, -1)) {
    if (!isPlain(node[s])) return
    node = node[s]
  }
  delete node[segs.at(-1)]
}

// --- planning ----------------------------------------------------------------------------------

function parseJson(path, text) {
  if (text == null) return {}
  let doc
  try {
    doc = JSON.parse(text)
  } catch (e) {
    throw new InvalidNativeFile(path, `invalid JSON (${e.message})`)
  }
  if (!isPlain(doc)) throw new InvalidNativeFile(path, 'not a JSON object')
  return doc
}

export const indentOf = text => (text && /^([ \t]+)"/m.exec(text)?.[1]) || 2

function jsonCodec(target, current) {
  const doc = parseJson(target.path, current)
  return {
    get: id => getItem(doc, id),
    set: (id, v) => setItem(doc, id, v),
    remove: id => removeItem(doc, id),
    text: () => JSON.stringify(doc, null, indentOf(current)) + (current == null || current.endsWith('\n') ? '\n' : ''),
  }
}

function jsoncCodec(target, current) {
  let text = current ?? '{}\n'
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const indent = indentOf(current)
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent
  const parse = () => {
    let root
    try { root = parseJsonc(text) } catch (e) {
      if (e instanceof JsoncError) throw new InvalidNativeFile(target.path, `invalid JSON with comments (${e.message})`)
      throw e
    }
    if (root.type !== 'object') throw new InvalidNativeFile(target.path, 'not a JSON object')
    return root
  }
  let root = parse()
  const lineIndent = pos => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1))[0]
  const render = (v, base) => JSON.stringify(v, null, unit).split('\n').join(eol + base)
  const splice = (from, to, insert = '') => { text = text.slice(0, from) + insert + text.slice(to); root = parse() }
  // The deepest existing object on the pointer's path, and the member the pointer names in it.
  const locate = id => {
    const segs = segments(id)
    let obj = root
    for (let k = 0; ; k++) {
      const idx = obj.members.findLastIndex(m => m.key === segs[k])
      if (idx < 0) return { obj, k, segs }
      if (k === segs.length - 1) return { obj, k, segs, idx }
      const next = obj.members[idx].node
      if (next.type !== 'object') return { obj, k, segs, idx, blocked: true }
      obj = next
    }
  }
  return {
    get: id => {
      const { obj, idx, k, segs, blocked } = locate(id)
      return idx !== undefined && !blocked && k === segs.length - 1 ? obj.members[idx].node.value : undefined
    },
    set: (id, value) => {
      const { obj, idx, k, segs, blocked } = locate(id)
      if (blocked) throw new Error(`cannot set ${id}: "${segs[k]}" is not an object`)
      if (idx !== undefined) {
        const node = obj.members[idx].node
        return splice(node.start, node.end, render(value, lineIndent(node.start)))
      }
      let v = value
      for (const s of segs.slice(k + 1).reverse()) v = { [s]: v }
      const memberIndent = obj.members.length ? lineIndent(obj.members[0].keyStart) : lineIndent(obj.start) + unit
      const entry = `${JSON.stringify(segs[k])}: ${render(v, memberIndent)}`
      if (obj.members.length) return splice(obj.members.at(-1).node.end, obj.members.at(-1).node.end, `,${eol}${memberIndent}${entry}`)
      const inner = text.slice(obj.start + 1, obj.end - 1)
      splice(obj.start + 1, obj.end - 1, `${inner.trimEnd()}${eol}${memberIndent}${entry}${eol}${lineIndent(obj.start)}`)
    },
    remove: id => {
      const { obj, idx, k, segs, blocked } = locate(id)
      if (idx === undefined || blocked || k !== segs.length - 1) return
      const m = obj.members[idx]
      if (idx > 0) return splice(obj.members[idx - 1].node.end, m.node.end)
      if (obj.members.length > 1) {
        let to = text.indexOf(',', m.node.end) + 1
        while (/[ \t\r\n]/.test(text[to])) to++
        return splice(m.keyStart, to)
      }
      const blank = !text.slice(obj.start + 1, m.keyStart).trim() && !text.slice(m.node.end, obj.end - 1).trim()
      splice(blank ? obj.start + 1 : m.keyStart, blank ? obj.end - 1 : m.node.end)
    },
    text: () => text,
  }
}

export function plan(target, current, fileEntry, released, choices = {}) {
  const codec = codecs[target.kind](target, current)
  const desired = new Map(target.kind === 'block' ? [['block', target.body]] : target.items.map(i => [i.id, i.value]))
  const owned = { ...(fileEntry?.items ?? {}) }
  const releasedNext = [...(released ?? [])]
  const changes = [], drift = [], adopted = []
  const ids = [...desired.keys(), ...Object.keys(owned).filter(id => !desired.has(id))]

  for (const id of ids) {
    if (releasedNext.includes(id)) continue
    const want = desired.has(id) ? desired.get(id) : MISSING
    const cur = codec.get(id)
    const curHash = cur === undefined ? null : hashValue(cur)
    const wantHash = want === MISSING ? null : hashValue(want)
    const rec = owned[id]

    if (curHash === wantHash) {
      if ((rec ?? null) !== wantHash) {
        if (wantHash === null) delete owned[id]
        else owned[id] = wantHash
        changes.push({ id, op: 'own', before: cur, after: cur })
      }
      continue
    }
    const clean = rec ? curHash === rec : curHash === null
    const choice = choices[id]
    if (!clean && !choice) {
      drift.push({ id, reason: rec ? 'edited' : 'unowned-differs', current: cur, desired: want === MISSING ? undefined : want })
      continue
    }
    if (choice === 'release') {
      delete owned[id]
      releasedNext.push(id)
      continue
    }
    if (choice === 'adopt') {
      adopted.push({ id, value: cur })
      if (cur === undefined) delete owned[id]
      else owned[id] = curHash
      changes.push({ id, op: 'own', before: cur, after: cur })
      continue
    }
    if (want === MISSING) {
      codec.remove(id)
      delete owned[id]
      changes.push({ id, op: 'remove', before: cur, after: undefined })
    } else {
      codec.set(id, want)
      owned[id] = wantHash
      changes.push({ id, op: 'set', before: cur, after: want })
    }
  }

  return {
    changes,
    drift,
    adopted,
    write: changes.some(c => c.op === 'set' || c.op === 'remove'),
    next: { text: codec.text(), items: owned, released: releasedNext },
    inputs: [target, current, fileEntry, released, choices],
  }
}

export function resolveDrift(planResult, choices) {
  const [target, current, fileEntry, released, prior] = planResult.inputs
  return plan(target, current, fileEntry, released, { ...prior, ...choices })
}

// Only the text between the marker lines is read or written; everything around it keeps its bytes.
const BEGIN = '<!-- tiller:begin -->', END = '<!-- tiller:end -->'
const markerLines = (text, marker) => [...text.matchAll(new RegExp(`^[ \\t]*${marker}[ \\t]*\\r?$`, 'gm'))]

function blockCodec(target, current) {
  let text = current ?? ''
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const begins = markerLines(text, BEGIN), ends = markerLines(text, END)
  if (begins.length > 1 || ends.length > 1 || begins.length !== ends.length || (begins.length && ends[0].index < begins[0].index)) {
    throw new InvalidNativeFile(target.path, `malformed ${BEGIN} … ${END} markers`)
  }
  const span = () => {
    const [b] = markerLines(text, BEGIN), [e] = markerLines(text, END)
    if (!b) return null
    const lineEnd = m => m.index + m[0].length + (text[m.index + m[0].length] === '\n' ? 1 : 0)
    return { start: b.index, innerStart: lineEnd(b), innerEnd: e.index, end: lineEnd(e) }
  }
  const lines = body => body.split('\n').join(eol) + eol
  return {
    get: () => {
      const s = span()
      return s ? text.slice(s.innerStart, s.innerEnd).replace(/\r?\n$/, '').replace(/\r\n/g, '\n') : undefined
    },
    set: (_, body) => {
      const s = span()
      if (s) {
        text = text.slice(0, s.innerStart) + lines(body) + text.slice(s.innerEnd)
        return
      }
      if (text && !text.endsWith('\n')) text += eol
      if (text && !text.endsWith(eol + eol)) text += eol
      text += BEGIN + eol + lines(body) + END + eol
    },
    remove: () => {
      const s = span()
      if (!s) return
      let before = text.slice(0, s.start)
      if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length)
      text = before + text.slice(s.end)
    },
    text: () => text,
  }
}

const codecs = { json: jsonCodec, jsonc: jsoncCodec, block: blockCodec }

// Owned items read or removed outside a plan, for `status` and `uninstall`.
export const openNative = (path, kind, current) => codecs[kind]({ path, kind }, current)

// --- writing -----------------------------------------------------------------------------------

// Writes through a symlink to its target, so a settings file kept in a dotfiles repo stays linked.
export function writeAtomic(path, text, { backupDir, fs = nodeFs } = {}) {
  let real = path
  try { real = fs.realpathSync(path) } catch { /* a new file */ }
  let backup = null
  if (fs.existsSync(real) && backupDir) {
    backup = join(backupDir, path.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''))
    fs.mkdirSync(dirname(backup), { recursive: true })
    fs.copyFileSync(real, backup)
  }
  fs.mkdirSync(dirname(real), { recursive: true })
  const tmp = `${real}.tiller-tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, text)
    fs.renameSync(tmp, real)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* never written */ }
    throw e
  }
  return backup
}
