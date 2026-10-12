---
name: flow-write-ticket
description: Use when the user wants to write, draft or create a single ticket, or update, clean up, rewrite or audit an existing one, even without naming the tracker. Triggers include "help me write a ticket", "draft a feature ticket for X", "clean up OPS-1234", "make ABC-9876 compliant with our standards", "file a follow-up for this", and a request to sweep the descriptions of a whole epic.
user-invocable: true
---

# Write a ticket

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read two sections of the profile it names:

- `## tracker` — Kind, Site, project key. It decides where the ticket goes.
- `## ticket conventions` — components, project routing, issue types, priority scheme, labels,
  personas, browse URL, internal vocabulary, and any product-knowledge or board-snapshot source.
  Its `Source:` line names the written canon it was copied from; **when the two disagree, the canon
  wins** and the drift is reported once at the end.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last: filing a
ticket with another project's components or priority scheme is exactly the drift this prevents.

`## ticket conventions` absent or `none` → the tracker's own required fields are the only
convention; skip every step below that reads it.

### Where the ticket goes

| `## tracker` Kind | Tracker tools | What this skill produces |
|---|---|---|
| `jira` | Atlassian MCP available | the ticket, created or edited in Jira |
| `jira` | Atlassian MCP unavailable | the full draft in chat, fields listed, for the user to paste — nothing is claimed as filed |
| `none` | — | a **spec file** (see below) |

**Kind none writes a spec file**, because a flow run in spec mode (`flow-run-ticket --spec <path>`)
reads its acceptance criteria from exactly that file, and a draft that lives only in chat is lost at
the end of the session. The path is the user's call: propose the repo's existing spec directory if
there is one (look for `docs/specs/`, `specs/`, or what the repo's `CLAUDE.md`/`AGENTS.md` names),
otherwise ask. The same workflow applies with these substitutions: the duplicate check greps that
directory; links are markdown links to files or URLs; "create" is writing the file after the preview
is confirmed; update mode edits the file after the section diff is confirmed. There is no project,
component, priority or assignee field to fill.

---

Keep the description **outcome-shaped**: intent, user stories, measurable acceptance criteria —
never implementation prescription. Descriptions filled with class names, file paths and framework
choices go stale as the code changes and force rewrites. Community frameworks (INVEST,
Given-When-Then) shape content quality; the profile's conventions decide the field set.

## Create mode — the 10 steps

Ask only what cannot be inferred from the conversation so far. Use the user's own words; never
invent stakeholders, acceptance criteria or business value.

### 1. Capture intent

Identify **the work** (the outcome), **the trigger** (incident, customer ask, planning, tech debt)
and **the audience** (who benefits). A git branch carrying a ticket key is a *hint* to the project,
never an assumption. Pasted Slack threads, emails or traces are context; their implementation
specifics stay out of the body. Still unclear after one careful read → ask ONE focused question.

### 2. Select the ticket type

| Type | Use when | Template |
|---|---|---|
| **Feature/Story** | new user-facing capability or behaviour change visible to one of the profile's personas | `references/templates/feature.md` |
| **Bug** | current behaviour does not match expected | `references/templates/bug.md` |
| **Technical/Maintenance** | refactor, perf, infra, observability, hardening, dependency upgrade — no user-visible change | `references/templates/technical.md` |
| **Question** | a decision or investigation is needed before work can be scoped | `references/templates/question.md` |
| **Epic** | a multi-ticket initiative spanning several sprints | `references/templates/epic.md` |

Genuinely ambiguous → offer 2–3 candidates, one line of rationale each.

**Epic deflection.** The user already has a written spec or PRD for the work → suggest a
spec-to-backlog skill (`atlassian:spec-to-backlog`, if installed). Decomposing a spec into an epic
and children is its job, not this one's.

### 3. Load the template

Read the type's template and keep the profile's `## ticket conventions` at hand.

### 3b. Product knowledge (only if the profile names a source)

If `## ticket conventions` names a **Product knowledge** source, read the page for the product this
ticket lands in. It carries what is settled and why — for example that a product is a regulated
medical device, which changes scope, who may merge and whether a criterion needs a verification
record. Let it change the ticket's **content** (scope, constraints, criteria, out of scope). It never
appears **in** the ticket: no paths, page names, skill names or private numbering. Current state
(status, versions, who is on it) is not a product-knowledge question. No page → do not guess; if the
source defines a usage log, record the miss in the format it gives.

### 4. Interactive fill

- **Use the user's words.** Do not paraphrase intent into corporate speak.
- **Ask only what is missing.**
- **Never invent acceptance criteria.** Propose drafts from what was said; the user confirms or
  rewrites. Vague criteria are worse than fewer criteria.
- **Every user story has a "so that"** — `references/frameworks.md`.
- **Technical tickets** lead with a measurable **Objective** and **Constraints / Non-goals**.
- **Every reference is a real link, never a bare mention**, wherever it is named:
  - a ticket key or browse URL → note the relationship and rationale now; step 9 makes it a
    structural issue link, not a prose bullet;
  - the parent epic → never restated in the body; it is the `parent` field;
  - an external doc (Notion, Confluence, Sentry, Drive, Slack…) named without a URL → resolve it
    (`notion-search`, `searchConfluenceUsingCql`) or ask; render `[Display text](https://...)`.

### 5. Anti-pattern scan (the critical step)

Re-read the draft against `references/anti-patterns.md`:

- **Implementation leakage** — class names, file paths, frameworks, libraries, patterns.
- **Solution-first phrasing** — "Refactor X to Y" with no measurable objective.
- **Vague verbs** — improve, optimise, enhance, support, handle gracefully — with no measurable criterion.
- **Missing "so that".**
- **Criteria as test steps** — "Call `/v1/charges`" → "When a valid payment is submitted, order status becomes Paid within 5s".
- **No non-goals** when adjacent surface area is touched.
- **Missing off-state AC** — the ticket gates behaviour behind a flag, allow-list, pilot group, plan tier or rollout stage, yet every AC describes the audience that *gets* the feature. Add the mirror criterion ("Given a <persona> outside the allow-list, when they open the screen, then it behaves exactly as it does today") and say where it will be verified. The off-state is the one nobody opens on purpose, and it is where flagged work leaks.
- **Internal vocabulary** — anything the profile's list names, plus skill names and local paths.

Show every finding as a diff — the raw phrasing and the outcome-shaped rewrite — with one sentence
of why. The user insists on the original → keep it, state the trade-off in one sentence, move on.

### 6. Resolve the required fields (Kind `jira`)

In parallel where possible. Pass the `## tracker` Site as `cloudId`; the MCP accepts a site host or
a cloud id. It fails → `getAccessibleAtlassianResources` once and cache the id.

- **Project — validate against the live tracker before offering it.** Call `getVisibleJiraProjects` once
  and keep the live key list. Each key the profile's routing suggests must be in it: routing tables
  are copied from a written guide and **drift**. A missing key → offer the closest live key by
  project name and say so in one line. **Never pass an unvalidated key to `createJiraIssue`** — it
  fails with "No project could be found". Skip live projects whose name marks them deprecated. The
  profile may record the drift it already knows; re-measure rather than trust it.
- **Issue type.** `getJiraProjectIssueTypesMetadata` for the chosen project. A type may simply not
  exist there: `createJiraIssue` rejects an unknown type with `allowedValues` in the error body —
  read that list, do not retry blind. With no Question type, file a decision ticket as **Task** whose
  first line says it is a decision, not build work — otherwise someone estimates it (precedent: ABC-231).
- **Component — check the siblings first.** Read what the ticket's siblings actually carry. Being
  the only child of an epic with a Component is a deviation, not tidiness, and it makes board
  filters disagree (every child of ABC-206 had `components: []`). Then follow the profile's
  components rule; "exactly one" means work spanning two surfaces is **two linked tickets**.
- **Priority.** The profile's scheme. Suggest a default from its signals; the user confirms.
- **Assignee.** Only if the user named someone — `lookupJiraAccountId`.
- **Epic.** Only if the user named a parent.

### 6b. Cost warning before searching the tracker

**`searchJiraIssuesUsingJql` ignores `fields` — it returns full descriptions regardless** (measured
2026-08-18: five children of one epic, `summary` and `status` requested, tens of thousands of
characters back, `remainingCount: 55`). Keep duplicate-check JQL narrow — search the keys you
suspect, not `parent = EPIC`. For titles of many keys prefer single `getJiraIssue` calls (`fields` is
honoured there), or the profile's **Board snapshot**, if it names one — mind the coverage it states.

### 7. Duplicate check

`searchJiraIssuesUsingJql` in the chosen project, keyword-matching the proposed title; show the top 3
with status. No match → preview. Likely duplicate → proceed / comment on the existing one / abort.
Related but distinct → continue and propose `relates to` in step 9.

**A ticket split out of an existing one: read that ticket's issue links before searching by title.**
A split-out ticket is usually already linked to its parent and phrased in the other half's
vocabulary, so the title search misses it while the link is in plain sight — two tickets were nearly
filed twice that way (ABC-228, ABC-229) because planning documents still said "not filed". **The
tracker is the oracle; a plan, a ledger and a memory are claims about it.** Believe the link, then
fix the documents.

### 8. Preview

Render the whole ticket — title, type, component, priority, project, full body — exactly as it will
appear, in tracker-compatible markdown. Wait for explicit confirmation ("create it", "ship it").
Edits → back to step 4 or 5.

### 9. Create

`createJiraIssue` with `cloudId`, `projectKey`, `issueTypeName`, `summary`, `description`,
`components` (per the profile's rule), `priority`, and `assignee` / `parent` when set. Then turn
every relationship into a real link:

- `createIssueLink` for each blocks / is blocked by / relates to / causes / is caused by /
  duplicates the user named, rationale in the link's `comment`, not the body. A component split
  gets its two halves linked `relates to` automatically.
- The parent is not duplicated as text anywhere in the body.
- Every external doc resolved in step 4 is a hyperlink in the body, not a name.

### 10. Return the URL and stop

The profile's **Browse URL** with the new key (no browse URL in the profile → the `self` link the
create call returned), a one-line summary, and stop.

---

## Decision aids

**Feature vs Technical.** "Will one of the profile's personas notice when this ships?" Yes →
Feature/Story. No, but engineers' operations change → Technical. Both → two linked tickets.

**"Just write it for me."** The user owns *why*; this skill edits *how*. Ask for one or two
sentences of intent and propose a draft to react to.

**Leakage in the user's own prompt.** Do not strip it silently — quote it, one sentence on the
staleness risk, the rewrite, and ask:

> You wrote: *"implement `Search::Catalogue::HybridSearcher` with cosine 0.7 threshold + BM25 fallback"*
>
> If that class is renamed during the build, the ticket goes stale. Outcome-shaped:
> *"Search results combine semantic relevance and keyword matching. When the semantic signal is weak,
> keyword matching keeps recall at or above today's baseline."* Use the rewrite, or keep yours?

---

## Update mode

The user points at an existing ticket — by key, URL or description — and asks to clean it up,
rewrite, audit, or bring it in line. Same principle, plus **respect for existing intent**: preserve
scope and intent, change only the framing.

1. **Resolve the key.** From a URL, extract it; from a description, search and confirm first.
2. **Fetch** with `getJiraIssue`: summary, description, issuetype, components, project, priority,
   status, assignee, parent, labels.
3. **Refuse if shipped** (Done, Closed, Resolved, Won't Do): rewriting it destroys the record of
   what was delivered. Offer a follow-up ticket instead; stop unless the user overrides explicitly.
   The one standing override is the profile's **Done-description rewrites** list — see *Sweeping an epic*.
4. **Identify the template type** from the tracker. A type that looks wrong is surfaced, never changed by
   default — type changes trigger workflow side effects.
5. **Load** the type's template, the profile's conventions and `references/anti-patterns.md`.
6. **Audit** into four buckets:
   - **Missing** — sections the template expects (no story, no out of scope, no measurable criteria).
   - **Leaking** — implementation specifics, vague verbs, criteria as test steps, bare references
     (keys or URLs not wired as links, named-but-unlinked docs, a "Parent epic: KEY" line).
   - **Fine as-is** — preserved verbatim.
   - **Unclear** — intent not recoverable; explicit questions for the user. **Do not guess.**
   
   **6b. Feed the audit back into the standard.** A Leaking or Missing finding that
   `references/anti-patterns.md` does not already name → say so in one line and offer to add it
   there (or to the profile, if it is project-specific). This is the only self-correction this skill
   has; do not build a draft-vs-final diff log. A ticket is edited days later, by several people,
   mostly to add information nobody had at creation — the diff cannot tell taste from news.
7. **Ask scope:** full rewrite / description only / targeted (one specific fix).
8. **Draft the rewrite** from the template:
   - keep the original author's language wherever it is fine;
   - **never invent acceptance criteria** — none present and none implied → ask;
   - **preserve every link, screenshot, attachment and ticket reference**;
   - stripped implementation detail is relocated, never dropped, into a final
     *"Implementation notes (non-binding, may go stale)"* with a one-line advisory preface;
   - Component, Project, Priority, Assignee and Epic change only when clearly wrong, flagged and asked;
   - **bare references become real links** — a key in prose becomes an issue link (rationale in its
     `comment`), a named doc is resolved to its URL, a "Parent epic" line is dropped.
9. **Show the diff section by section** — more important than the create preview:
   ```
   h2. <Section name>
   - BEFORE: <original, trimmed if long>
   + AFTER:  <rewrite>
   ```
   Unchanged sections read `(unchanged)`; metadata as `Component: BEFORE Mobile → AFTER App`.
10. **Confirm explicitly** ("apply", "ship it"). Tweaks → step 8.
11. **Apply** with `editJiraIssue`, sending ONLY the changed fields; then the issue links flagged in
    the audit. The body drops a bare mention once its structural link exists.
12. **Return the URL** and a one-line summary of what changed. Stop.

### Field notes

- **Title** — rewrite only if vague, solution-first or misleading; title edits hit everyone's feed.
- **Component split** — two surfaces → recommend splitting into two linked tickets, with confirmation.
- **Acceptance criteria** — missing: ask. Test steps: rewrite to Given-When-Then, keeping the
  behaviour meant. Outcome-shaped: leave alone.
- **Comments and sub-tasks** — out of scope (see *Comments* below for the one exception).
- **Status** — never transition; this skill edits content only.

### Update-mode anti-patterns

- **Silent drops** — never delete implementation detail without relocating or surfacing it.
- **Invented criteria** — a criterion not traceable to the original or to the user does not belong.
- **Drive-by metadata changes** — the user may have set that priority deliberately.
- **Re-framing intent** — change *how* it is framed, never *what* it asks for.
- **A half-done descope** — the ticket descoped *from* must stop demanding the moved criteria, or it
  can never close on its own terms (ABC-212 still asked for ABC-228's work for three days).

### Descoping a criterion out of a ticket

Both halves in one pass, or it is not done:

1. **The receiving ticket** carries the criteria **verbatim**, the measurement that showed the
   original could not satisfy them, and why the work cannot happen where it was.
2. **The descoped ticket** gets a dated `## Descoped YYYY-MM-DD` section naming what left and where,
   the moved criteria **struck through and annotated in place** (not deleted), and an Out of scope
   line pointing at the new ticket.
3. **Say whether the descope makes the ticket closable.** Usually it does not; implying it is the
   failure mode.
4. Both directions linked, and a comment on the descoped ticket recording who decided and that the
   struck criteria are reversible.

The shape to copy: ABC-224's size half → ABC-227.

---

## Sweeping a whole epic

The cost is no longer per-ticket judgement but deciding **which tickets to touch at all**.

1. **Count first, then read.** `parent = <EPIC> AND statusCategory != Done` with
   `searchResultMode: count`.
2. **Leave Done tickets alone, and say so** — unless the epic is on the profile's Done-description
   rewrites list (below).
3. **Do not edit a ticket that already reads well** — in the sweep that earned this, about two
   thirds needed nothing, and an edit that improves nothing still lands in every feed. The signature
   of the ones worth rewriting: a `## Parent` line restating the Epic Link; a `## Contract` preamble
   about how documents are referenced; a *Why now* / *Implementation notes* / *Approach* essay longer
   than the criteria; leaked internal vocabulary.
4. **Pagination is unreliable.** ~5 issues per response regardless of `maxResults`; `nextPageToken`
   has skipped from the second key to the last and reported `hasNextPage: false` with 95 unread.
   **Walk by key range** (`AND key > X-8150 AND key < X-8170`) and use `remainingCount` to spot a
   truncated range.
5. **Finish with a leakage sweep, not a memory of having been careful**: `parent = <EPIC> AND
   (description ~ "<term>" OR …)` over the profile's internal-vocabulary terms, then the same against
   `comment ~`. Text match is fuzzy — verify each hit; a zero-hit sweep is the only evidence the pass
   was complete.

### The target shape

```
**Goal:** <one sentence: the outcome, in the reader's terms>

<one short paragraph only if the reader cannot act without it>

## Acceptance criteria
* Given … when … then …

## Constraints          (only real ones)
## Out of scope         (only what someone would otherwise assume is in)
## Links                [human label](url) — what this document decides
```

Preserve verbatim: measured numbers with their dates, struck-through descoped criteria, every URL.
Implementation prescription goes into a final **Implementation note (non-binding)** of a few lines.

### Done tickets: the default and its override

Leaving Done descriptions alone is a default, not a prohibition; the ticket's owner may direct
otherwise, and the profile records such directions under **Done-description rewrites**. Rewriting a
Done description follows one rule: **change how it is written, never what it claims was delivered.**

- Every criterion keeps its checked state, wording and order.
- Every measured number, date, SHA, verdict and struck-through descope survives verbatim.
- Nothing gains or loses a criterion, or moves from "partly met" to "met".
- Description and reality disagree → a finding to report, **not** something to correct while tidying.

### Comments

Cleaning a comment thread means cleaning **only comments authored by the account the agent posts
as**. Anyone else's comment is left exactly as it is, even when it leaks internal vocabulary — it is
that person's words; raise it with them instead. Check the author on every comment; the id does not
tell you. A comment that records a signature keeps the signer's name when the profile says signature
records must name the signer.

---

## Reference files

Load on demand:

- `references/anti-patterns.md` — leakage checklist with rewrites.
- `references/frameworks.md` — INVEST, Given-When-Then, "so that", DoR/DoD.
- `references/templates/{feature,bug,technical,question,epic}.md` — one per type.

## What this skill does NOT do

- **Decompose a whole spec into many tickets** → a spec-to-backlog skill.
- **Extract action items from meeting notes** → a meeting-notes capture skill, if installed.
- **Triage an incoming bug report where duplicate search is the job** → a triage skill, if installed.
- **Estimate effort** — the team's planning ritual owns that.
- **Rewrite other people's comments**, or any comment outside *Comments* above.
- **Update a shipped ticket** outside the profile's Done-description rewrites.
- **Transition a ticket.**
