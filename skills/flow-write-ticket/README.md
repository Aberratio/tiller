# flow-write-ticket

Write one ticket, or rewrite one, so that its description survives the refactor that implements it:
outcome-shaped, criteria-led, every reference a real link, no implementation prescription and no
internal vocabulary.

## What the profile supplies

| Profile section | Read for |
|---|---|
| `## tracker` | where the ticket goes: a tracker (kind, Site, key), or `none` → a spec file |
| `## ticket conventions` | components rule and table, project routing and known key drift, issue types, priority scheme and defaults, labels, personas, browse URL, internal-vocabulary list, Done-description rewrite directions, signature-record rule, product-knowledge source, board snapshot |

`## ticket conventions` is optional and read as prose, so it renders no facts key; `--check`
refuses a declared section that names no `Source:` canon or still reads TODO
(`docs/profile-schema.md`). Absent or `none` → the tracker's own required fields are the only
convention.

**Tracker `none` writes a spec file** at a path the user confirms (the repo's spec directory when it
has one), because `flow-run-ticket --spec` reads its criteria from that file and a chat-only draft
does not outlive the session. **No tracker MCP** (for kind `jira`, the Atlassian MCP) → a paste-ready draft,
never a claim that anything was filed.

## Design notes

- Components, priority scheme, project routing and its known key drift, issue types, personas,
  labels, the browse URL and the internal-vocabulary list all come from `## ticket conventions`. The
  skill itself keeps only "validate every project key against the tracker's live project list".
- The canon the profile copies from is its `Source:` line, and the canon wins over the copy.
- A product-knowledge source and a board snapshot are read only if the profile names them.
- Done-description rewrite directions are the profile's; comments are edited only when authored by
  the account the agent posts as.
- Templates and examples carry placeholders (`<persona>`, `<owner>`, `<reviewer>`) and neutral hosts
  (`example.sentry.io`); no person is named, except a signer where the profile says signature records
  name one.
- Tracker-specific helper skills are named "if installed".

## Rules earned in field use

- Validate every project key against the live tracker; routing tables drift
- An unknown issue type: read `allowedValues`; a decision ticket is a Task that says so
- Check siblings' Components before setting one
- `searchJiraIssuesUsingJql` ignores `fields`; keep JQL narrow
- A split-out ticket: read the parent's links before a title search
- Descope both halves in one pass; say whether it makes the ticket closable
- A named harness or test level is checked to exist
- Leaked internal vocabulary; impersonal writing; every reference a link; no live state
- Epic sweep: count first, key-range walk, finishing leakage query, target shape
- Done descriptions: change how it is written, never what it claims
- Edit only comments authored by the agent's account
- Audit findings feed the written standard, no diff log

## Evals

`evals/evals.json`. Evals that depend on a component, key or priority run against the synthetic
profile `lib/testing/fixtures/acme/profile.md`; 10–13 cover tracker `none`, no profile, no
`## ticket conventions`, and the profile's internal-vocabulary list.
