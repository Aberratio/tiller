# Feature / Story template

For new user-facing capability or behavior change visible to one of the profile's personas. Lean on user-story format; describe outcomes, not implementation.

---

## Template

```
h2. User story
As a [persona from the profile], I want [capability], so that [outcome].

h2. Context
Why now: [trigger — customer ask, planning theme, regulatory deadline, etc.]
Who's affected: [persona + scale, e.g. "all operators on Pro plan"]
Today's experience: [one or two sentences on current state]

h2. Acceptance criteria
* Given [initial context], when [action], then [outcome]
* Given [...], when [...], then [...]
* Given [...], when [...], then [...]

h2. Out of scope
* [Adjacent thing #1 that's NOT included]
* [Adjacent thing #2]

h2. Dependencies
* [Blocking tickets / external systems / decisions needed]
* [Empty if standalone]

h2. References
* [Confluence spec URL if any]
* [Slack thread / customer email / Figma]
```

Optional sections (add only if they add value):
- **Non-functional considerations** — performance, accessibility, GDPR / data residency
- **Stakeholders** — product owner, design lead, eng lead
- **Open questions** — known unknowns that don't block the ticket but need answers before build

**Gated features.** When the capability ships behind a feature flag, allow-list, pilot group, plan tier or rollout stage, the ACs also cover the audience that does *not* get it, and name **where** that is checked, because the off-state can differ per environment:

```
* Given a <persona> outside the pilot allow-list, when they open <the affected screen>,
  then it looks and behaves exactly as it does today
  (checked in every environment the release reaches — the flag is off in different
   ways on staging and in production).
```

The off-state is the one nobody opens on purpose, and it is the one that leaks. If the environment where the flag stays off cannot be exercised by whoever tests the ticket, the AC still stands: it names a person and a moment at release time instead of a test run. An off-state criterion with nobody assigned to it is the same as not having written it.

---

## Good example

```
h2. User story
As an Operator, I want to apply one of my saved templates to multiple
end users in a single action, so that I don't spend 10 minutes per end user
on busy onboarding days.

h2. Context
Why now: Power users on the Pro plan have been asking via support for
"saved templates with bulk apply" since Q1. Three of the top-10
accounts cited this in last week's CS calls.
Who's affected: Operators with ≥10 active end users and at least
one saved template. Roughly 12% of paid accounts based on account data.
Today's experience: Operator opens each end user individually,
selects "Assign template", picks from a dropdown, confirms — repeat.

h2. Acceptance criteria
* Given I'm an Operator with a saved template "Onboarding Pack v3",
  when I select 5 end users from my list and choose "Apply template",
  then "Onboarding Pack v3" is assigned to all 5 end users.
* Given I bulk-apply a template, when the operation completes,
  then each affected end user receives a notification within 1 minute.
* Given I bulk-applied a template within the last 5 minutes,
  when I click "Undo last bulk action",
  then all assignments from that action are removed and end users
  are notified of the rollback.
* Given the template conflicts with an existing assignment for an end user,
  when bulk-apply runs,
  then that end user is skipped and shown in a "did not apply" summary
  with the conflict reason.

h2. Out of scope
* Bulk-applying templates to end user groups defined by tag (separate ticket)
* Scheduling a bulk apply for the future
* End-user-side UI changes for receiving bulk-applied templates

h2. Dependencies
* End user notification system must support batched delivery (already in place)

h2. References
* Customer request thread: [Slack #cs-feedback link]
* Account-size distribution: [Looker dashboard link]
```

Note: no class names. No file paths. No framework assignment. The engineer building this can choose service objects, jobs, transactions however they like, and the ticket still describes success.

---

## Bad example (anti-pattern: implementation leakage)

```
Add a wishlist feature by creating:
- WishlistController in app/controllers/
- Wishlist model with belongs_to :user
- Database migration: add wishlists and wishlist_items tables
- React component: WishlistCard.tsx in client/app/bundles/acme/components/
- API endpoints: GET /api/v2/wishlists, POST /api/v2/wishlists/:id/items
- Use Sidekiq for any background notifications

Acceptance criteria:
- Controller responds to POST requests with 201
- Data saves to wishlists table
- React component renders without errors
```

**Why this is bad**
1. The reader can't tell what *outcome* "done" means — just that some code exists.
2. If we move from controllers to GraphQL or REST endpoints to gRPC, the ticket goes stale.
3. The ACs are test steps, not user-visible behaviors.
4. There's no user persona — no idea *who* benefits or *why*.
5. No out-of-scope, so the ticket will scope-creep into "while we're at it, add bulk delete".

---

## Quick checklist before previewing

- [ ] User story has a specific persona (not "user") and a "so that" clause
- [ ] Context says why now and who's affected
- [ ] At least 3 ACs in Given-When-Then form
- [ ] Out-of-scope section exists (even if "none — fully standalone")
- [ ] Gated feature (flag / allow-list / tier / rollout) → at least one AC for the audience outside it, naming where it is verified
- [ ] Zero class names, file paths, framework names in the description
- [ ] References include at least one link if any external context exists
