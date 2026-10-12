#!/usr/bin/env node
// Whether a review bot actually reviewed the current head, not whether some check by that name
// is green (02-run-history.md: the single most-repeated save pattern in the whole log). Looks at
// `reviews[]` by `commit_id`, never at check/status color, and never at the bot's own login or
// wording — both arrive as arguments so the predicate is the profile's, not this script's.
//
//   review-bot-green.mjs --repo <owner/repo> --pr <number> --sha <headSha> --bot <login>
//                         [--skip-pattern <regex>]...
//
// `--skip-pattern` (repeatable, case-insensitive) is how the profile declares "this text means
// the bot did not really review" (rate limited, skipped, draft not reviewed, ...). With none
// given, any review body from the bot on the exact head SHA counts as green.
//
// A rate-limit or draft-skip notice is not a review: CodeRabbit has nothing to formally review
// when it hits one, so it never opens a `reviews[]` entry for it — it posts an ordinary PR (issue)
// comment instead. A pattern checked only against review bodies therefore never sees it, however
// correctly the pattern itself is worded (measured: hours of dead
// polling). So every skip pattern is also checked against the bot's issue comments; a comment
// counts only when it is at least as new as the head commit itself — an older one is about a
// previous push, not this one, and must not end polling on a head it never spoke about.
import { parseArgs, emit, refuse, scriptError, ghJson } from './_util.mjs'

const args = parseArgs(process.argv.slice(2), { repeatable: ['skip-pattern'] })
if (!args.repo || !args.pr || !args.sha || !args.bot) {
  refuse('usage: --repo <owner/repo> --pr <number> --sha <sha> --bot <login> [--skip-pattern <regex>]...')
}

const patterns = (args['skip-pattern'] || []).map(p => new RegExp(p, 'i'))

// REST spells a GitHub App account `<slug>[bot]`; GraphQL and most profiles spell it `<slug>`.
const botKey = login => String(login || '').toLowerCase().replace(/\[bot\]$/, '')
const isBot = login => botKey(login) === botKey(args.bot)

const res = ghJson(['api', `repos/${args.repo}/pulls/${args.pr}/reviews`, '--paginate'])
if (!res.ok) scriptError('gh api pulls/reviews failed', { stderr: res.r.stderr || String(res.r.error || '') })

const reviews = Array.isArray(res.data) ? res.data : []
const onHead = reviews
  .filter(r => isBot(r.user?.login))
  .filter(r => r.commit_id === args.sha)
  .sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0))

const latest = onHead[0]
const reviewMatch = latest ? patterns.find(p => p.test(latest.body || '')) : undefined

let commentMatch, commentBody
if (patterns.length) {
  const commentsRes = ghJson(['api', `repos/${args.repo}/issues/${args.pr}/comments`, '--paginate'])
  if (!commentsRes.ok) scriptError('gh api issues/comments failed', { stderr: commentsRes.r.stderr || String(commentsRes.r.error || '') })
  const comments = Array.isArray(commentsRes.data) ? commentsRes.data : []

  const headRes = ghJson(['api', `repos/${args.repo}/commits/${args.sha}`])
  const headDate = headRes.ok ? (headRes.data?.commit?.committer?.date || headRes.data?.commit?.author?.date || null) : null
  const headTime = headDate ? new Date(headDate).getTime() : null

  const botComments = comments
    .filter(c => isBot(c.user?.login))
    // `updated_at` catches a notice CodeRabbit edits into an existing comment (a "summary edit")
    // rather than posting fresh; a comment with no readable head date is kept rather than dropped,
    // since a script-error already covers an unreachable commits API.
    .filter(c => headTime == null || new Date(c.updated_at || c.created_at || 0).getTime() >= headTime)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))

  for (const c of botComments) {
    const m = patterns.find(p => p.test(c.body || ''))
    if (m) { commentMatch = m; commentBody = c.body || ''; break }
  }
}

const matched = commentMatch || reviewMatch

emit(0, {
  status: 'ok',
  headSha: args.sha,
  reviewed: Boolean(latest),
  green: Boolean(latest) && !reviewMatch && !commentMatch,
  reviewId: latest?.id ?? null,
  reviewCommit: latest?.commit_id ?? null,
  matchedSkipPattern: matched ? matched.source : null,
  matchedSkipBody: matched ? (commentMatch ? commentBody : latest.body || '') : null,
})
