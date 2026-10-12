# Technical / Maintenance template

For refactors, perf work, infra, observability, security hardening, dependency upgrades, tech debt — work with no direct user-visible behavior change. The user-story format doesn't fit (no persona); use Objective-led structure instead.

---

## Template

```
h2. Objective
[One sentence: the measurable outcome. NOT "refactor X" or "switch to Y".]

h2. Why now
[Trigger — incident, capacity threshold, security disclosure, deprecation,
audit finding, planned theme. One short paragraph.]

h2. Success criteria
* [Quantitative target — metric + value + measurement window]
* [Observable behavior in scenario X]
* [Verification approach — benchmark, test, dashboard, soak test]

h2. Constraints
* [Things that cannot change as part of this work — API contracts,
   downtime budgets, data formats, etc.]
* [Resource constraints — time window, on-call freeze, etc.]

h2. Non-goals / out of scope
* [Adjacent work that is NOT included]
* [Things this ticket might look like it covers but doesn't]

h2. Approach being considered (optional, non-binding)
[If the team has a leading idea, capture it here — but mark clearly that
it's not a constraint. The ticket succeeds via outcome, not approach.]

h2. References
* [Related Sentry issues / dashboards / past tickets]
* [RFC / ADR / Notion design doc]
```

---

## Good example

```
h2. Objective
Reduce catalogue search p95 response time from 1.2s to under 400ms for
queries returning ≤50 results, measured over peak (8-11am UTC) traffic.

h2. Why now
Operator-facing search is the top hit in last quarter's "slow page"
complaints, and the slowest path on the web app critical-trace dashboard.
The /search-hybrid endpoint we're building this sprint will inherit
this latency baseline if we don't fix it first.

h2. Success criteria
* Catalogue search p95 < 400ms over a 1-hour peak window, sustained
  for one full week post-deploy.
* Catalogue search p99 < 1s in the same window.
* Zero increase in error rate (5xx + timeouts) vs. baseline.
* Verification: existing Looker dashboard 'search-latency' is
  the source of truth; new alert fires if p95 exceeds 500ms for 5 min.

h2. Constraints
* Cannot change the public /catalogue/search API contract — the web
  and mobile apps both consume it.
* No downtime — must roll out behind a feature flag with shadow comparison.
* Must work for accounts with up to 50k items in their catalogue
  (current largest enterprise tenant).

h2. Non-goals
* Adding hybrid vector search (separate Epic — OPS-2741).
* Reworking the search UI on the web app.
* Translation / i18n of search results.

h2. Approach being considered (non-binding)
Profiling shows ~60% of latency is in the Typesense result hydration
step. Likely we want to either batch the hydration or move it to a
read-replica. Engineer running this ticket should validate the bottleneck
themselves before committing to either.

h2. References
* Latency dashboard: [Looker link]
* Profiling snapshot: [Datadog APM trace link]
```

Note: OPS-2741 (hybrid search, which depends on this baseline holding) is wired up as a `relates to` issue link via `createIssueLink`, not written into References as text — see step 9 in SKILL.md.

---

## Bad example (anti-pattern: solution-first + leakage)

```
h2. Title
Refactor SearchService to use batch hydration

h2. Description
The current code in app/services/search_service.rb does N+1 lookups in
the hydrate_results method. We should extract a BatchHydrator class and
use ActiveRecord::Preloader to batch the queries. Also switch from
synchronous to async/await pattern for the Typesense client calls.

Files to change:
- app/services/search_service.rb
- app/services/search/batch_hydrator.rb (new)
- app/services/typesense/client_wrapper.rb

Acceptance criteria:
- BatchHydrator class exists and is unit tested
- SearchService delegates to BatchHydrator
- Code review approved
```

Why bad:
1. No measurable Objective — done is undefined.
2. Prescribes class names and file paths that will go stale if the team picks a different shape.
3. AC is "code exists" not "performance improved".
4. No mention of *why* this matters or *how much* improvement is needed.
5. Doesn't surface the constraint (API contract stability) that should bound the work.

---

## Quick checklist before previewing

- [ ] Objective is a measurable outcome, not a code change
- [ ] At least one quantitative success criterion (metric + target + condition)
- [ ] Why-now explains the trigger
- [ ] Constraints section captures what *can't* change
- [ ] Non-goals section names the obvious adjacencies you're not doing
- [ ] If you include an "Approach being considered", it's clearly marked non-binding
- [ ] No class names / file paths in success criteria or Objective
