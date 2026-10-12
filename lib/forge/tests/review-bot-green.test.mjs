import { mkdtemp, writeStub, runScript, assertEq, assertTrue, report } from './helpers.mjs'

const bin = mkdtemp()
writeStub(bin, 'gh', `
path="$2"
case "$path" in
  *pulls/1/reviews*)
    cat <<'JSON'
[
  {"id": 900, "user": {"login": "reviewbot"}, "commit_id": "othersha", "body": "Review completed", "submitted_at": "2026-01-01T00:00:00Z"}
]
JSON
    ;;
  *pulls/2/reviews*)
    cat <<'JSON'
[
  {"id": 901, "user": {"login": "reviewbot"}, "commit_id": "headsha", "body": "Review rate limited until tomorrow", "submitted_at": "2026-01-02T00:00:00Z"}
]
JSON
    ;;
  *pulls/3/reviews*)
    cat <<'JSON'
[
  {"id": 902, "user": {"login": "reviewbot"}, "commit_id": "headsha", "body": "Review completed, 2 comments.", "submitted_at": "2026-01-03T00:00:00Z"}
]
JSON
    ;;
  *commits/headsha*)
    echo '{"commit": {"committer": {"date": "2026-02-10T12:00:00Z"}}}'
    ;;
  *issues/4/comments*)
    cat <<'JSON'
[
  {"id": 700, "user": {"login": "reviewbot"}, "body": "> [!WARNING]\\n> Review limit reached — retry after the window resets.", "created_at": "2026-02-10T13:00:00Z", "updated_at": "2026-02-10T13:00:00Z"}
]
JSON
    ;;
  *issues/5/comments*)
    cat <<'JSON'
[
  {"id": 701, "user": {"login": "reviewbot"}, "body": "Review limit reached — retry later.", "created_at": "2026-02-09T13:00:00Z", "updated_at": "2026-02-09T13:00:00Z"}
]
JSON
    ;;
  *issues/6/comments*)
    cat <<'JSON'
[
  {"id": 702, "user": {"login": "reviewbot"}, "body": "Draft PR not reviewed — mark it ready for review to receive one.", "created_at": "2026-02-10T14:00:00Z", "updated_at": "2026-02-10T14:00:00Z"}
]
JSON
    ;;
  *pulls/7/reviews*)
    cat <<'JSON'
[
  {"id": 903, "user": {"login": "reviewbot[bot]", "type": "Bot"}, "commit_id": "headsha", "body": "**Actionable comments posted: 0**", "submitted_at": "2026-02-10T15:00:00Z", "state": "COMMENTED"}
]
JSON
    ;;
  *issues/7/comments*)
    cat <<'JSON'
[
  {"id": 703, "user": {"login": "reviewbot[bot]", "type": "Bot"}, "body": "Review limit reached — retry later.", "created_at": "2026-02-10T16:00:00Z", "updated_at": "2026-02-10T16:00:00Z"}
]
JSON
    ;;
  *) echo '[]' ;;
esac
`)

// PR 1: a review exists but only on an older commit, never on headsha — mirrors "a check named
// after the bot is SUCCESS but there is no review of HEAD": this script never looks at checks at
// all, so an unrelated green check cannot make it lie.
const noReviewOnHead = runScript('review-bot-green.mjs', ['--repo', 'acme/widgets', '--pr', '1', '--sha', 'headsha', '--bot', 'reviewbot'], { binDir: bin })
assertEq(false, noReviewOnHead.json.reviewed, 'no review on the exact head sha')
assertEq(false, noReviewOnHead.json.green, 'not green without a review of head')

// PR 2: a review row on head, but its body is a rate-limit notice the profile flagged.
const rateLimited = runScript('review-bot-green.mjs', ['--repo', 'acme/widgets', '--pr', '2', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'rate limit'], { binDir: bin })
assertEq(true, rateLimited.json.reviewed, 'a review row exists on head')
assertEq(false, rateLimited.json.green, 'a rate-limit notice is never green')

// PR 3: a genuine review of head, no skip pattern matched.
const real = runScript('review-bot-green.mjs', ['--repo', 'acme/widgets', '--pr', '3', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'rate limit'], { binDir: bin })
assertEq(true, real.json.reviewed, 'a real review of head is reviewed')
assertEq(true, real.json.green, 'no skip pattern matched, so it is green')

// PR 4: no formal review at all, but the bot posted an ordinary PR comment (not a review) with a
// rate-limit banner, timestamped after the head commit. CodeRabbit never opens a formal review for
// a limit it did not review against, so this is the only place the notice ever appears.
const commentRateLimit = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '4', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'review limit reached'], { binDir: bin })
assertEq(false, commentRateLimit.json.green, 'a rate-limit comment on the head is never green')
assertEq('review limit reached', commentRateLimit.json.matchedSkipPattern, 'the comment-kind skip pattern is reported')
assertTrue(/Review limit reached/.test(commentRateLimit.json.matchedSkipBody || ''), 'evidence quotes the actual comment body')

// PR 5: the same rate-limit comment text exists, but it predates the head commit — it is about an
// earlier push, so it must not be read as a verdict on this head.
const staleComment = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '5', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'review limit reached'], { binDir: bin })
assertEq(null, staleComment.json.matchedSkipPattern, 'a comment older than the head is not evidence about it')

// PR 6: "Draft PR not reviewed" is CodeRabbit's real draft-skip wording (not "Draft detected"),
// and it also arrives as a plain comment.
const draftSkip = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '6', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'draft pr not reviewed'], { binDir: bin })
assertEq(false, draftSkip.json.green, 'a draft-skip comment on the head is never green')
assertEq('draft pr not reviewed', draftSkip.json.matchedSkipPattern, 'the draft-skip pattern matches the comment')

// PR 7: the REST API names a GitHub App account `<slug>[bot]`, while a profile names the bot by its
// slug (GraphQL's spelling). Either spelling of the profile's ref must match either spelling here.
const restReview = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '7', '--sha', 'headsha', '--bot', 'reviewbot'], { binDir: bin })
assertEq(true, restReview.json.reviewed, 'a REST `[bot]` login is the profile bot')
assertEq(true, restReview.json.green, 'a REST-shaped review of head with no skip pattern is green')
const restSuffixedRef = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '7', '--sha', 'headsha', '--bot', 'reviewbot[bot]'], { binDir: bin })
assertEq(true, restSuffixedRef.json.reviewed, 'a `[bot]`-suffixed profile ref matches too')
const restComment = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '7', '--sha', 'headsha', '--bot', 'reviewbot', '--skip-pattern', 'review limit reached'], { binDir: bin })
assertEq('review limit reached', restComment.json.matchedSkipPattern, 'a REST `[bot]` issue comment is read as the bot')
const otherBot = runScript('review-bot-green.mjs',
  ['--repo', 'acme/widgets', '--pr', '7', '--sha', 'headsha', '--bot', 'review'], { binDir: bin })
assertEq(false, otherBot.json.reviewed, 'a prefix of the login is not the bot')

report()
