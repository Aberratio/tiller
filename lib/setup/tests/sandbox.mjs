// The sandbox every wizard test runs in: real bash and the system's text tools, the real node, git
// and jq only when asked for, a stub that logs its argv for everything else, and every path the
// wizard or the commands it calls would write to moved under one temporary directory.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
export const TILLER = join(REPO, 'bin', 'tiller')
const TMP = process.env.TMPDIR || '/tmp'

// Tools a test decides about; never taken from the system directories.
const DECIDED = new Set(['node', 'npm', 'npx', 'git', 'jq', 'gh', 'claude', 'codex', 'brew', 'caffeinate', 'systemd-inhibit', 'winget', 'apt-get', 'dnf', 'apk', 'pacman', 'sudo'])
const REAL = {
  node: process.execPath,
  git: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find(existsSync),
  jq: ['/opt/homebrew/bin/jq', '/usr/local/bin/jq', '/usr/bin/jq'].find(existsSync),
}

let base
function systemBin() {
  if (base) return base
  base = mkdtempSync(join(TMP, 'wizard-sys-'))
  for (const dir of ['/bin', '/usr/bin', '/usr/sbin', '/sbin']) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (DECIDED.has(name) || existsSync(join(base, name))) continue
      try { if (statSync(join(dir, name)).isFile()) symlinkSync(join(dir, name), join(base, name)) } catch {}
    }
  }
  return base
}

// sandbox({ real: ['node','git','jq'], stubs: { claude: '<bash body>' } }): a stub with no body
// only logs. Every stub appends "<name> <argv>" to sb.log.
export function sandbox({ real = ['node', 'git', 'jq'], stubs = {} } = {}) {
  const root = mkdtempSync(join(TMP, 'wizard-'))
  const sb = {
    root,
    home: join(root, 'home'),
    bin: join(root, 'bin'),
    log: join(root, 'log'),
    profiles: join(root, 'home', 'profiles'),
    personal: join(root, 'home', 'personal'),
    skills: join(root, 'home', '.claude', 'skills'),
    agents: join(root, 'home', '.claude', 'agents'),
    settings: join(root, 'home', '.claude', 'settings.json'),
    codexSkills: join(root, 'home', '.agents', 'skills'),
    codex: join(root, 'home', '.codex', 'config.toml'),
    rc: join(root, 'home', '.bashrc'),
    nodeDirs: join(root, 'node-dirs'),
  }
  for (const d of [sb.home, sb.bin, sb.profiles, sb.personal, sb.nodeDirs]) mkdirSync(d, { recursive: true })
  writeFileSync(sb.log, '')
  for (const t of real) symlinkSync(REAL[t], join(sb.bin, t))
  for (const [name, body] of Object.entries(stubs)) stub(sb, name, body)
  return sb
}

export function stub(sb, name, body = '') {
  writeFileSync(join(sb.bin, name), `#!/bin/bash\necho "${name} $*" >> "${sb.log}"\n${body}\n`)
  chmodSync(join(sb.bin, name), 0o755)
}

export const calls = sb => readFileSync(sb.log, 'utf8').split('\n').filter(Boolean)

export function env(sb, extra = {}) {
  const e = {
    PATH: `${sb.bin}:${systemBin()}`,
    HOME: sb.home,
    SHELL: '/bin/bash',
    TMPDIR: TMP,
    LANG: 'C',
    TILLER_PROFILES_DIR: sb.profiles,
    TILLER_PROFILES_ROOT: sb.profiles,
    TILLER_PERSONAL_ROOT: sb.personal,
    CLAUDE_SKILLS_DIR: sb.skills,
    CLAUDE_AGENTS_DIR: sb.agents,
    CLAUDE_SETTINGS: sb.settings,
    CODEX_SKILLS_DIR: sb.codexSkills,
    CODEX_CONFIG: sb.codex,
    TILLER_SHELL_RC: sb.rc,
    TILLER_NODE_DIRS: sb.nodeDirs,
    TILLER_HELM_DIR: join(sb.root, 'helm'),
    ...extra,
  }
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k]
  return e
}

// run(sb, ['setup', '--yes'], { answers: {...}, input, env }): answers are written to a file and
// passed with --answers.
export function run(sb, args, { answers, input = '', env: extra = {}, cwd } = {}) {
  const argv = [...args]
  if (answers) {
    const f = join(sb.root, `answers-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(f, JSON.stringify(answers))
    argv.push('--answers', f)
  }
  return spawnSync('bash', [TILLER, ...argv], { encoding: 'utf8', input, cwd: cwd || sb.home, env: env(sb, extra) })
}

// Every file, link and mode under the sandbox's home, so a second run can be shown to change nothing.
export function snapshot(sb) {
  const out = {}
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name)
      const st = lstatSync(p)
      const key = p.slice(sb.root.length)
      if (st.isSymbolicLink()) out[key] = `-> ${readlinkSync(p)}`
      else if (st.isDirectory()) { out[key] = 'dir'; walk(p) }
      else out[key] = `${(st.mode & 0o777).toString(8)} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`
    }
  }
  walk(sb.home)
  return out
}

export const out = r => `${r.stdout}\n${r.stderr}`
