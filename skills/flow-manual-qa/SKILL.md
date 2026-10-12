---
name: flow-manual-qa
description: Use when deciding which acceptance criteria still need a human and keeping the record of what nobody has verified - a ticket reaches one of the profile's QA statuses (In QA, Ready for testing), someone asks what is unverified before a release or a weekly, a confidence check leaves `needs-user` findings, or an acceptance criterion cannot be satisfied as written.
user-invocable: true
---

# Manual QA

## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. This skill takes from it, and from nowhere else:

| Needed for | Profile section |
|---|---|
| which statuses mean "waiting for verification", where the record is posted | `## tracker` (`Kind`, `QA statuses`) and `## identity` (the project key) |
| hosts, which deploy publishes which surface, the deployed SHA, test users, the QA browser and its evidence directory | `## environments` |
| what a merge reaches, and when | `## release` |
| the cross-ticket register of unverified criteria | `## verification register` |
| a bug that must not be refiled | `## known issues` |
| paths and records whose change is never a matter of taste | `## merge authority`, `## inviolables` |
| who answers what this skill may not decide | `## escalation` |
| the automated QA lanes a project has, if any | `## test toolchain` |

**No profile resolves → stop and say so.** Do not borrow another project's hosts or register.
A field this skill needs that is absent or `TODO` is named in the report as the reason the step
could not run; it is never filled in by guessing.

The gap this fills is **detection, execution and memory**. A ticket's criteria are a floor, not a
ceiling: testers find most real defects in scenarios nobody wrote down, and Step 2 generates those
on purpose. `flow-tdd` names the criteria no test level can reach; `flow-confidence-check` marks
findings `needs-user`. Nobody executes the naming, and nobody remembers it across tickets — which is
why once four tickets sat in In QA with zero verification records between them and a weekly
three working days away.

A project may also have an automated QA lane per surface, listed in `## test toolchain`. This skill
does not depend on one: where a lane exists, a criterion it can verify is handed to it by name;
where none exists, the criterion stays in Step 1's buckets like any other.

## Step 0 — What is actually deployed

Before reading a single criterion: establish the SHA the environment serves and that it contains the
ticket's merge, using the way `## environments` says the deployed SHA is read. A verification against
yesterday's bundle is worse than no verification, because it produces a record. Name the check used.

**A green CI job proves a build, not a rollout.** Name the artefact that proves the *deployed* state
and which one it is: a GitOps desired-state commit and image tag, the object's `last-modified` on the
origin, a version stamped in the bundle. A deploy job that only *dispatches* a workflow in another
repository proves nothing about a running pod — once a card recorded "redeployed 08:47 UTC"
from a merge timestamp, twice, before anyone checked. **If the running instance cannot be observed**,
say *desired state confirmed, rollout unobserved*. Never round that up.

**Ask which surface before which SHA, because a repository can publish more than one.** Read the
ticket's own Environment field first, then the surface map in `## environments`. One pass
over five tickets was handed one staging pin and three of the five did not live behind it: two
workflows synced two directories to two buckets, carrying builds two days apart. A SHA established
for one surface is not evidence about another; the deploy workflows' path filters and bucket names
are where the mapping lives.

**Deployed is not reachable, and this is the one that has cost the most.** A current bundle
containing the merge is exactly what makes the wrong answer feel safe:

- **ABC-213.** A comment recorded two criteria as *"Shipped and verifiable
  on staging"* on the strength of a merge. Measured two days later: the new symbol existed only in the
  new front end, **no application code called it**, and the only deployed user surface still ran the
  old behaviour. The claim stood on the ticket for six days.
- **ABC-215.** The blocker had merged and a user surface now existed — and the criterion
  was *still* unobservable: the route fetched a document that did not carry the field the new branch
  reads, so the branch could never fire there.
- **ABC-226.** A field in the types, the schema, the engine, an ADR and 31 tests — and no
  reader in any component. A grep for the symbol alone would have said "present".

So before recording any criterion as verifiable, name **the path from a user action to the code**:
which route, which request, which field in the response. A grep for the exported symbol proves it was
written; a call site in application code, and a request the surface actually makes, prove it can run.
With no such path the criterion is **not verifiable yet** (Step 7) — never *verified*, never
*shipped*. "Merged" is a fact about the repository and belongs in a sentence that says so.

**Containment in the served artefact beats containment in git.** `git merge-base --is-ancestor`
proves the merge is in the branch the bundle was built from, not that it reached anything a user
loads. When the fix has a signature — a string, a constant, an exported name — grep the *served*
bundle for it. On ABC-213 this took a criterion from "shipped" to *not verifiable yet*: the name was
absent from all 46 chunks of the deployed bundle.

**A code-split route file is usually a stub, and grepping it reads exactly like a missing feature.**
Under Vite the file named after a route holds a `__vite__mapDeps` array and almost nothing else. Once
a containment check over three route files returned **zero for all nine signature
strings**; following each stub to its real chunk found all nine. Fetch the stub, read the first path
out of the dependency map, grep *that*, and record which chunk the count came from. A zero is only
evidence once the file grepped is known to hold code.

**Re-establish Step 0 if any time has passed.** A pin written in the morning can be false by lunch.
Ask what merged since, and whether it touched a code path any manual step exercises. A pass that
spans a deploy is two passes.

**Verify the instrument, not just the environment — and never on the prompt's say-so.** Before the
first step, prove each capability the steps depend on — a signed-in session, an upload path, a
download directory, a regex, a formatter's config resolution — by observing it and naming the check,
the same way a SHA is proved. Force a known error and confirm the instrument reports it before
trusting its silence. **A statement in the prompt about tooling is a claim to test, not a fact to
inherit.** One pass opened with "the browser is fixed" and it was not; in another a
`grep` without `-E` read `?` literally and zero hits looked like a missing feature, and a formatter
run on a copy in `/tmp` was judged by defaults because config resolves by file path.

**With a browser in the session, read `references/browser-evidence.md` before the first step.** It
carries the checks that make a browser observation citable: the bundle the browser actually loads,
the running process's argv over its config file, and the failure modes that have been misdiagnosed.

**When a harness simulates the user** — injected sensor data, a scripted persona driving the real
bundle — read `references/simulated-sessions.md` before judging anything it produced: which
conditions it actually modelled, where a verdict may come from, and the triage before any `failed`.

**The fail-safe, when the environment cannot be confirmed:** an error on a step whose code path the
unconfirmed deploy changed is **`not verified` ("environment not ready"), never `failed`**. Write the
rule into the charter before the run, or the first 500 will be filed as a defect against the wrong
owner.

## Step 1 — Classify every criterion before testing any of it

**Most acceptance criteria do not need a human, and treating them as if they do is how a QA pass
becomes theatre.** Put each one in exactly one bucket, and write the bucket down:

- **Pinned by a test** — cite the file and what would go red. This is the majority: of ABC-223's six
  criteria, five were pinned by unit, contract and boundary checks, and one needed a browser.
- **Verifiable from an artefact** — a generated report, a committed contract, a schema diff. Read the
  artefact, not the generator.
- **Automatable — hand to `flow-tdd`** (or to the profile's QA lane for that surface, when one is
  listed) — the observation needs a browser, but nothing about it needs a *person*: the state can be
  reached deterministically and the same check is worth running on every merge. **A browser makes the
  wrong mistake cheap**: clicking through a scenario the repo could pin forever. Precedent: ABC-212's
  AC2 read as `manual only` until it turned out the repo already replayed recorded frames through a
  real browser with the backend stubbed — an e2e assertion, not a QA pass. Ask before every browser
  step: *is the state I need reachable from a fixture?* If yes, this bucket.
- **Manual only** — the observation genuinely requires **a person, a real room, a real clock or a
  real file**: a second person in frame, a moved camera, bad light, a twelve-hour session actually
  expiring. A browser alone neither disqualifies nor qualifies a criterion. Only these reach Step 2.
- **Not satisfiable as written** — the criterion asks for something no code in this repository can
  produce. A **ticket defect, not a test failure**: name the owner, point at (or file) the ticket that
  owns it, and say plainly it was not tested because it cannot be. Precedent: ABC-224's AC4 asked for
  "the API's own reason" on an oversized upload while the gateway refuses before the API runs — three
  review rounds and a bot approval missed it; the fix was a descope plus ABC-227, not a test.

## Step 2 — Attack the criterion before you accept it

A criterion says what should work, never where it breaks. **Run every `manual only` criterion through
the generators below and keep each scenario that would produce a different observation** — those
scenarios are part of the charter, and a failure found there is a finding, not a bonus. Each generator
is named after a real defect found by asking the question.

- **The transition, not the state.** ABC-306: charts render for a user with data and for one with
  none — and stay empty for the user who *acquires* data while the page is open. Ask: what changes
  underneath this screen while somebody is looking at it?
- **Two paths to the same truth.** Whenever one fact is reachable two ways, compare them. A search
  endpoint and a slider returned 11 of 20 matching items; wearables split a 23:00–13:00 sleep across two
  days while the tracker gave all 14 hours to one (ABC-304). *If it works in one case and not in the
  same scenario elsewhere, it is a bug* — the disagreement is the defect before anyone decides which
  side is right.
- **"Unchanged" needs a captured baseline, or it is not a criterion.** *"Behaviour is unchanged"*
  cannot fail against a memory. Name the artefact that fixes what "today" was — ideally the same
  observation on the release this one replaces, same subject, fixture and browser. ABC-230:
  two captures made hours earlier on the previous release gave every session a
  line-for-line expectation, so *absences* were assertions rather than impressions — a controlled A/B,
  the only shape in which "unchanged" is falsifiable. Without a baseline, the criterion belongs in
  *not satisfiable as written*.
- **The second pass.** The first run is the one the developer tested. ABC-305: a required field stays
  required until you fill it, change another field, clear it again, and walk straight through. Ask:
  what does doing this twice, or out of order, change?
- **Upgrade, not install.** A fresh install is a different program from an updated one; crashes
  cluster on the first launch after an update (ABC-308). If the check needs two builds, name the builds
  and who must produce them rather than substituting a clean install.
- **Empty, absent, too many.** Zero is a state and so is 49 — a user held 49 historical access codes
  against a UI built for two. Ask what none looks like, and what absurdly many looks like.
- **Arrive from outside the flow.** Deep link, back button, a link out of an email, questions skipped.
  One assessment produced three different result pages for the same answers depending on whether it
  was completed, skipped through, or opened by URL — and one dropped a link entirely.
- **Someone else in the frame.** The environment is an input. In camera-based motion testing, half a
  face in the foreground corrupted tracking *more* than a second person hugging the subject; ankles
  mattered more than knees. Ask what a real room contains that the spec assumes away.
- **Two clocks.** Account timezone and device timezone are different values and an app can read both.
  Anything with a date is two questions.

**Manufacture the state you cannot reach, and say that you did.** Editing a document directly,
mocking a response, deleting a record to force re-entry — legitimate, and each changes what the
observation proves. A step reached by hand-editing `created_at` verifies the read path and says
nothing about how a user gets there; write that limit into the step.

**Pin the setup so the run repeats.** Tape on the floor for camera distance, the same people, one
variable moved at a time. A finding nobody can reproduce is a rumour.

**Reproduce before reporting, because the repeat is where the second bug lives.** One clean
reproduction is the minimum; a second run separates one defect from two.

## Step 3 — Judge what you found

A finding without a verdict is homework for whoever reads it. Every unexpected observation leaves
this step in exactly one state, with the reason stated:

- **Bug** — it contradicts the spec, or contradicts itself across two paths.
- **Expected, and now written down** — intended, and the ticket says so.
- **Feature request** — works as built, and what it does is worse than what it should. Say which;
  conflating the two costs a triage round.
- **Real but not worth it** — with the *why*: how often it reaches an actual user, whether it is new,
  what it costs. "Low priority" is not an argument.
- **Ack only** — nothing will be done; the record exists so the next person does not rediscover it.

Three tests before ranking anything:

- **Is it new?** Check the behaviour on production before calling it a regression. A defect that
  predates the change is still filed, but does not block this release.
- **Does it reach a user, or the record?** Say so, including when the answer is no. Anything touching
  a path `## merge authority` does not leave to `agent`, or an item in `## inviolables`, is not a
  matter of taste.
- **Whose call is it, if not yours?** When the ranking depends on context you do not have, route it
  and name who decides — the ticket's owner, or the `## escalation` Human. Routing is a result.
  Silence is not.

**Record the observation that undermines your own hypothesis.** ABC-209 was titled "usage not counted
for non-admin" and its reporter appended that enabling as the main admin *also* failed. That line let
the investigation find the real cause (a trial subscription) and retire the title as a red herring.

## Step 4 — Write steps that can fail

A manual step names **the observation that separates pass from fail**, never "check that it works":
the entry URL, the exact input (file, size, type), and the specific thing on screen that decides it —
a string, a state, an absence. If failure cannot be stated, the criterion is not yet understood.

Steps a human cannot perform in one sitting say so, with what makes them slow: a twelve-hour session
expiry is verified by leaving a tab open and returning. Where a shortcut *is* equivalent, say why —
deleting the session cookie and refocusing exercises the same refetch-and-gate path, and that
equivalence is the claim being made.

**State the run order, because the Step 2 scenarios are not a tail.** Say which ride along on an
existing step, and put last the one that leaves data needing a revert — where the base step ends in a
revert control, there is somewhere to return to. Name the **minimum subset** if time runs short,
ranked by consequence: the scenario whose failure reaches a user outranks nine that reach a record.

## Step 5 — Collect, never assume

Every result carries **who observed it**, and an agent-run observation carries **the artefact that
proves it**. Three states:

- **verified** — what was observed, on which SHA, in which environment and surface, on what date,
  **and by whom**:
  - `observed-by-human` — handed over, answered, written down.
  - `observed-by-agent` — **only when a trace, screenshot or video was written to the evidence
    directory `## environments` names, and the record names the file.** No artefact, no
    `observed-by-agent`; the result is `not verified`. An agent that reports a click it cannot show
    has re-created the failure this skill exists to prevent, and it reads as more credible because it
    sounds specific. `references/browser-evidence.md` has the checks that make the artefact real.
  - A step run **partly** by each is two records, not one rounded up.
- **failed** — what was observed instead, with enough detail to become a bug ticket.
- **not verified** — and *why*, plus the date it becomes verifiable. Never write "verified" for a step
  nobody ran, and never let a partial result round up: "four of five criteria verified, the fifth
  returns tomorrow" is a complete answer; "verified" is a false one.

## Step 6 — The record on the ticket

One comment per verification pass, per criterion, on the ticket in the profile's tracker (`## tracker`
`Kind: none` → the verification section of the spec file). Readable in two weeks by someone who was
not there: criterion, Step 1 bucket, observation, environment **and surface**, SHA, date, who
observed it, and — when an agent did — the artefact file.

**Correcting a record means editing the false sentence, not only adding a true one below it.** A ticket
is read from the top and skimmed. ABC-213 carried *"Shipped and verifiable on staging"* from
the merge; the correction was a fresh comment three days later and the false heading stood three
days more. Edit the original: **strike the sentence, do not delete it**, add the accurate one, and put
a dated amendment note above saying what it said and which measurement falsified it. In a regulated
record the trace of how long the untruth stood is itself evidence. Nothing else in the comment changes.

## Step 7 — The register, which is the durable half

Maintain the cross-ticket register of criteria in the **not verified**, **not satisfiable** and **not
verifiable yet** states, at the path `## verification register` names. It answers one question on
demand — *what do we believe that nobody has checked?* — which is what a weekly, a release or a
regulatory conversation needs. A criterion deferred inside one ticket's comments is invisible by the
next sprint.

It is **one file, appended to, never per ticket and never per session** — a register that forks is not
a register. Read it before classifying: a criterion already parked there is updated, not rediscovered.
**No register declared** (`none`, or the section absent) → the rows stay on the ticket only, and the
report says so in one line; this skill never invents a register path.

**Not verifiable yet** is for a criterion whose behaviour is pinned but which has no deployed surface to
observe it on. ABC-215 earned the row: the core was imported by no application code, so the
observation waited on ABC-218 rather than on a human. Name the ticket that unblocks it, or the row is a
shrug.

**A blocker that has cleared is not a criterion that has passed — re-measure, and expect the reason to
have moved.** When ABC-218 merged, ABC-215's row did not clear: a surface existed, and it read a
different document. **Rewrite the blocker rather than deleting the row**, and say which happened —
"blocked on X" becoming "blocked on Y" is a different fact from "verified".

**Re-measure a blocker in the same breath as reporting it.** Once this fired twice in one
hour: a row said a ticket waited on a push that had happened four minutes earlier, and its replacement
was unblocked before anyone read it. A blocker is a claim about the present tense — re-read it
immediately before it goes into a comment, a register row or a message, and name the check
("`ls-remote` at 11:02") over the state.

**When a criterion leaves this ticket, the register is not where the next reader will look.** Once
ownership of two split-out halves was correct in the tracker and stale in a day plan, a
decisions ledger and a memory file — and two sessions came within one step of re-filing tickets
(ABC-228, ABC-229) that had existed for three days. When a row moves out: put the fact on **the
ticket** (its description's descope section, not only a comment), link both ways, then **correct every
document that asserted the old state**. Search the ticket key, and `## known issues`, before filing
anything.

## When the spec disagrees with itself, stop and say so

Two documents describing the same feature differently is a blocker, not a puzzle to solve by picking
the newer one; testing against a guess burns the QA time twice. Say which questions block verification
and which merely worry you, name who must answer, and ask for an acknowledgement. Precedent: a PRD, an
implementation-findings draft and a decision log each described a scoring rule differently, and one
open question decided 100% of expected results.

**Surface the cost of full coverage instead of silently sampling.** When a criterion implies a
combinatorial matrix, say how big it is and ask whether all of it is wanted. Quietly testing a slice and
reporting "verified" is the failure this skill prevents. Report defects in the spec's legibility too —
labels reused across tiers, options and outcomes made one matrix untestable as written.

## Boundaries

- **Never edits code and never writes a test.** An automatable gap goes to `flow-tdd` with the
  criterion quoted; an unautomatable one stays here.
- **Never claims a click it cannot show.** With no browser in the session, say so and produce the
  charter for a human. With one, the rule moves: the claim needs the artefact (Step 5). The browser's
  origin scope is written in `## environments`; widening it is the `## escalation` Human's decision,
  never a step.
- **Never writes to the environment beyond what the step declared.** A read-only observation and an
  application write — creating a record, uploading a file — are different acts; the second is in the
  step's text before the run.
- **A cheap diagnostic that writes a protected record is not a QA step.** If a one-click route to
  "which build is running" writes to something `## inviolables` or `## merge authority` protects, write
  it down as an *escalation path* with the decision owner named, never as a step, or the next reader
  runs it.
- **Files only in the profile's tracker** and project — never an issue in another system.
- **Never moves a ticket to a forward status on its own** — a status change follows the human's
  answer, behind its own confirmation.
- A criterion that fails is a bug ticket with the observation in it, not a comment saying it failed.
- **A Step 2 scenario that cannot be run is recorded, never dropped.** "Needs two builds nobody has
  produced" is a result.
- **A check that failed to reproduce is not a pass.** For a race or an intermittent crash, a clean run
  is *did not reproduce*, in those words.
- **One owner per section of the charter.** It is a shared file and peer sessions in a `flow-run-day`
  wave write to it; two sessions recorded one environment finding twice in one day. Say who owns
  Step 0, and route later findings into the addendum.

## Red flags — the step is not finished

- A manual step that passes on a fresh install and was never tried on an upgrade.
- A criterion about data with one path exercised, when two paths produce it.
- A finding with no verdict, no frequency, and no named owner.
- A scenario dropped because the build, the account or the staffed hours were missing.
- "Verified" after one run of a bug reported as intermittent.
- Two specs open, neither declared authoritative, and testing carried on anyway.
- An agent-run step recorded as `verified` with no trace, screenshot or video named.
- A browser step clicked through for a state a fixture could have produced.
- One SHA established, and criteria on a second surface judged against it.
- A tool failure blamed on the far end without reading the browser's own console log — see
  `references/browser-evidence.md`.
- A condition reported as tested when a simulation only scaled a number for it, or a harness failure
  recorded as `failed` — see `references/simulated-sessions.md`.

## Done when

Every criterion is in exactly one bucket with its evidence ✓ every `manual only` criterion has been
through the Step 2 generators and the surviving scenarios are in the charter ✓ every manual step names
its failure condition ✓ every finding carries a verdict with its reason and, where it is not ours, a
named owner ✓ every answer is in one of three states, none rounded up, each naming who observed it and
— if an agent did — the artefact ✓ the deployed surface is named per ticket ✓ the register (or, with
none declared, the ticket) reflects what is still unchecked ✓ every `automatable` criterion is handed to
`flow-tdd` or the profile's QA lane by name.
