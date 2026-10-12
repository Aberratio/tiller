#!/usr/bin/env node
// Opens a PR (always as draft — the prose is the only judgment call, and that stays with the
// caller who wrote --body-file).
//
//   pr-open.mjs --repo <owner/repo> --base <branch> --head <branch> --title <t> --body-file <path>
import { parseArgs, emit, refuse, scriptError, gh } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
for (const k of ['repo', 'base', 'head', 'title', 'body-file']) {
  if (!args[k]) refuse('usage: --repo <owner/repo> --base <branch> --head <branch> --title <t> --body-file <path>')
}

// `gh pr create` prints the new PR's URL as its only stdout line; it has no --json form.
const r = gh([
  'pr', 'create', '--repo', args.repo, '--base', args.base, '--head', args.head,
  '--title', args.title, '--body-file', args['body-file'], '--draft',
])
if (r.error || r.status !== 0) scriptError('gh pr create failed', { stderr: r.stderr || String(r.error || '') })

const prUrl = r.stdout.trim().split('\n').pop()
const number = Number((prUrl.match(/\/(\d+)$/) || [])[1])
emit(0, { status: 'ok', prUrl, number: Number.isFinite(number) ? number : null, draft: true })
