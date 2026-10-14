// Skill directories and agent files linked into an agent's config dir. A path tiller did not link is
// never replaced; the caller reports it as skipped.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export function readLink(dest) {
  let st
  try {
    st = lstatSync(dest)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
  return st.isSymbolicLink() ? { type: 'symlink', target: readlinkSync(dest) } : { type: 'other' }
}

// entry is the manifest's record for dest, when tiller linked it before.
export function planLink({ source }, current, entry) {
  if (current == null) return 'create'
  if (current.type === 'symlink' && current.target === source) return 'ok'
  if (current.type === 'symlink' && entry && current.target === entry.source) return 'refresh'
  return 'skip-foreign'
}

const posixOnly = platform => {
  if (platform === 'win32') throw new Error('linking on Windows (junction or copy) arrives in step 5')
}

export function link(dest, source, { platform = process.platform } = {}) {
  posixOnly(platform)
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(source, dest)
}

export function unlink(dest, source, { platform = process.platform } = {}) {
  posixOnly(platform)
  const current = readLink(dest)
  if (current?.type !== 'symlink' || current.target !== source) return false
  unlinkSync(dest)
  return true
}
