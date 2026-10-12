#!/usr/bin/env node
// Merge click. Authority is a lookup the gate already made (lib/gates, W6) — this script only
// carries out a decision, never makes one, and refuses outright without the explicit token.
//
//   pr-merge.mjs --repo <owner/repo> --pr <number> --authority agent [--sha <expectedHeadSha>]
//                [--method squash|merge|rebase]
import { parseArgs, emit, refuse, scriptError, gh, ghJson } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.pr) refuse('usage: --repo <owner/repo> --pr <number> --authority agent [--sha <sha>]')
if (args.authority !== 'agent') refuse('merge refused: no explicit --authority agent token', { authorityGiven: args.authority ?? null })

if (args.sha) {
  const state = ghJson(['pr', 'view', args.pr, '--repo', args.repo, '--json', 'headRefOid'])
  if (!state.ok) scriptError('gh pr view failed', { stderr: state.r.stderr || String(state.r.error || '') })
  if (state.data.headRefOid !== args.sha) {
    emit(3, { status: 'blocked', kind: 'conflict', reason: 'PR head moved since the SHA this merge was authorised for', expected: args.sha, actual: state.data.headRefOid })
  }
}

const method = args.method || 'squash'
const r = gh(['pr', 'merge', args.pr, '--repo', args.repo, `--${method}`])
if (r.error || r.status !== 0) scriptError('gh pr merge failed', { stderr: r.stderr || String(r.error || '') })

emit(0, { status: 'ok', merged: true, number: Number(args.pr), method })
