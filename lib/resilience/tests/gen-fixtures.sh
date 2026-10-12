#!/usr/bin/env bash
# One-shot generator for the classify-failure fixture corpus. Not part of the deliverable's
# runtime; run once to populate tests/fixtures/, then this file can be deleted or kept for re-seeding.
set -euo pipefail
cd "$(dirname "$0")/fixtures"

write() { printf '%s\n' "$2" > "$1"; }

write usage-limit/01.txt "Claude usage limit reached for this session. You can resume at 15:40Z."
write usage-limit/02.txt "Error: you've hit your weekly limit. Limit resets on Monday."
write usage-limit/03.txt "usage cap reached — no requests remain in this billing window"
write usage-limit/04.txt "429 session-limit artifact: session limit reached, resets 15:40Z"
write usage-limit/05.txt "Your usage limit will reset at 2026-09-16T09:00:00Z."
write usage-limit/06.txt "This session has hit its usage limit. Try again after the reset."
write usage-limit/07.txt "weekly usage limit exceeded for this workspace"
write usage-limit/08.txt "You can resume this session after 18:00Z when the usage window resets."
write usage-limit/09.txt "Anthropic API error: usage limit reached, resets in 90 minutes"
write usage-limit/10.txt "session limit reached; no further turns available until the weekly limit resets"

write rate-limit/01.txt "Error: rate limited. Please retry after 30 seconds."
write rate-limit/02.txt "HTTP 429 Too Many Requests"
write rate-limit/03.txt "CodeRabbit: review rate limited, no review posted for this commit"
write rate-limit/04.txt "got rate limited, try again"
write rate-limit/05.txt "429 Client Error: Too Many Requests for url: https://api.example.com/v1/reviews"
write rate-limit/06.txt "rate-limited by the upstream provider, exceeded the rate limit for this token"
write rate-limit/07.txt "tool_result_is_error: rate limit hit mid-turn, no backoff attempted"
write rate-limit/08.txt "please retry after some time — you are being rate limited"
write rate-limit/09.txt "GitHub API rate limit exceeded, X-RateLimit-Remaining: 0"
write rate-limit/10.txt "review bot: rate limit (hourly), discovered later to be weekly not hourly"

write harness-blocked/01.txt "Permission to use Bash has been denied by the user."
write harness-blocked/02.txt "This tool call was blocked by the classifier."
write harness-blocked/03.txt "Claude requested permissions to use Bash, permission denied"
write harness-blocked/04.txt "refused: compound command is not permitted, single command would pass"
write harness-blocked/05.txt "operation not permitted by sandbox policy"
write harness-blocked/06.txt "This command is blocked by the classifier: schema too large to classify (4102B vs 3563B threshold)"
write harness-blocked/07.txt "not allowed by tool policy: gh pr edit --add-label is outside the permitted scope"
write harness-blocked/08.txt "requires manual approval before it can run; no policy grants it automatically"
write harness-blocked/09.txt "dismiss operation blocked by policy on the first attempt"
write harness-blocked/10.txt "permission denied by the classifier for this tool call, is_error: true"

write ci-infra/01.txt "docker: Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
write ci-infra/02.txt "Error: connect ECONNREFUSED 127.0.0.1:5432"
write ci-infra/03.txt "getaddrinfo ENOTFOUND registry.npmjs.org"
write ci-infra/04.txt "RSpec/rubocop blocked: missing Docker Hub credentials, container creds issue"
write ci-infra/05.txt "GitHub Actions runner has gone offline before job completion"
write ci-infra/06.txt "could not connect to the runner: network is unreachable"
write ci-infra/07.txt "Error: timed out waiting for a runner to pick up the job"
write ci-infra/08.txt "no such host: internal-registry.local"
write ci-infra/09.txt "container failed to start: missing AWS credentials in the environment"
write ci-infra/10.txt "runner lost mid-job, no logs after step 4"

write unclassified/01.txt "TypeError: Cannot read properties of undefined (reading 'map')"
write unclassified/02.txt "AssertionError: expected 2604 to equal 2601"
write unclassified/03.txt "fatal: not a git repository (or any of the parent directories): .git"
write unclassified/04.txt "11 failing, 2593 passing (2604 total)"
write unclassified/05.txt "Error: Cannot find module 'left-pad'"

echo "fixtures written: $(find . -name '*.txt' | wc -l)"
