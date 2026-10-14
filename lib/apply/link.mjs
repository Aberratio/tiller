// Skill directories and agent files linked into an agent's config dir. A path tiller did not link is
// never replaced; the caller reports it as skipped.
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// `node lib/apply/link.mjs <source> <dest>` for install.sh: prints linked, ok or skipped. It keeps no
// manifest entry, since install.sh records no ownership.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
