#!/usr/bin/env node
// Ticket worktree lifecycle, replacing hand-run `git checkout -b` in the shared main checkout
// (03-transcript-mining.md §2: 19 ad hoc `git worktree add` one-liners). Mechanical only: it
// never decides which branch or base to use.
//
//   worktree.mjs new --repo <path> --branch <name> --base <ref> --dir <path>
//   worktree.mjs new --repo <path> --branch <name> --base <ref> --command <template>
//   worktree.mjs list --repo <path>
//
// --command is the profile's `## worktree` Create command: `<branch>`/`<base>` substituted and
// shell-quoted, run under `sh -c` from --repo, the resulting path read back from `git worktree list`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs, emit, refuse, scriptError, git, gitLines } from './_util.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const args = parseArgs(rest)

function branchExists(repo, branch) {
  const r = git(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  return r.status === 0
}

function worktrees(repo) {
  const res = gitLines(['-C', repo, 'worktree', 'list', '--porcelain'])
  if (!res.ok) scriptError('git worktree list failed', { stderr: res.r.stderr })
  const out = []
  let cur = null
  for (const line of res.lines) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length) }; out.push(cur) }
    else if (line.startsWith('HEAD ')) cur.headSha = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace('refs/heads/', '')
    else if (line === 'detached') cur.branch = null
  }
  return out
}

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`
const lastLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || ''

// The repo's own command decides where the worktree lives and what it scaffolds; git is asked
// afterwards where it went, so no output format has to be parsed.
function newFromCommand() {
  if (!args.command.includes('<branch>')) refuse('--command must name <branch>')
  const held = worktrees(args.repo).find(w => w.branch === args.branch)
  if (held) emit(0, { status: 'ok', path: held.path, branch: args.branch, headSha: held.headSha, created: false })
  const line = args.command.replaceAll('<branch>', shq(args.branch)).replaceAll('<base>', shq(args.base))
  const r = spawnSync('sh', ['-c', line], { cwd: args.repo, encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    scriptError(`worktree command exit ${r.status ?? 'none'}: ${lastLine(r.stderr) || lastLine(r.stdout) || String(r.error || '')}`,
      { command: line, stdout: String(r.stdout || '').slice(-2000), stderr: String(r.stderr || '').slice(-2000) })
  }
  const made = worktrees(args.repo).find(w => w.branch === args.branch)
  if (!made) scriptError(`worktree command exited 0 but git has no worktree on ${args.branch}`, { command: line, stdout: String(r.stdout || '').slice(-2000) })
  emit(0, { status: 'ok', path: made.path, branch: args.branch, headSha: made.headSha, created: true })
}

if (cmd === 'new' && args.command) {
  for (const k of ['repo', 'branch', 'base']) if (!args[k]) refuse('usage: new --repo <path> --branch <name> --base <ref> --command <template>')
  newFromCommand()
} else if (cmd === 'new') {
  for (const k of ['repo', 'branch', 'base', 'dir']) if (!args[k]) refuse('usage: new --repo <path> --branch <name> --base <ref> --dir <path>')

  if (existsSync(args.dir)) {
    const r = git(['-C', args.dir, 'rev-parse', 'HEAD'])
    if (r.status === 0) emit(0, { status: 'ok', path: args.dir, branch: args.branch, headSha: r.stdout.trim(), created: false })
    scriptError(`${args.dir} exists and is not a git worktree`)
  }

  const addArgs = branchExists(args.repo, args.branch)
    ? ['-C', args.repo, 'worktree', 'add', args.dir, args.branch]
    : ['-C', args.repo, 'worktree', 'add', args.dir, '-b', args.branch, args.base]
  const add = git(addArgs)
  if (add.status !== 0) scriptError('git worktree add failed', { stderr: add.stderr })

  const head = git(['-C', args.dir, 'rev-parse', 'HEAD'])
  emit(0, { status: 'ok', path: args.dir, branch: args.branch, headSha: head.stdout.trim(), created: true })
} else if (cmd === 'list') {
  if (!args.repo) refuse('usage: list --repo <path>')
  emit(0, { status: 'ok', worktrees: worktrees(args.repo) })
} else {
  refuse('usage: worktree.mjs new|list ...')
}
