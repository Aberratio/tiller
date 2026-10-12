#!/usr/bin/env node
// Brings a pushed ticket branch up to date with its base without an agent in the loop: fetch,
// integrate in a scratch worktree, push, then move the ticket worktree. A conflict is reported,
// never resolved.
//
//   update-from-base.mjs --repo <worktree> --base <branch> --branch <branch> --method rebase|merge
//                        [--lease] [--remote origin]
//
// stdout: one script-result line.
//   ok       {updated: false, headSha}                          the branch already contains the base
//   ok       {updated: true, method, baseSha, previousSha, headSha, forced}
//   blocked  kind conflict {conflictingFiles, baseSha, headSha}  nothing moved
//   refused  kind policy {reason, ...}                            nothing moved
//
// Push policy: a fast-forward push only, unless `--lease` is given. With `--lease` a rewritten
// branch is pushed with --force-with-lease pinned to the remote SHA observed here, and only after
// checking that every commit on the remote branch is already in the local one — someone else's
// commit is never overwritten, with or without the flag.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, emit, refuse, scriptError, git, gitLines } from './_util.mjs'

// `--lease` takes no value, so it is taken out before parseArgs would pair it with the next token.
const argv = process.argv.slice(2)
const lease = argv.includes('--lease')
const args = parseArgs(argv.filter(a => a !== '--lease'))
for (const k of ['repo', 'base', 'branch', 'method'])
  if (!args[k]) refuse('usage: --repo <worktree> --base <branch> --branch <branch> --method rebase|merge [--lease] [--remote origin]')
if (!['rebase', 'merge'].includes(args.method)) refuse(`unknown --method ${args.method}; rebase or merge`)
const remote = args.remote || 'origin'
const repo = args.repo
const at = (argv, cwd = repo) => git(['-C', cwd, ...argv])
const rev = ref => { const r = at(['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null }
const isAncestor = (a, b, cwd = repo) => at(['merge-base', '--is-ancestor', a, b], cwd).status === 0

const dirty = at(['status', '--porcelain'])
if (dirty.status !== 0) scriptError(`git status failed in ${repo}`, { stderr: dirty.stderr })
if (dirty.stdout.trim()) refuse(`${repo} has uncommitted changes; an update from base never carries them`)
const current = at(['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim()
if (current !== args.branch) refuse(`${repo} is on ${current || 'a detached HEAD'}, not ${args.branch}`)

const fetch = at(['fetch', '-q', remote, `+refs/heads/${args.base}:refs/remotes/${remote}/${args.base}`])
if (fetch.status !== 0) scriptError(`fetch of ${args.base} failed`, { stderr: fetch.stderr.trim() })
// The branch may not exist on the remote yet; that is not an error.
at(['fetch', '-q', remote, `+refs/heads/${args.branch}:refs/remotes/${remote}/${args.branch}`])

const local = rev('HEAD')
const baseSha = rev(`${remote}/${args.base}`)
const remoteSha = rev(`${remote}/${args.branch}`)
if (!baseSha) scriptError(`no ${remote}/${args.base} after fetch`)

if (remoteSha && !isAncestor(remoteSha, local)) {
  const foreign = gitLines(['-C', repo, 'log', '--format=%h %s', `${local}..${remoteSha}`])
  refuse(`${remote}/${args.branch} has commits not in the local branch; they are never overwritten`,
    { remoteSha, headSha: local, foreignCommits: foreign.ok ? foreign.lines.slice(0, 10) : [] })
}

if (isAncestor(baseSha, local)) emit(0, { status: 'ok', updated: false, baseSha, headSha: local })

// Integrate in a scratch worktree so a conflict, a refusal or a crash leaves the ticket worktree
// exactly as it was.
const scratch = join(mkdtempSync(join(tmpdir(), 'update-from-base-')), 'wt')
const add = at(['worktree', 'add', '-q', '--detach', scratch, local])
if (add.status !== 0) scriptError('git worktree add failed', { stderr: add.stderr.trim() })
const dropScratch = () => {
  if (at(['worktree', 'remove', scratch]).status !== 0) at(['worktree', 'remove', '--force', scratch])
  rmSync(join(scratch, '..'), { recursive: true, force: true })
}

const integrate = args.method === 'rebase'
  ? at(['rebase', '-q', baseSha], scratch)
  : at(['merge', '-q', '--no-edit', '-m', `Merge ${args.base} into ${args.branch}`, baseSha], scratch)
if (integrate.status !== 0) {
  const files = gitLines(['-C', scratch, 'diff', '--name-only', '--diff-filter=U'])
  at([args.method, '--abort'], scratch)
  dropScratch()
  const conflictingFiles = files.ok ? files.lines : []
  if (!conflictingFiles.length) scriptError(`${args.method} onto ${args.base} failed without a conflict`, { stderr: `${integrate.stderr}${integrate.stdout}`.trim().slice(-500) })
  emit(3, { status: 'blocked', kind: 'conflict', reason: `${args.method} of ${args.branch} onto ${args.base} conflicts in ${conflictingFiles.length} file(s)`, conflictingFiles, baseSha, headSha: local })
}
const headSha = at(['rev-parse', 'HEAD'], scratch).stdout.trim()
dropScratch()

const forced = Boolean(remoteSha) && !isAncestor(remoteSha, headSha)
if (forced && !lease)
  refuse(`${args.method} rewrote pushed commits of ${args.branch}; pushing it needs a force-push, which this call was not allowed (--lease)`,
    { baseSha, headSha: local, rebasedSha: headSha })

const pushArgs = ['push', '-q', remote, `${headSha}:refs/heads/${args.branch}`]
if (forced) pushArgs.splice(2, 0, `--force-with-lease=refs/heads/${args.branch}:${remoteSha}`)
const push = at(pushArgs)
if (push.status !== 0) scriptError(`push of ${args.branch} failed`, { stderr: push.stderr.trim().split('\n').slice(-3).join(' | '), headSha: local })

// Only after the push landed: a fast-forward for a merge, `reset --keep` (refuses to drop local
// changes, of which there are none) for a rebase.
const move = isAncestor(local, headSha) ? at(['merge', '-q', '--ff-only', headSha]) : at(['reset', '-q', '--keep', headSha])
if (move.status !== 0) scriptError(`pushed ${headSha} but could not move ${repo} to it`, { stderr: move.stderr.trim(), headSha })

emit(0, { status: 'ok', updated: true, method: args.method, baseSha, previousSha: local, headSha, forced })
