// What this machine offers the harness: platform, a POSIX shell, tool versions, installed agents.
// Every input is injectable so any platform can be probed from any host; only bin/tiller.mjs
// supplies the real process environment.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const TOOLS = { node: ['node'], git: ['git'], gh: ['gh'], jq: ['jq'], timeout: ['timeout', 'gtimeout'] }
const AGENTS = {
  claude: { bin: 'claude', dirEnv: 'CLAUDE_CONFIG_DIR', dir: '.claude' },
  copilot: { bin: 'copilot', dirEnv: 'COPILOT_HOME', dir: '.copilot' },
}

function defaultRun(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000 })
  return { status: r.status, stdout: `${r.stdout || ''}${r.stderr || ''}` }
}

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix)

export function whichAll(name, { platform, env, exists = existsSync }) {
  const p = pathFor(platform)
  const dirs = (env.PATH ?? env.Path ?? '').split(p.delimiter).filter(Boolean)
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  const found = []
  for (const dir of dirs) for (const ext of exts) {
    const candidate = p.join(dir, name + ext)
    if (exists(candidate)) found.push(candidate)
  }
  return found
}

export function which(name, opts) {
  return whichAll(name, opts)[0] ?? null
}

// System32 and WindowsApps hold WSL's bash.exe and cmd's timeout.exe, neither of which is POSIX.
const windowsImpostor = file => /\\windows\\(system32|syswow64)\\|\\windowsapps\\/i.test(file)

function firstUsable(names, opts) {
  for (const name of names) {
    const hit = whichAll(name, opts).find(f => opts.platform !== 'win32' || !windowsImpostor(f))
    if (hit) return hit
  }
  return null
}

function versionOf(bin, run) {
  try {
    const r = run(bin, ['--version'])
    if (r.status !== 0) return null
    return (String(r.stdout).match(/\d+\.\d+(\.\d+)?/) || [null])[0]
  } catch {
    return null
  }
}

function findShell(opts) {
  if (opts.platform === 'win32') {
    const bash = firstUsable(['bash'], opts)
    if (bash) return { path: bash, kind: 'git-bash' }
    for (const root of [opts.env.ProgramFiles, opts.env.ProgramW6432].filter(Boolean)) {
      const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe')
      if (opts.exists(candidate)) return { path: candidate, kind: 'git-bash' }
    }
    return null
  }
  const bash = firstUsable(['bash'], opts)
  if (bash) return { path: bash, kind: 'bash' }
  const sh = firstUsable(['sh'], opts)
  return sh ? { path: sh, kind: 'sh' } : null
}

export function probe({ platform, env, home, exists = existsSync, run = defaultRun }) {
  const opts = { platform, env, exists }
  const tools = {}
  for (const [tool, names] of Object.entries(TOOLS)) {
    const bin = firstUsable(names, opts)
    tools[tool] = bin ? { path: bin, version: versionOf(bin, run) } : null
  }
  const agents = {}
  for (const [name, a] of Object.entries(AGENTS)) {
    const configDir = env[a.dirEnv] || pathFor(platform).join(home, a.dir)
    agents[name] = { bin: firstUsable([a.bin], opts), configDir, configDirExists: exists(configDir) }
  }
  return { platform, shell: findShell(opts), tools, agents }
}
