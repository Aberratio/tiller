# Hand-offs

The playbook for SKILL.md Step 5: the steps on a ticket's critical path that the agent — or the assignee — is not permitted to take. Each has the same shape in the plan: **owner, exact command, fallback**.

## Probe the permissions before promising the criterion

```bash
gh api repos/<org>/<repo> --jq .permissions          # admin / maintain / push / pull
gh api repos/<org>/<repo>/rulesets                    # merge rules, if any
gh api repos/<org>/<repo>/branches/<main>/protection  # admin-only to read
```

`maintain` is the trap: it looks like enough and cannot require a status check or edit branch protection. A criterion phrased as "a failing test blocks the merge" is two tasks — the code that makes the check exist, and the setting that makes it required — and only the first is yours.

The same probe applies outside GitHub: a tracker transition the account cannot perform, a staging environment nobody has credentials for, a registry the token cannot publish to.

## Verify a credential standalone before building on it

A credential handed to you by another team is a claim, exactly like a ticket's premise.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/user
```

A `401` means the token is dead — not that your `.npmrc`, your workflow, or your config is wrong. Diagnosing it in isolation first is what keeps a dead credential from being mis-attributed to an hour of your own wiring. For npm against GitHub Packages, a classic PAT with `read:packages` behaves where a fine-grained one frequently does not.

## Stop at the point of no return

Do the reversible prep and verification up to the line, then hand off with the exact command:

- verify the artifact that *would* be published — its contents, its version, the workflow that builds it,
- write down who runs the irreversible step and what they run,
- **never commit a half-state that cannot be verified green** — a manifest moved off `file:` with a lockfile that cannot be regenerated until the publish happens is a branch nobody can check out and build.

Publishes to a shared registry, pushed tags, data migrations, and anything immutable-once-done all sit behind this line.

## Make the thing consumable first

A dependency that is not installable yet is work, and it is the plan's first step rather than an assumption.

When it exists only on an unmerged branch: build the artifact in a **git worktree** so a shared checkout is never switched underneath a teammate, and park the result at a stable path — `~/.cache/<org>/<name>-<branch>-<sha>.tgz`. A session scratchpad path breaks `npm ci` the moment the scratchpad is purged, which is a failure that surfaces on someone else's machine.

Self-hosted assets, generated fixtures, and vendored model weights get the same treatment: the plan names where they come from and where they land.

## The fallback shape

A criterion nobody on the ticket can execute never becomes a silently-ticked criterion. It becomes:

1. the executable half, landed and verifiable,
2. a follow-up ticket for the rest, with the owner named,
3. one line in the PR saying which criterion is deferred and to whom.

Closing a ticket as complete over an unexecutable criterion is the outcome this whole step exists to prevent.
