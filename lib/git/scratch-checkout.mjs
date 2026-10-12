#!/usr/bin/env node
// One shared read-only worktree per SHA, memoized — replacing the pattern of re-running
// `git worktree add --detach $(mktemp -d) origin/main` on every review round for the same commit
// (03-transcript-mining.md §2/§6: 19 ad hoc scratch checkouts, several repeated per ticket).
//
//   scratch-checkout.mjs --repo <path> --sha <sha> --root <scratchRoot>
//
// Second call for the same SHA and root is a no-op: `created: false`, same path.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, emit, refuse, scriptError, git } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
for (const k of ['repo', 'sha', 'root']) if (!args[k]) refuse('usage: --repo <path> --sha <sha> --root <scratchRoot>')

const dir = join(args.root, args.sha)

if (existsSync(dir)) {
  const head = git(['-C', dir, 'rev-parse', 'HEAD'])
  if (head.status === 0 && head.stdout.trim() === args.sha) {
    emit(0, { status: 'ok', path: dir, sha: args.sha, created: false })
  }
  scriptError(`${dir} exists but is not a checkout of ${args.sha}`)
}

mkdirSync(args.root, { recursive: true })
const add = git(['-C', args.repo, 'worktree', 'add', '--detach', dir, args.sha])
if (add.status !== 0) scriptError('git worktree add failed', { stderr: add.stderr })

emit(0, { status: 'ok', path: dir, sha: args.sha, created: true })
