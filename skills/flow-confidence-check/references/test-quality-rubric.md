# Test-quality rubric

Required coverage follows the changed SURFACE.
Missing the required level is at least `high` (blocker when the affected acceptance criterion is the ticket's core behavior).
Verdict gate: any AC verdict of `missing` OR `partial` also fails verdict condition V1 (report-template.md) - the branch cannot be `high-confidence` regardless of finding severities. The one exception is not yours to apply: the main thread may reclassify an AC as `out-of-reach` under SKILL.md Phase 3 (O1-O3). Grade what the branch delivers and leave that judgement alone. A `partial`-based gate must cite the specific violated checklist items.

## Required level by surface

| Changed surface | Required test type |
|---|---|
| Application entry point: controller, API endpoint, route | Type 1 - e2e request test |
| Background job / worker | Type 2 - background-job test |
| Client code / user-facing UI flow | Type 3 - browser feature test |
| Change confined to a single class's internals | Type 4 - unit test |

Apply the strictest applicable row per acceptance criterion.

## Path-coverage floor (Types 1 and 2)

Hard minimum, enforced strictly: at least 1 SUCCESS path AND at least 1 ERROR path per entry-point acceptance criterion.
Golden standard on top of the floor (gaps report as `medium`):
- One success example per meaningful input variant the AC states.
- One error example per distinct error class the change introduces or touches: validation (422), authentication (401 - new endpoints), authorization (403), not-found (404 - resource-scoped routes).
- Every new status code the change can return is asserted at least once.

## STRICT type checklists

A test counts as an adequate instance of its type ONLY if every item holds.
Each violated item is a finding.

### Type 1 - e2e request test (HTTP boundary)

- [ ] Enters through a routed, real request (URL + verb) exercising the full middleware stack - never direct controller/handler instantiation.
- [ ] Asserts the response status AND the response-payload fields that depend on the request params/inputs - a targeted subset, not the full payload.
- [ ] Asserts persisted side effects (DB state) and enqueued jobs/events when the behavior produces them.
- [ ] Meets the path-coverage floor (>= 1 success + >= 1 error example).
- [ ] Exercises authentication/authorization as a realistic role; a NEW endpoint has at least one negative auth case (401/403).
- [ ] Stubs only true external boundaries (third-party HTTP, cloud SDKs, payment gateways); internal collaborators stay real.
- [ ] Revert-sensitivity: the test would fail if the feature were reverted.

Controller-level tests target the same boundary: where repo docs deprecate them (e.g. a Rails repo whose conventions say request specs replace them), a NEW controller test is itself a finding; where docs bless them, they are held to this same checklist minus the routing item.
Convention undocumented: prefer the routed request test; a controller-only test is at most `partial`.

### Type 2 - background-job test

e2e like Type 1 - the entry point is the job instead of the HTTP request.

- [ ] Performs the REAL job (perform with real args); the full internal invocation tree below the job (services, models, DB writes) runs real, exactly like Type 1 below the controller.
- [ ] Mocks only true external boundaries (third-party HTTP, cloud SDKs); never stubs internal components the job calls.
- [ ] Asserts the observable outcome of the whole tree (DB change, message sent, follow-up enqueued) - not internal method calls.
- [ ] Also asserts enqueue: correct queue and arguments from the triggering code path.
- [ ] Meets the path-coverage floor: >= 1 success path AND >= 1 error path (downstream raises: what is retried, swallowed, or surfaced).
- [ ] Retry/idempotency semantics tested when the job declares them.
- [ ] Revert-sensitivity: the test would fail if the feature were reverted.

### Type 3 - browser feature test (Playwright / Capybara / Cypress / similar)

- [ ] Golden path only; edge cases live in Type 1 / Type 4 tests per the pyramid.
- [ ] Drives the real UI through user actions (visit, click, fill) - no JavaScript shortcuts injecting app state.
- [ ] Uses the repo's dedicated stable selector convention (e.g. `data-test-id`); no selectors coupled to CSS structure or display text that copy changes would break.
- [ ] Auto-waiting assertions only; zero `sleep`s.
- [ ] Deterministic data setup (seeded/factory data, frozen time where relevant); no dependence on other tests or execution order.
- [ ] Asserts the user-visible outcome (rendered text, navigation, UI state change), not network internals.

### Type 4 - unit test (single-class / pure-logic changes)

- [ ] Tests the class's own decisions through its public API - never private methods, instance variables, or exact collaborator call sequences.
- [ ] Covers every branch of the CHANGED logic: happy paths, edge inputs (nil / empty / boundary values), and raised or returned error cases.
- [ ] Fast and isolated: no HTTP, no browser. Real in-container services where repo convention says so; doubles only for true external boundaries.
- [ ] Deterministic: frozen time, no randomness, no execution-order dependence.
- [ ] Behavior-named examples describing WHAT the code does, not HOW; one behavior per example where practical.
- [ ] Does not re-test the framework (validation wiring, ORM behavior, library internals) - tests the logic the change added.
- [ ] Revert-sensitivity: the test would fail if the changed logic were reverted.

## External-input contracts (data this repo does not own)

Applies to any value the change reads from an API response, another service, a config file, or a feature-flag provider.
A local type or interface over parsed JSON is an assertion, not a guarantee: the compiler cannot falsify it, and neither can a fixture derived from it.

- [ ] Every value the change BRANCHES ON has a test for the field being **absent** (key missing / `undefined`), not only for its declared empty value (`null`, `""`, `0`, `[]`). A type declaring the field non-optional is not evidence that the sender always sends it.
- [ ] Fixtures for external payloads trace to a real captured response (recorded body, contract fixture, documented example) - not to the local type definition. A fixture written from the type can never contradict the type.
- [ ] Where the sender's payload differs by environment, deployment stage, or flag state, every shape the change can meet in production is represented by a test.
- [ ] The failure mode of the whole call is tested too, not just the payload: non-200, timeout, malformed body. Code that branches on a field also runs when the fetch never delivered one.

Severity: a missing field-absent case is `medium` for a display-only value, `high` when the value decides control flow, and `blocker` when it gates access to or visibility of a feature.

## Per-AC procedure

1. Classify the surface (grep routes, controllers/handlers, jobs, pages touched by the diff).
2. Locate candidate tests: diff first, then the repo's test directories from discovery.
3. Check the required type from the table; apply that type's STRICT checklist and the path-coverage floor where it applies.
4. General adequacy (all types): real entry point for the type, observable outcome, each stated variant covered, revert-sensitive.
5. Verdict: `covered` / `partial` / `missing`. Below required type = at most `partial`. Missing = `high` (blocker if core AC).

## Test-discipline audit (separate findings)

Audit tests added/changed in the diff against the repo's documented test conventions (from discovery).
Example for a Rails repo (its `spec/CLAUDE.md`-equivalent): inline setup over let/let!, build over create, spy + have_received, determinism (frozen time, no randomness, state isolation), real services over mocks, data-test-id in feature specs, behavior over implementation.
