#!/usr/bin/env node
// The delta since the commit a review round last looked at, not the whole diff re-read from
// scratch every round (03-transcript-mining.md §2/§6: the 44/42/36-count `git diff <old>..<new>`
// cluster, some tickets showing 80+ review round-trips over the same files).
//
//   diff-since-review.mjs --repo <path> --pin <sha> --out <path> [--head <sha>]
//
// The diff itself goes to `--out` (a diff routinely exceeds `caps.execStdoutBytes`); stdout stays
// one script-result line naming that file as `artifact`, plus the changed-file list.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs, emit, refuse, scriptError, gitLines } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
for (const k of ['repo', 'pin', 'out']) if (!args[k]) refuse('usage: --repo <path> --pin <sha> --out <path> [--head <sha>]')
const head = args.head || 'HEAD'

const diff = spawnSync('git', ['-C', args.repo, 'diff', `${args.pin}..${head}`])
if (diff.status !== 0) scriptError('git diff failed', { stderr: String(diff.stderr || '') })
// `--out` routinely lands under a STATE_ROOT `diffs/` directory nobody has created yet (the
// first review round, or the unconditional changed-files diff at gate time, is often the very
// first thing to write there). Uncaught, writeFileSync's ENOENT crashes before emit() runs: no
// stdout at all, which bin/harness.mjs `run()` cannot tell apart from a real crash and reports as
// "no script-result line from diff-since-review.mjs" — blocking the changed-files gate condition
// for a reason that has nothing to do with the change under review.
mkdirSync(dirname(args.out), { recursive: true })
writeFileSync(args.out, diff.stdout)

const names = gitLines(['-C', args.repo, 'diff', '--name-only', `${args.pin}..${head}`])
if (!names.ok) scriptError('git diff --name-only failed', { stderr: names.r.stderr })

emit(0, { status: 'ok', pin: args.pin, head, artifact: args.out, bytes: diff.stdout.length, changedFiles: names.lines })
