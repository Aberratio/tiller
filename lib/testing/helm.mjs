import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanEnv, makeHome } from './private-access.mjs'

export const HELM_CLI = fileURLToPath(new URL('../helm/helm.mjs', import.meta.url))
export const RECORD = fileURLToPath(new URL('../helm/record.sh', import.meta.url))
export const SESSION = fileURLToPath(new URL('../hooks/helm-session.sh', import.meta.url))

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

export const env = (extra = {}) => cleanEnv({ ...GIT_ENV, TILLER_HELM_DETECT_GH: '0', TILLER_MACHINE_CAPS: undefined, ...extra })
export const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: env() })

export function cli(home, helm, machine, args, extra = {}) {
  return spawnSync('node', [HELM_CLI, ...args], { encoding: 'utf8', env: env({ TILLER_HOME: home, TILLER_HELM_DIR: helm, TILLER_MACHINE: machine, ...extra }) })
}

export function record(home, helm, machine, cwd, args, extra = {}) {
  return spawnSync('bash', [RECORD, ...args], { cwd, encoding: 'utf8', env: env({ TILLER_HOME: home, TILLER_HELM_DIR: helm, TILLER_MACHINE: machine, ...extra }) })
}

// A throwaway TILLER_HOME (profiles acme and beta), a bare helm remote, and two clones acting as two
// machines: `a` created with init --new, `b` cloned from it.
export function makeHelmPair() {
  const { base, home, cwd } = makeHome()
  const origin = join(base, 'helm-origin.git')
  spawnSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin], { env: env() })
  const a = join(base, 'machine-a', 'helm')
  const b = join(base, 'machine-b', 'helm')
  for (const d of [a, b]) mkdirSync(dirname(d), { recursive: true })
  const ra = cli(home, a, 'laptop', ['init', '--new', origin])
  if (ra.status !== 0) throw new Error(ra.stderr)
  const rb = cli(home, b, 'desktop', ['init', origin])
  if (rb.status !== 0) throw new Error(rb.stderr)
  return { base, home, cwd, origin, a, b }
}

export function originEvents(origin) {
  const r = spawnSync('git', ['--git-dir', origin, 'ls-tree', '--name-only', 'main', 'events/'], { encoding: 'utf8' })
  return r.stdout.split('\n').filter(f => f.endsWith('.md'))
}
