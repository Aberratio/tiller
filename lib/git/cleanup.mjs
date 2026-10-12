#!/usr/bin/env node
// Removes worktrees whose branch already landed on base, mechanical (01 §5: no judgment). Never
// touches the main worktree, never removes anything with local changes, never fetches or pushes.
//
//   cleanup.mjs --repo <path> [--base <ref>]
import { parseArgs, emit, refuse, git, gitLines } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo) refuse('usage: --repo <path> [--base <ref>]')
const base = args.base || 'main'

const top = git(['-C', args.repo, 'rev-parse', '--show-toplevel'])
const mainPath = top.status === 0 ? top.stdout.trim() : null

const res = gitLines(['-C', args.repo, 'worktree', 'list', '--porcelain'])
if (!res.ok) { emit(1, { status: 'error', kind: 'script-error', reason: 'git worktree list failed', stderr: res.r.stderr }) }

const worktrees = []
let cur = null
for (const line of res.lines) {
  if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length) }; worktrees.push(cur) }
  else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace('refs/heads/', '')
  else if (line === 'detached') cur.branch = null
}

const removed = []
const kept = []

for (const wt of worktrees) {
  if (wt.path === mainPath) continue
  if (!wt.branch) { kept.push({ path: wt.path, reason: 'detached, no branch to judge merged' }); continue }

  const dirty = git(['-C', wt.path, 'status', '--porcelain'])
  if (dirty.status !== 0 || dirty.stdout.trim()) { kept.push({ path: wt.path, branch: wt.branch, reason: 'uncommitted changes' }); continue }

  const ancestor = git(['-C', args.repo, 'merge-base', '--is-ancestor', wt.branch, base])
  if (ancestor.status !== 0) { kept.push({ path: wt.path, branch: wt.branch, reason: `not merged into ${base}` }); continue }

  const rm = git(['-C', args.repo, 'worktree', 'remove', wt.path])
  if (rm.status !== 0) { kept.push({ path: wt.path, branch: wt.branch, reason: `worktree remove failed: ${rm.stderr.trim()}` }); continue }
  git(['-C', args.repo, 'branch', '-D', wt.branch])
  removed.push(wt.path)
}

emit(0, { status: 'ok', base, removed, kept })
