// `tiller status`: what the manifest says tiller owns on this machine, checked against the disk.
// Read-only.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readLink } from './link.mjs'
import { hashValue, loadManifest } from './manifest.mjs'
import { InvalidNativeFile, openNative } from './merge.mjs'

const readText = f => (existsSync(f) ? readFileSync(f, 'utf8') : null)

function fileStatus(path, entry, released) {
  const current = readText(path)
  let codec = null, error = null
  try {
    if (current != null) codec = openNative(path, entry.kind, current)
  } catch (e) {
    if (!(e instanceof InvalidNativeFile)) throw e
    error = e.message
  }
  const items = Object.entries(entry.items).map(([id, hash]) => {
    if (error) return { id, state: 'unreadable' }
    const cur = codec?.get(id)
    return { id, state: cur === undefined ? 'missing' : hashValue(cur) === hash ? 'ok' : 'drifted' }
  })
  return { path, agent: entry.agent, items, released: released ?? [], ...(error ? { error } : {}) }
}

export function linkState(dest, entry) {
  const st = readLink(dest)
  if (st == null) return 'missing'
  if (entry.mode === 'symlink') {
    if (st.type !== 'symlink' || st.target !== entry.source) return 'foreign'
    return existsSync(entry.source) ? 'ok' : 'stale'
  }
  if (st.type === 'symlink' || !statSync(dest).isFile()) return 'foreign'
  return hashValue(readFileSync(dest, 'utf8')) === entry.hash ? 'ok' : 'drifted'
}

const nameOf = dest => dest.split(/[\\/]/).pop().replace(/(\.agent)?\.md$/, '')

export function runStatus({ stateHome }) {
  const m = loadManifest(stateHome)
  return {
    files: Object.entries(m.files).map(([path, entry]) => fileStatus(path, entry, m.released[path])),
    links: Object.entries(m.links).map(([dest, entry]) =>
      ({ dest, agent: entry.agent, kind: entry.kind, name: nameOf(dest), state: linkState(dest, entry) })),
    releasedLinks: Object.entries(m.released).filter(([, ids]) => ids.includes('link')).map(([dest]) => dest),
  }
}

export function printStatus(s, out) {
  if (!s.files.length && !s.links.length && !s.releasedLinks.length) {
    out('tiller manages nothing on this machine yet; run tiller apply\n')
    return
  }
  for (const f of s.files) {
    out(`${f.agent}: ${f.path}${f.error ? ` (${f.error})` : ''}\n`)
    for (const i of f.items) out(`  ${i.state.padEnd(9)}${i.id}\n`)
    for (const id of f.released) out(`  ${'released'.padEnd(9)}${id}\n`)
  }
  for (const agent of [...new Set(s.links.map(l => l.agent))]) {
    const mine = s.links.filter(l => l.agent === agent)
    out(`${agent}: ${mine.filter(l => l.state === 'ok').length} links ok\n`)
    for (const l of mine.filter(l => l.state !== 'ok')) out(`  ${l.state.padEnd(9)}${l.kind} ${l.name} ${l.dest}\n`)
  }
  for (const dest of s.releasedLinks) out(`  ${'released'.padEnd(9)}${dest}\n`)
}
