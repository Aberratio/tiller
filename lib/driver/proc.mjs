// Process plumbing shared by the driver and every runtime adapter: an argv spawn with no shell, and the
// filesystem allowances a lane needs under a repo's denyRead ["~/"] sandbox.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve as resolvePath, sep } from 'node:path'

// `onLine(line)` sees each stdout line as it arrives; a truthy return is a stop reason: the child's whole
// process group is killed (a CLI's tool subprocesses would otherwise outlive it) and `stopped` carries it.
export function exec(argv, { cwd, env, timeoutMs, input, onLine } = {}) {
  const started = Date.now()
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, settled = false, stopped = null, pending = ''
    const done = (exitCode, extraErr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr: stderr + extraErr, durationMs: Date.now() - started, ...(timedOut ? { timedOut } : {}), ...(stopped ? { stopped } : {}) })
    }
    const child = spawn(argv[0], argv.slice(1), { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'], ...(onLine ? { detached: true } : {}) })
    const killGroup = signal => { try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }
    const stop = reason => {
      if (stopped) return
      stopped = String(reason)
      killGroup('SIGTERM')
      setTimeout(() => killGroup('SIGKILL'), 1000).unref()
    }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; onLine ? killGroup('SIGKILL') : child.kill('SIGKILL') }, timeoutMs) : null
    child.stdout.setEncoding('utf8').on('data', d => {
      stdout += d
      if (!onLine || stopped) return
      pending += d
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line.trim()) continue
        let reason
        try { reason = onLine(line) } catch {}
        if (reason) { stop(reason); break }
      }
    })
    child.stderr.setEncoding('utf8').on('data', d => { stderr += d })
    child.on('error', e => done(e.code === 'ENOENT' ? 127 : 126, `${e.code || 'spawn error'}: ${e.message}`))
    child.on('close', (code, signal) => done(code ?? (timedOut ? 124 : 128), timedOut ? `killed after ${timeoutMs}ms` : signal ? `killed by ${signal}` : ''))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

// A repo may sandbox Bash with denyRead ["~/"]. Node's spawn then stops at the first PATH entry under
// HOME with EPERM instead of searching on (git, npm, sh all die), and git dies reading ~/.gitconfig.
// The lane re-allows reading only its toolchain dirs and drops HOME itself from PATH, so the deny holds.
export function laneSandbox({ path = process.env.PATH || '', home = homedir(), exists = existsSync, read = [] } = {}) {
  const entries = path.split(delimiter).filter(p => p && p !== home)
  const allow = new Set(read)
  for (const dir of entries.filter(p => p.startsWith(home + sep))) {
    allow.add(dir)
    const prefix = dirname(dir)
    const toolchain = dir.endsWith(`${sep}shims`) || (dir.endsWith(`${sep}bin`) && exists(join(prefix, 'lib')))
    if (toolchain && prefix !== home) allow.add(prefix)
  }
  allow.add(join(home, '.gitconfig'))
  return { PATH: entries.join(delimiter), settings: { sandbox: { filesystem: { allowRead: [...allow] } } } }
}

// A run worktree's .git is a file pointing into <repo>/.git/worktrees/<name>; git in a spawned test
// needs that repo's common dir, which a repo's denyRead ["~/"] hides. Read from disk, never by
// spawning git, because the lane's own sandbox is what is being configured.
export function gitCommonDir(cwd) {
  try {
    const dotGit = join(cwd, '.git')
    if (!statSync(dotGit).isFile()) return null
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return null
    const gitdir = resolvePath(cwd, m[1])
    const common = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    return resolvePath(gitdir, common)
  } catch { return null }
}
