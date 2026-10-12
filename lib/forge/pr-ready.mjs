#!/usr/bin/env node
// Takes a PR out of draft. Nothing here decides whether it is ready; a gate does.
// `gh pr ready` exiting 0 is not proof the PR actually left draft state (it
// reported ok while the PR stayed draft, so review-bot polled a PR CodeRabbit was silently
// skipping). Re-read `isDraft` after every attempt; one retry; a still-draft PR or a failed
// re-read is never reported as ok.
//
//   pr-ready.mjs --repo <owner/repo> --pr <number>
import { parseArgs, emit, refuse, scriptError, gh, ghJson } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.pr) refuse('usage: --repo <owner/repo> --pr <number>')

function makeReady() {
  const r = gh(['pr', 'ready', args.pr, '--repo', args.repo])
  if (r.error || r.status !== 0) scriptError('gh pr ready failed', { stderr: r.stderr || String(r.error || '') })
}

function readDraft() {
  const res = ghJson(['pr', 'view', args.pr, '--repo', args.repo, '--json', 'isDraft,number'])
  if (!res.ok) scriptError('gh pr view failed after pr ready', { stderr: res.r.stderr || String(res.r.error || '') })
  return res.data.isDraft
}

makeReady()
if (readDraft() === false) emit(0, { status: 'ok', number: Number(args.pr), draft: false })

// Still draft: one retry, same checks.
makeReady()
if (readDraft() === false) emit(0, { status: 'ok', number: Number(args.pr), draft: false })

emit(3, { status: 'blocked', kind: 'toolchain', reason: 'PR still draft after gh pr ready and one retry', number: Number(args.pr), draft: true })
