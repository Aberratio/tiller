#!/usr/bin/env node
// Removes the run's own worktree once its branch landed on base, mechanical (01 §5: no judgment).
// Scoped to one branch: every other worktree belongs to another run and is never judged here, so a
// run in start/premise/plan with a zero-commit branch (an ancestor of base by construction) keeps
// it. Never touches the main worktree, never removes anything with local changes, never fetches.
//
//   cleanup.mjs --repo <path> --branch <name> [--worktree <path>] [--base <ref>]
//
// stdout: ok {removed: [path], kept: [{path, branch, reason}], absent?: true}. `absent` means the
// branch has no worktree any more, as after a crash between the removal and its checkpoint.
import { realpathSync } from 'node:fs'
import { parseArgs, emit, refuse, git, gitLines } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.branch) refuse('usage: --repo <path> --branch <name> [--worktree <path>] [--base <ref>]')
const base = args.base || 'main'
const real = p => { try { return realpathSync(p) } catch { return p } }

const top = git(['-C', args.repo, 'rev-parse', '--show-toplevel'])
const mainPath = top.status === 0 ? real(top.stdout.trim()) : null

const res = gitLines(['-C', args.repo, 'worktree', 'list', '--porcelain'])
if (!res.ok) { emit(1, { status: 'error', kind: 'script-error', reason: 'git worktree list failed', stderr: res.r.stderr }) }

const worktrees = []
let cur = null
for (const line of res.lines) {
  if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length) }; worktrees.push(cur) }
  else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace('refs/heads/', '')
  else if (line === 'detached') cur.branch = null
}

const wt = worktrees.find(w => w.branch === args.branch)
if (!wt) emit(0, { status: 'ok', base, removed: [], kept: [], absent: true })

const keep = reason => emit(0, { status: 'ok', base, removed: [], kept: [{ path: wt.path, branch: wt.branch, reason }] })

if (real(wt.path) === mainPath) keep('main worktree')
if (args.worktree && real(args.worktree) !== real(wt.path)) keep(`checked out at ${wt.path}, not at ${args.worktree}`)

const dirty = git(['-C', wt.path, 'status', '--porcelain'])
if (dirty.status !== 0 || dirty.stdout.trim()) keep('uncommitted changes')

const ancestor = git(['-C', args.repo, 'merge-base', '--is-ancestor', wt.branch, base])
if (ancestor.status !== 0) keep(`not merged into ${base}`)

const rm = git(['-C', args.repo, 'worktree', 'remove', wt.path])
if (rm.status !== 0) keep(`worktree remove failed: ${rm.stderr.trim()}`)
git(['-C', args.repo, 'branch', '-D', wt.branch])

emit(0, { status: 'ok', base, removed: [wt.path], kept: [] })
