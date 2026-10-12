# Epic template

For multi-ticket initiatives spanning several sprints. Epics frame the *theme* and *outcomes* — they don't enumerate child tickets in detail. Child tickets are separate; this is the umbrella.

---

## Deflection rule

**Before using this template**, check: does the user already have a Confluence spec or PRD for the work?

- **Yes** → Stop. Recommend `atlassian:spec-to-backlog` instead. That skill is purpose-built for spec → Epic + child decomposition, and duplicating it here would diverge over time.
- **No** → Use this template. The user is framing an Epic from scratch.

---

## Template

```
h2. Theme
[One sentence: the user-facing or system-level outcome this Epic delivers.]

h2. Why this Epic, why now
[Trigger — strategic theme, customer pattern, regulatory deadline, capacity
constraint. Two or three sentences. Link the relevant planning doc if any.]

h2. Outcomes
* [Measurable outcome #1 — what's true about the product when this is done]
* [Measurable outcome #2]
* [Measurable outcome #3]

h2. Personas affected
* [Persona] — [how their experience changes]
* [...]

h2. Scope summary
* In scope: [the high-level surface areas / capabilities this Epic covers]
* Out of scope: [adjacent themes that look related but aren't]

h2. Known unknowns
* [Open questions that need answers — usually spawn Question tickets]
* [...]

h2. Success metrics
* [How we'll know the Epic delivered value once shipped — adoption,
   performance, NPS, support volume, etc.]

h2. References
* [Planning doc / OKR / strategic theme]
* [Customer signals]
```

Do NOT put a list of child tickets in the Epic body. Use the tracker's parent-child link instead — that stays accurate as children are added, split, or merged.

---

## Good example

```
h2. Theme
Operators can find items that match user intent — not just
keyword — across the full library, including alternates for end user
constraints.

h2. Why this Epic, why now
Top 3 support theme last quarter was "I can't find the item I'm
thinking of". Power users have built personal cheat-sheets to work around
search. Adding hybrid search (semantic + keyword) is on the Q3
platform theme; this Epic is the user-visible delivery of that work.

h2. Outcomes
* Catalogue discovery on the operator web app uses semantic-plus-keyword search
  and explains why each result was returned.
* Operators can filter results by account constraint (e.g.
  "no weight-bearing", "seated only") in a single step.
* Median time from "open search" to "assign" drops from 45s to <20s
  for top-50 Operators by volume.

h2. Personas affected
* Operator — primary persona; new search UX.
* End user — indirect; better-matched items improve engagement.

h2. Scope summary
* In scope: operator search UI, search backend, catalogue filter UX,
  result-relevance feedback loop.
* Out of scope: Mobile search UI (separate Epic), end-user-side search
  (no current ask), catalogue editorial work.

h2. Known unknowns
* Embedding provider decision (see Question ticket ABC-XXXX).
* Whether to expose relevance scores to Operators or just ordering.
* Pricing model implications for high-volume search tenants.

h2. Success metrics
* Median open-search-to-assign time for top-50 Operators.
* "Did not find what I was looking for" feedback rate from the search UI.
* Support ticket volume tagged "search-finding".

h2. References
* Q3 platform theme: [Notion link]
* Top-3 support theme analysis: [Looker]
* Customer interviews: [Notion]
```

---

## Bad example (anti-patterns: scope sprawl + child-ticket dump)

```
h2. Title
Improve search

h2. Description
We want to make search better. This Epic includes:
- Refactor SearchService
- Add new endpoint /api/v3/search
- Add filter UI components
- Add A/B testing framework
- Maybe rewrite Typesense layer
- Better caching
- Mobile search (TBD)

Child tickets:
- ABC-1234 Refactor SearchService
- ABC-1235 Add /api/v3/search
- ABC-1236 Add filter UI
- ...
```

Why bad:
1. No measurable outcome — "better search" is undefined.
2. Mixes themes (search relevance, search infra, A/B testing, mobile) that should be separate Epics.
3. Lists child tickets in the body, which will rot.
4. Prescribes implementation (endpoint name, A/B framework, "rewrite Typesense").
5. No why-now, no metrics, no personas.

---

## Quick checklist before previewing

- [ ] Theme is one sentence, outcome-shaped
- [ ] At least one measurable outcome
- [ ] Personas affected named
- [ ] In-scope and out-of-scope both populated
- [ ] No child-ticket list in the body (use tracker parent links instead)
- [ ] No implementation assignment in outcomes or scope
- [ ] Success metrics defined for post-ship value tracking
