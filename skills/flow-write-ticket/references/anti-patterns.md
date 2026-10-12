# Anti-patterns: catch and rewrite

This is the active scan you run before previewing the ticket (step 5 in SKILL.md). For each pattern, the rewrite is more important than the detection — show the user the diff and explain the staleness risk in one sentence.

---

## 1. Implementation leakage

The single biggest source of ticket-rewrite churn. Anything that ties the ticket to a specific code structure will go stale when the code is refactored.

**Signals**
- Class / module / function names: `PaymentProcessor`, `UserSerializer`, `Search::Catalogue::HybridSearcher`
- File paths: `app/controllers/checkout_controller.rb`, `client/app/bundles/acme/`, `lib/`
- Framework / library assignment: "use Sidekiq", "switch to async/await", "with `pgvector`"
- Architectural assignment: "extract to a service object", "introduce a state machine", "use a decorator"
- Specific tunables: "set threshold to 0.7", "TTL = 5 minutes", "batch size 1000" (these belong in implementation discussion, not the ticket)
- Concrete endpoint paths: "add `POST /api/v2/foo`"

**Rewrite recipe**
- Identify the *outcome* the implementation would deliver.
- Restate the outcome from the user's or system's perspective.
- Move the implementation detail to a sub-bullet under "Implementation notes (optional, non-binding)" if the user insists on capturing it.

**Example**

| Original | Rewrite |
|---|---|
| "Implement `HybridSearcher` in `app/services/search/` that combines pgvector cosine similarity (threshold 0.7) with a Typesense BM25 fallback." | "Catalogue search returns results that combine semantic and keyword relevance. When semantic signal is weak, keyword matching ensures recall stays at or above today's baseline." |
| "Refactor `CheckoutController#create` to extract validation into `PaymentValidator`." | "Checkout request validation is testable in isolation and consistent across the API and web surfaces." |
| "Add a Sidekiq job to email end users after onboarding completion." | "End users receive a confirmation email within 5 minutes of completing an onboarding session." |

**One-line explanation to give the user**: "If we rename or replace [the named thing] during build, the ticket goes stale and someone has to rewrite it. Keeping it outcome-shaped means it survives any implementation we land on."

---

## 2. Solution-first phrasing

"Refactor X to Y" or "Switch to Z" before defining the problem. The reader can't tell what success looks like or whether the chosen solution is the right one.

**Signals**
- Titles starting with "Refactor", "Switch", "Migrate", "Replace" — *unless* paired with a measurable Objective.

**Rewrite**: Add an Objective + Success criteria. Demote the proposed solution to "Approach being considered" if you want to capture it.

**Example**

| Original | Rewrite |
|---|---|
| "Migrate from Redis to Memcached" | "Cache-layer p95 latency stays under 5ms during peak traffic. *Why now:* Redis instance approaching connection limit during evening surge. *Approach being considered:* swap to Memcached — not a constraint, just current thinking." |

---

## 3. Vague verbs without measurable AC

Improve, optimize, enhance, support, handle gracefully, streamline, modernize. These verbs hide the actual outcome.

**Signals**
- "Improve search performance" — by how much? measured how?
- "Optimize the dashboard" — which metric? what's the target?
- "Handle errors gracefully" — what does graceful mean here?

**Rewrite**: Add a quantitative target *or* a concrete observable behavior.

**Example**

| Original | Rewrite |
|---|---|
| "Improve search performance" | "Catalogue search p95 response time drops from 1.2s to under 400ms for queries returning ≤50 results." |
| "Handle errors gracefully" | "When the assignment API returns a 5xx, the user sees a retry prompt within 2 seconds; no spinner runs longer than 5s." |

---

## 4. Missing "so that" in user stories

"As an Operator, I want to apply a saved template to multiple end users." — missing the *why*. Without it, the ticket can't answer "would a different solution achieve the same goal?"

**Signals**
- User story has "As a ... I want ..." but no "so that ...".

**Rewrite**: Add the "so that" clause. If the user can't articulate one, the ticket may not be worth doing.

**Example**

| Original | Rewrite |
|---|---|
| "As an Operator, I want to bulk-assign templates." | "As an Operator, I want to apply one template to multiple end users in a single action **so that** I don't spend 10 minutes per end user on busy onboarding days." |

---

## 5. Acceptance criteria written as test steps

ACs describe *what success looks like*, not *how to verify it*. "Call endpoint /v1/foo and assert 200" is a test step, not an AC.

**Signals**
- ACs reference specific HTTP methods/paths/payloads.
- ACs say "click button X" or "run command Y" instead of describing the resulting state.
- ACs reference assertions, mocks, or test framework concepts.

**Rewrite**: Use Given-When-Then OR plain measurable outcomes.

**Example**

| Original | Rewrite |
|---|---|
| "POST /v2/checkout returns 201 with `{status: 'paid'}`" | "**Given** a valid payment is submitted, **when** the customer confirms, **then** the order status becomes Paid within 5 seconds and a confirmation email is queued." |

---

## 6. No non-goals / out-of-scope

Especially for tickets touching adjacent surface area, scope creep is the default outcome unless the boundary is explicit.

**Signals**
- The work could plausibly expand: "while we're in there, we should also…"
- The user describes a small change next to a known-ugly area.

**Rewrite**: Add an "Out of scope" or "Non-goals" section listing the obvious adjacencies that are *not* included.

**Example**

| Missing | Add |
|---|---|
| Ticket: "Add wishlist to product detail page" | **Out of scope:** Sharing wishlists with other users; bulk actions on wishlist items; wishlist analytics. |

---

## 7. Component = multiple

Applies when the profile's `## ticket conventions` says exactly one component per ticket. Then work spanning two repos or surfaces is actually two tickets.

**Signals**
- Description references both backend and frontend work as one unit.
- The user lists tasks like "1. add API endpoint 2. wire up the React form 3. update mobile screen".

**Rewrite**: Split into linked tickets. The backend ticket usually `blocks` the frontend one; both `relate to` a parent Epic or originating issue if one exists.

---

## 8. Lone bug ticket without expected/actual/repro

A bug ticket without **steps to reproduce**, **actual behavior**, and **expected behavior** is unactionable.

**Signals**
- "X doesn't work" — followed by silence.
- A screenshot with no caption.

**Rewrite**: Use the Bug template (`templates/bug.md`). At minimum, ask the user for:
- Steps to reproduce (numbered, environment-specific)
- What actually happens (be precise: "the page freezes for 30s and then shows no error" not "it's broken")
- What you expected to happen
- Environment (browser, OS, device, app version)

---

## 9. References that aren't real links

A `References` (or `Dependencies`) section is only useful if every entry is something the reader can click straight through to. Bare mentions turn into busywork for whoever opens the ticket next.

**Signals**
- A ticket key or browse URL written as plain text: "Related: OPS-2741" instead of a real issue link.
- A named doc with no URL: "Notion: Dev Framework Guide" — the reader has to go search for it themselves.
- A "Parent epic: ABC-201" bullet — redundant, since the Epic Link field already carries this relationship and the tracker already shows it in the issue view.

**Rewrite**
- Ticket keys/URLs → `createIssueLink` (pick the type — `relates to`, `blocks`, `duplicates`, etc. — from context), with any rationale moved into the link's `comment`. Drop the bare-text mention once the structural link exists.
- Named docs → resolve the actual URL (search Notion/Confluence, or ask the user) and render as `[Display text](https://...)`.
- Parent epic → remove from the description entirely; it's already captured by the `parent` field.

**One-line explanation to give the user**: "Right now this only reads as a mention — turning it into a real link means anyone reading the ticket can click straight through instead of hunting for it."

---

## 10. Acceptance criteria that name tooling the repo does not have

An AC is not merely unmet when the thing it asks for cannot exist yet — it is **unsatisfiable**, and
nobody finds out until someone tries to close the ticket. This is worse than a vague AC, because it
reads as rigorous.

**Signals**
- The AC names an artefact class the repo has none of: "stories for all states", "a story with axe
  coverage", "visual regression on this screen", "a Playwright e2e", "a contract test".
- The AC says "per the X ticket" / "per the baseline ticket" — and X is prose, not a link.
- Several sibling tickets carry the *same* sentence about the same missing thing.

**The check, and it is cheap**: for each AC that names a test level or a harness, confirm in the repo
that the level exists. One `ls`, one `grep` of the manifest, one `find` for the file pattern.

**What to do when it is missing** — do not silently soften the AC. Either:
1. file the harness as its own ticket and link it `blocks` (the shared tooling then has an owner, and
   the first screen ticket does not silently acquire it), or
2. if it is genuinely small and belongs here, say so in the ticket and widen the scope deliberately.

**Worked example (epic ABC-206).** Five screen tickets each carried *"stories for
all states with interaction, axe and visual coverage"*, and a sixth (the WCAG baseline) deferred its
automated half to *"the axe story gate (per the component-workshop ticket)"*. Measured in
the repo: no workshop config directory, no workshop dependency in the manifest, **zero story
files** — and no component-workshop ticket anywhere. Six tickets named a dependency that nobody
owned. It was filed as ABC-232 and linked `blocks` to all six.

**Why this belongs next to implementation leakage rather than under "vague verbs"**: leakage makes a
ticket go *stale*; this makes a ticket *uncloseable*. The staleness costs a rewrite; this costs a
whole ticket's worth of work discovering it, five times over.

---

## How to deliver the rewrite to the user

1. Quote the exact phrasing you're flagging.
2. State the staleness/scope risk in one short sentence.
3. Show the rewrite.
4. Ask: "Use the rewrite, or keep the original?"

Don't lecture. Don't moralize. The user has heard this advice before — you're applying it, not teaching it.

If the user pushes back ("no, I want the class name in there because it's load-bearing context"), accept it, note the trade-off in one sentence, and move on.

---

## Leaked internal vocabulary (from an epic sweep)

A ticket is read by the whole team and, in a regulated project, by auditors. **It must not
carry the vocabulary of how we work — only what the work is.** Strip all of these on sight — plus every term the profile's internal-vocabulary list names; none of
them ever earns its place in a description or a comment:

| Leak | Example found | Write instead |
|---|---|---|
| skill / tool names | "reported by `flow-confidence-check` as findings F1 and F4"; "handed to `flow-tdd`"; "Written against the shape the sibling tickets use rather than through the interactive ticket-crafting skill" | "raised by the pre-PR review"; "the automated test is owned by the implementation ticket" — name the *activity*, never the tool |
| private decision numbering | "Decision **D-1234-2**"; "needs a **D7** signature"; "D3, Tier 2 change control"; "finding **F-A** of the 2026-08-13 QA charter" | "decided 2026-08-19"; "needs a human signature before merge"; "under the existing change-control rules"; describe the finding |
| local filesystem paths | `~/notes/qa-unverified-register.md`; `~/evidence/2026-08-17-….png`; `~/meeting-notes/…`; `docs/superpowers/decisions/ABC-211.md` | "the register of unverified acceptance criteria"; "the branch's decision record in `<org>/<repo>`" — a path nobody else can open is not a reference |
| agent self-attribution | "Filed by the agent under the owner's standing mandate"; "Prepared by the agent … no code was written for it" | **delete the line.** Jira already records who filed it and when |
| operational trivia about our own tooling | how to source an npm token so a registry read stops 403-ing; which shell reads which rc file | delete, or keep one sentence of the *conclusion* |

**The test:** could a new team member, or an auditor, read this sentence and act on it without access
to the owner's laptop or knowledge of the agent's skill set? If not, it is leakage.

**Two things that are NOT leakage and must be preserved:** a real repo path rendered as a GitHub
link (`docs/adr/0011-….md` → a `blob/main` URL), and a decision's *substance* with its date and
owner. Strip the label, keep the decision.

## Every named reference is a link, or it is not a reference

Measured across 101 open tickets in one epic: the commonest reason a well-written ticket was still
hard to use was a `## Contract` section listing bare repo paths. A path is a search; a link is one
click. Convert every named document to `[human label](https://github.com/…/blob/main/<path>)`, and
let the label say what the document decides — not what it is called.

## Don't put live state in a description

A description is read months later; live state rots within hours. Commit counts, "N commits behind",
`mergeable: CLEAN`, branch distance and rebase status were all found stale in this epic — one ticket
had to have its whole implementation-notes section replaced because every number in it was false
within twelve days.

**Link the PR and say "read branch state there".** Keep in the description only what survives the
next push: what the ticket must achieve, what is decided, and what is left to *observe*.

## Write impersonally — no named individuals, especially not the owner

Asked for explicitly: a tracker comment says **what was decided and what was measured**, never who felt,
chose or observed it. Drop the person entirely rather than swapping the name for "the author".

| Instead of | Write |
|---|---|
| "Decided by <owner> on 2026-08-11" | "Decided 2026-08-11" |
| "Parked by the agent under <owner>'s standing mandate" | delete the line |
| "It stays parked unless <owner> says otherwise" | "It stays parked until it is rescheduled" |
| "<owner> performed a real 2-set session" / "confirmed by <owner> watching" | "a real 2-set session was performed" / "confirmed by direct observation" |
| "Merged by <owner full name> at 10:31 UTC" | "Merged at 10:31 UTC" |
| "<owner> is away until 2026-08-22" | "nobody is scheduled on this branch this week" |
| "awaiting <owner>'s call" | "awaiting a decision" |
| "confirmed with <owner> before posting" | "confirmed before posting" |

**Keep the epistemic distinction, lose the person.** "Observed directly" versus "read from the API"
versus "pinned by a test" is load-bearing — it says how much the claim is worth. `observed-by-human`
as a *category* is fine; naming the human is not.

Same for other colleagues: name someone only where the fact **is** the person — a review that has to
be requested from them, a decision only they can give, a DM someone owes. "Needs <reviewer>'s sign-off
before merge" stays, because it tells the reader who to go to.

### The one exception, and it is a real one

**A regulatory signature record needs the printed name of the signer** — when the profile's
`## ticket conventions` says so (21 CFR 11 §11.50(a) is the usual source). The regulation requires
it; that is the whole point of the record, and stripping the name would break the artefact rather
than tidy it. So on a comment whose subject *is* the signature, the signer is named. Everywhere else
— including the rest of that same comment — stays impersonal.

If you are unsure whether a name is load-bearing, ask before removing it. Silently deleting a name
from a compliance record is the expensive direction of this rule.
