// `tiller uninstall`: undo what the manifest says tiller owns, for the chosen agents. An item, block
// or agent file edited since tiller wrote it is kept and reported; a path that is no longer tiller's
// is left in place. Nothing is changed until everything has been planned and confirmed.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { linkState } from './status.mjs'
import { isLinkMode, unlink } from './link.mjs'
import { hashValue, loadManifest, saveManifest } from './manifest.mjs'
import { InvalidNativeFile, openNative, writeAtomic } from './merge.mjs'

const readText = f => (existsSync(f) ? readFileSync(f, 'utf8') : null)
const isEmpty = v => (Array.isArray(v) ? !v.length : v !== null && typeof v === 'object' && !Object.keys(v).length)

// Containers a removed item leaves empty were tiller's scaffolding, so they go with it.
function ancestors(id) {
  const hook = /^hook:([^:]+):/.exec(id)
  if (hook) return [`/hooks/${hook[1]}`, '/hooks']
  const segs = id.slice(1).split('/')
  return segs.slice(0, -1).map((_, i) => '/' + segs.slice(0, segs.length - 1 - i).join('/'))
}

// Equal ignoring formatting: the surgical result then holds no user edit, so the backup can return as it was.
function sameContent(kind, a, b) {
  if (kind === 'json') {
    try { return hashValue(JSON.parse(a)) === hashValue(JSON.parse(b)) } catch { return false }
  }
  return a.replace(/\s+/g, '') === b.replace(/\s+/g, '')
}

function planFile(path, entry, released) {
  const current = readText(path)
  if (current == null) return { path, entry, action: 'forget' }
  let codec
  try {
    codec = openNative(path, entry.kind, current)
  } catch (e) {
    if (!(e instanceof InvalidNativeFile)) throw e
    return { path, entry, action: 'unreadable', reason: e.message }
  }
  const removed = [], kept = []
  for (const [id, hash] of Object.entries(entry.items)) {
    const cur = codec.get(id)
    if (cur === undefined) continue
    if (hashValue(cur) !== hash) { kept.push(id); continue }
    codec.remove(id)
    removed.push(id)
    if (entry.kind === 'block') continue
    for (const a of ancestors(id)) if (isEmpty(codec.get(a))) codec.remove(a)
  }
  const surgical = codec.text()
  const baseline = entry.created ? (entry.kind === 'block' ? '' : '{}') : readText(entry.backup ?? '')
  const untouched = hashValue(current) === entry.writtenHash && !released?.length && !kept.length
  if (untouched && baseline != null && sameContent(entry.kind, surgical, baseline)) {
    return { path, entry, action: entry.created ? 'delete' : 'restore', removed }
  }
  if (surgical === current) return { path, entry, action: 'forget', kept }
  return { path, entry, action: 'surgical', text: surgical, removed, kept }
}

function planLinkGone(dest, entry, platform) {
  const state = linkState(dest, entry, platform)
  if (state === 'ok' || state === 'stale') return { dest, entry, action: 'remove' }
  if (state === 'drifted') return { dest, entry, action: 'kept' }
  return { dest, entry, action: state === 'missing' ? 'forget' : 'foreign' }
}

const nameOf = dest => basename(dest).replace(/(\.agent)?\.md$/, '')

function printPlan(files, links, out) {
  for (const f of files) {
    const a = f.entry.agent
    if (f.action === 'delete') out(`${a}: delete ${f.path} (tiller created it)\n`)
    else if (f.action === 'restore') out(`${a}: restore ${f.path} from ${f.entry.backup}\n`)
    else if (f.action === 'unreadable') out(`${a}: ${f.reason}; left in place\n`)
    else if (f.action === 'surgical' || f.kept?.length) {
      out(`${a}: ${f.path}\n`)
      for (const id of f.removed ?? []) out(`  - ${id}\n`)
    }
    for (const id of f.kept ?? []) out(`  kept edited ${id}\n`)
  }
  for (const l of links) {
    const what = `${l.entry.kind} ${nameOf(l.dest)} ${l.dest}`
    if (l.action === 'remove') out(`${l.entry.agent}: - ${what}\n`)
    else if (l.action === 'kept') out(`${l.entry.agent}: kept ${l.dest}, edited since tiller wrote it\n`)
    else if (l.action === 'foreign') out(`${l.entry.agent}: ? ${what} is no longer tiller's; left in place\n`)
  }
}

function backUp(path, backupDir) {
  const to = join(backupDir, path.replace(/^[A-Za-z]:/, '').replace(/^[\\/]+/, ''))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(path, to)
}

export function runUninstall({ stateHome, agents, platform, yes, dryRun, isTTY, prompt, out }) {
  const manifest = loadManifest(stateHome)
  const chosen = a => !agents || agents.includes(a)
  const files = Object.entries(manifest.files).filter(([, e]) => chosen(e.agent)).map(([p, e]) => planFile(p, e, manifest.released[p]))
  const links = Object.entries(manifest.links).filter(([, e]) => chosen(e.agent) && e.origin !== 'install').map(([d, e]) => planLinkGone(d, e, platform))
  const releasedLinks = agents ? [] : Object.keys(manifest.released).filter(d => manifest.released[d].includes('link'))
  if (!files.length && !links.length && !releasedLinks.length) {
    out('nothing to uninstall\n')
    return { status: 'unchanged' }
  }

  printPlan(files, links, out)
  if (dryRun) return { status: 'dry-run' }
  const changing = files.some(f => ['delete', 'restore', 'surgical'].includes(f.action)) || links.some(l => l.action === 'remove')
  if (changing && !yes) {
    if (!isTTY || !prompt) return { status: 'refused', reason: 'no terminal to confirm; re-run with --yes' }
    if (String(prompt('Uninstall these? [y/N] ') ?? '').trim().toLowerCase()[0] !== 'y') return { status: 'refused', reason: 'not confirmed' }
  }

  const backupDir = join(stateHome, 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
  const next = structuredClone(manifest)
  for (const f of files) {
    if (f.action === 'unreadable') continue
    if (f.action === 'delete') { backUp(f.path, backupDir); rmSync(f.path) }
    else if (f.action === 'restore') writeAtomic(f.path, readFileSync(f.entry.backup), { backupDir })
    else if (f.action === 'surgical') writeAtomic(f.path, f.text, { backupDir })
    delete next.files[f.path]
    delete next.released[f.path]
  }
  for (const l of links) {
    if (l.action === 'remove') {
      if (isLinkMode(l.entry.mode) || l.entry.mode === 'copy') unlink(l.dest, l.entry.source, { platform, entry: l.entry })
      else if (statSync(l.dest).isFile()) { backUp(l.dest, backupDir); rmSync(l.dest) }
    }
    delete next.links[l.dest]
  }
  for (const d of releasedLinks) delete next.released[d]
  saveManifest(stateHome, next)
  return { status: changing ? 'written' : 'unchanged' }
}
