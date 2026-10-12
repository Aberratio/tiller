# Question template

For tickets where the team needs a decision or investigation before further work can be scoped. Lighter than Feature/Bug/Technical — the goal is to produce an *answer*, not to build something.

A Question ticket usually spawns 1-N follow-up tickets once it's resolved. Keep its description compact.

---

## Template

```
h2. The question
[One sentence. Specific enough that "yes" or "no" or "option A" is a valid resolution.]

h2. Why this matters
[The decision blocks or shapes what work? Who's waiting?]

h2. Options under consideration
* Option A — [description, with one-sentence rationale and main trade-off]
* Option B — [description, with one-sentence rationale and main trade-off]
* Option C — [description, with one-sentence rationale and main trade-off]
* (or "open — not enumerated yet")

h2. What we need to know to decide
* [Data point / experiment result / stakeholder input]
* [...]

h2. We have an answer when...
[Concrete definition of resolution. e.g. "Decision logged in ADR-018 and
signed off by [eng lead] + [product]." Or "Spike outcome documented in
Confluence with recommended path."]

h2. References
* [Slack thread, ADR draft, vendor comparison doc, customer-call notes]
```

---

## Good example

```
h2. The question
Should we use AWS Bedrock or self-host an embeddings model for the
hybrid search endpoint?

h2. Why this matters
The hybrid search Epic (OPS-2741) is blocked on this — the
implementation shape is materially different depending on the choice
(Bedrock = managed, pay-per-token, EU residency complexity;
self-hosted = capex/opex tradeoff, EU residency clean).

h2. Options under consideration
* Bedrock with Cohere embed-multilingual-v3 — fastest path; EU
  residency requires Frankfurt region; estimated $400/month at projected
  volume.
* Self-hosted bge-multilingual on existing GPU box — full control;
  ~2 weeks setup; ops burden going forward; ~$150/month amortized.
* OpenAI text-embedding-3-large via existing relationship — known
  quality; US-only is a problem for EU end users; ~$300/month.

h2. What we need to know to decide
* DPO sign-off on Bedrock Frankfurt region for personal data.
* Latency benchmark: each option's p95 on a representative 1000-query batch.
* Vendor lock-in tolerance — feedback from the platform team.

h2. We have an answer when...
ADR drafted, reviewed by eng lead + DPO + platform lead, decision recorded
in Confluence ADR index.

h2. References
* Bedrock pricing comparison: [Confluence page]
* Slack thread: [link]
```

Note: OPS-2741 is `blocked by` this ticket via a real `createIssueLink`, not written into References as text — see step 9 in SKILL.md.

---

## Bad example (anti-pattern: investigation without resolution criteria)

```
h2. Summary
Look into embeddings options

h2. Description
We need to figure out what embeddings model to use. Pros and cons of each.

h2. Acceptance criteria
* Research done
```

Why bad: no clear question, no options, no definition of "answered" — this ticket will sit open forever or be closed without a real decision.

---

## Quick checklist before previewing

- [ ] The question is one sentence, with a clear answer-shape (yes/no, A/B/C, recommended path)
- [ ] "Why this matters" names what's blocked or shaped by the answer
- [ ] At least 2 options listed (or explicit "open")
- [ ] "We have an answer when..." defines concrete resolution
- [ ] References at least one link if external context exists
