# Frameworks for ticket quality

These shape the *content* of the description; the profile's `## ticket conventions` shapes the *fields*. Use both.

---

## INVEST — user-story quality (Bill Wake)

A user story should be:

- **I**ndependent — completable on its own; doesn't require another in-flight ticket.
- **N**egotiable — describes the outcome, not the implementation. The team can still choose how.
- **V**aluable — clear user or business value, expressed via the "so that" clause.
- **E**stimable — enough info that the team can size effort. If unestimable, ask: do we need a Question ticket first?
- **S**mall — fits in one sprint. If not, it's an Epic — defer to `atlassian:spec-to-backlog`.
- **T**estable — observable, verifiable acceptance criteria.

Tradeoffs are normal. If a story can't satisfy all six, it's usually the "Small" or "Independent" criterion that's missing — those often indicate the work should be split.

---

## User story format

> **As a** [persona], **I want** [capability], **so that** [outcome].

**Personas** come from the profile's `## ticket conventions`; use its names and synonyms exactly. The examples below use a widget product with two personas:
- **Operator** — uses the operator web app
- **End user** — uses the end-user app
- **Admin** — uses internal admin tooling
- **Engineer / Operator** — internal user of dev/ops tooling (use sparingly; technical tickets often skip the user-story format entirely)

Bad: *"As a user, I want X."* → Which user? The skill should push for the specific persona because they have different goals.

The **"so that"** clause is the most important part — see anti-pattern #4. It often reveals a better framing than what the user originally asked for.

---

## Given-When-Then (Gherkin) for acceptance criteria

```
Given <initial context>
When <action or event>
Then <expected outcome>
```

Optionally:
```
And <additional context or outcome>
```

**Good example:**
```
Given I'm an Operator with a saved template "Onboarding Pack v3"
When I select 5 end users from my list and choose "Apply template"
Then "Onboarding Pack v3" is assigned to all 5 end users
And each receives a notification within 1 minute
And the bulk operation can be undone within 5 minutes
```

**Bad example (test steps, not AC):**
```
Given a POST /api/v2/templates/bulk_apply request
When the response is 201
Then assert response.body.applied_count == 5
```

The first one survives a backend rewrite. The second one breaks the moment we change the endpoint shape.

---

## Measurable outcome criteria (for Technical tickets)

When there's no user persona ("reduce checkout latency", "remove a deprecated dependency"), Given-When-Then often feels forced. Use **measurable outcome criteria** instead:

```
Success criteria:
- [metric] [target] [under what conditions]
- [observable behavior] [in what scenario]
- [verification approach]
```

**Example:**
```
Success criteria:
- Checkout API p95 latency under 400ms for requests returning ≤50 items, measured over a 1-hour peak window.
- Zero unhandled 5xx responses during a 24h soak in staging at 2× production load.
- Verification: existing checkout integration suite passes; new latency benchmark added to perf CI.
```

---

## Definition of Ready (DoR) — what's required before sprint pull

Optional but useful. A ticket is "ready" when:

- [ ] Title scoped to one outcome
- [ ] Description in the right template
- [ ] User story (or Objective for technical) is complete with "so that" / measurable target
- [ ] Acceptance criteria written and reviewed
- [ ] Dependencies identified
- [ ] Component and project set
- [ ] Estimable (team can size it)
- [ ] No implementation specifics in the description

If a ticket fails DoR, route it back for refinement before pulling into a sprint.

---

## Definition of Done (DoD) — what's required to close

Not authored at ticket-creation time — DoD is team-level. Common items:

- All AC met and verified
- Tests added/updated and passing in CI
- Code reviewed and merged
- Docs updated if behavior changed
- No regressions in critical paths
- Ticket closed by the assignee, not the reviewer

---

## The "so that" interrogation

If a user can't articulate the "so that" clause for a story, that's a strong signal. Three failure modes:

1. **The work isn't actually valuable.** Suggest archiving or downgrading priority.
2. **The user knows why but can't articulate it.** Help them — ask "what would change for the [persona] when this ships?"
3. **The "so that" reveals a better solution.** "So that the Operator doesn't spend 10 minutes per end user" might suggest bulk-apply isn't the only fix — maybe template templates with smart defaults solve it differently. Surface that observation.

---

## Quick reference: which framework for which ticket type

| Ticket type | Story format | AC format |
|---|---|---|
| Feature/Story | As a [persona]... so that... | Given-When-Then |
| Bug | (skip — describe symptom) | Given-When-Then OR expected/actual |
| Technical | (skip — Objective + Why) | Measurable outcome criteria |
| Question | (skip — pose the question) | "We have an answer when..." |
| Epic | High-level theme | Outcomes that child tickets must achieve |
