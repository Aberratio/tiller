#!/usr/bin/env node
// A fix round is authorised for an explicit file list; whether it stayed inside that list is set
// arithmetic, not a re-read of the whole worktree by an agent (plan §2: "scope check is set
// arithmetic", the largest share of the 143-turn fix-round lane).
//
//   scope-fence.mjs --repo <path> --pin <sha> [--base-ref <ref>] [--head <sha>] --authorised <path-or-prefix/>...
//
// With --base-ref the diff starts at the merge-base of that ref and the head, so base commits the
// branch took in after the pin are not counted as its own changes.
//
// A measurement, not a refusal: out-of-scope changes come back as `extra` for the caller (a gate
// condition or a review finding) to act on.
import { parseArgs, emit, refuse, scriptError, git, gitLines } from './_util.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.repo || !args.pin) refuse('usage: --repo <path> --pin <sha> [--base-ref <ref>] [--head <sha>] --authorised <path-or-prefix/>...')
const head = args.head || 'HEAD'
// Runners pass the plan's list as one --authorised followed by every path; parseArgs keeps only the first.
const argv = process.argv.slice(2)
const authorised = argv.flatMap((a, i) => {
  if (a !== '--authorised') return []
  const end = argv.findIndex((b, j) => j > i && b.startsWith('--'))
  return argv.slice(i + 1, end < 0 ? argv.length : end)
})

let pin = args.pin
if (args['base-ref']) {
  const mb = git(['-C', args.repo, 'merge-base', args['base-ref'], head])
  if (mb.status !== 0) scriptError(`no merge-base of ${args['base-ref']} and ${head}`, { stderr: mb.stderr })
  pin = mb.stdout.trim()
}
const names = gitLines(['-C', args.repo, 'diff', '--name-only', `${pin}..${head}`])
if (!names.ok) scriptError('git diff --name-only failed', { stderr: names.r.stderr })

const inList = f => authorised.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a))
const extra = names.lines.filter(f => !inList(f))

emit(0, { status: 'ok', pin, head, changedFiles: names.lines, authorised, extra, inScope: extra.length === 0 })
