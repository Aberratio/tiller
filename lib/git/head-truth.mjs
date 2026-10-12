#!/usr/bin/env node
// The head a run merges, verifies and reviews is read from the worktree, never taken from a lane's
// reply: a lane can claim a commit it never made, or leave work uncommitted next to the one it did.
//
//   head-truth.mjs --repo <worktree> [--expect <sha>] [--base <sha>]
//
// A measurement, not a refusal: the caller turns a mismatch, a dirty tree or a head that does not
// contain the base into a gate condition. Untracked files count as dirty.
import { parseArgs, emit, refuse, scriptError, git, gitLines } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo) refuse('usage: --repo <worktree> [--expect <sha>] [--base <sha>]')

const rev = git(['-C', args.repo, 'rev-parse', 'HEAD'])
if (rev.error || rev.status !== 0) scriptError('git rev-parse HEAD failed', { stderr: rev.stderr })
const headSha = rev.stdout.trim()

const status = gitLines(['-C', args.repo, 'status', '--porcelain', '--untracked-files=all'])
if (!status.ok) scriptError('git status failed', { stderr: status.r.stderr })
const dirty = status.lines.map(l => l.slice(3))

const expect = args.expect ? String(args.expect).toLowerCase() : null
const matchesExpect = expect === null ? null : expect.length >= 7 && headSha.startsWith(expect)

let descendsFromBase = null
if (args.base) {
  const anc = git(['-C', args.repo, 'merge-base', '--is-ancestor', args.base, headSha])
  if (anc.status !== 0 && anc.status !== 1) scriptError(`base ${args.base} unreadable`, { stderr: anc.stderr })
  descendsFromBase = anc.status === 0
}

emit(0, { status: 'ok', headSha, clean: dirty.length === 0, dirty, expect, matchesExpect, base: args.base || null, descendsFromBase })
