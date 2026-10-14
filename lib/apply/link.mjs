// Skill directories and agent files linked into an agent's config dir. A path tiller did not link is
// never replaced; the caller reports it as skipped.
import * as nodeFs from 'node:fs'
import { createHash } from 'node:crypto'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const hashBytes = buf => createHash('sha256').update(buf).digest('hex')

export function readLink(dest, fs = nodeFs) {
  let st
  try {
    st = fs.lstatSync(dest)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  // Node reports a junction as a symbolic link, so junctions and symlinks share this branch.
  return st.isSymbolicLink() ? { type: 'symlink', target: fs.readlinkSync(dest) } : { type: 'other' }
}

// Windows link targets may come back with a \\?\ or \??\ prefix and in any case.
export function sameTarget(a, b, platform = process.platform) {
  if (platform !== 'win32') return a === b
  const norm = p => path.win32.resolve(p.replace(/^(\\\\\?\\|\\\?\?\\)/, '')).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// entry is the manifest's record for dest, when tiller linked it before.
export function planLink({ source }, current, entry, platform = process.platform) {
  if (current == null) return 'create'
  if (current.type === 'symlink' && sameTarget(current.target, source, platform)) return 'ok'
  if (current.type === 'symlink' && entry && sameTarget(current.target, entry.source, platform)) return 'refresh'
  return 'skip-foreign'
}

const fileHash = (file, fs) => {
  try {
    return hashBytes(fs.readFileSync(file))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// A copy is tiller's while its bytes still hash to what tiller copied.
export function planCopy({ source }, dest, entry, fs = nodeFs) {
  const current = readLink(dest, fs)
  if (current == null) return 'create'
  if (current.type !== 'other' || !fs.statSync(dest).isFile()) return 'skip-foreign'
  const destHash = fileHash(dest, fs)
  if (!entry) return destHash === fileHash(source, fs) ? 'ok' : 'skip-foreign'
  if (destHash !== entry.hash) return 'drift'
  return fileHash(source, fs) === entry.hash ? 'ok' : 'refresh'
}

export function link(dest, source, { platform = process.platform, fs = nodeFs } = {}) {
  fs.mkdirSync(dirname(dest), { recursive: true })
  if (platform !== 'win32') {
    fs.symlinkSync(source, dest)
    return { mode: 'symlink' }
  }
  if (fs.statSync(source).isDirectory()) {
    fs.symlinkSync(source, dest, 'junction')
    return { mode: 'junction' }
  }
  fs.copyFileSync(source, dest)
  return { mode: 'copy', hash: fileHash(dest, fs) }
}

// entry, when it records a copy, decides by hash; otherwise dest must be a link to source.
export function unlink(dest, source, { platform = process.platform, fs = nodeFs, entry } = {}) {
  const current = readLink(dest, fs)
  if (entry?.mode === 'copy') {
    if (current?.type !== 'other' || fileHash(dest, fs) !== entry.hash) return false
  } else if (current?.type !== 'symlink' || !sameTarget(current.target, source, platform)) {
    return false
  }
  fs.unlinkSync(dest)
  return true
}

// `node lib/apply/link.mjs <source> <dest>` for install.sh: prints linked, ok or skipped. It keeps no
// manifest entry, since install.sh records no ownership.
if (process.argv[1] && nodeFs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, dest] = process.argv.slice(2)
  if (!source || !dest || process.argv.length !== 4) {
    process.stderr.write('usage: node lib/apply/link.mjs <source> <dest>\n')
    process.exitCode = 2
  } else {
    const action = planLink({ source }, readLink(dest), null)
    if (action === 'create') link(dest, source)
    process.stdout.write(`${{ create: 'linked', ok: 'ok' }[action] ?? 'skipped'}\n`)
  }
}
