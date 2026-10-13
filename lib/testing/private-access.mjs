import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = fileURLToPath(new URL('./fixtures/private-access/', import.meta.url))
const ACME = fileURLToPath(new URL('./fixtures/acme/profile.md', import.meta.url))

// A throwaway TILLER_HOME: profiles acme and beta, brains main and acme-notes, the fixture matrix.
// `matrix: null` leaves access.json out; a string is written verbatim (for invalid JSON). The home
// sits under a directory with a space, as real checkouts often do.
export function makeHome({ matrix, spaced = true } = {}) {
  const base = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'private-access-')))
  const home = join(base, spaced ? 'Other Repos' : 'repos', 'tiller')
  mkdirSync(join(home, 'profiles', 'acme'), { recursive: true })
  cpSync(ACME, join(home, 'profiles', 'acme', 'profile.md'))
  cpSync(join(FIX, 'profiles'), join(home, 'profiles'), { recursive: true })
  mkdirSync(join(home, 'profiles', '_template'), { recursive: true })
  writeFileSync(join(home, 'profiles', '_template', 'profile.md'), '# template\n')
  cpSync(join(FIX, 'brains'), join(home, 'brains'), { recursive: true })
  mkdirSync(join(home, 'brains', '_template'), { recursive: true })
  writeFileSync(join(home, 'brains', '_template', 'README.md'), '# template\n')
  if (matrix === undefined) cpSync(join(FIX, 'access.json'), join(home, 'brains', 'access.json'))
  else if (matrix !== null) writeFileSync(join(home, 'brains', 'access.json'), typeof matrix === 'string' ? matrix : JSON.stringify(matrix))
  const cwd = { acme: join(base, 'src', 'acme-web'), beta: join(base, 'src', 'beta-app'), none: join(base, 'elsewhere') }
  for (const d of Object.values(cwd)) mkdirSync(d, { recursive: true })
  return { base, home, cwd }
}

// The caller's env without profile overrides; an `undefined` value in `extra` removes that key.
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.TILLER_PROFILE
  delete env.TILLER_OVERLAY
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return env
}
