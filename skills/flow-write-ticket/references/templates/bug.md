# Bug template

For tickets where existing behavior is broken — current ≠ expected. Bugs have a different shape from features: the reader needs to *reproduce* the issue before anything else, so structure flows around that.

---

## Template

```
h2. Summary
[One sentence describing the user-visible symptom. Not a guess at the cause.]

h2. Steps to reproduce
# [Step 1]
# [Step 2]
# [Step 3]

h2. Actual behavior
[What happens — be precise. "Page freezes for 30 seconds then shows no error" not "it's broken".]

h2. Expected behavior
[What should happen instead.]

h2. Environment
* App / surface: [one of the profile's components, with platform and version, e.g. Mobile (iOS X.Y)]
* Browser / device: [Chrome 124 on macOS 14.4 | iPhone 13 / iOS 17.4 | etc.]
* App version: [if known]
* User type: [persona from the profile]
* Account / user ID: [if applicable — for support tickets]

h2. Impact
* How many users affected: [estimate — single user / one account / all users on plan X / all users]
* Workaround available: [yes / no — describe if yes]
* Frequency: [every time / intermittent — % of attempts / first seen on date]

h2. Acceptance criteria
* Given [the repro condition], when [action], then [expected outcome — the fix]
* [Verification AC: e.g. regression test added covering this scenario]

h2. References
* Sentry: [link]
* Customer ticket: [link if from SUPPORT]
* Logs / dashboards: [link]
```

Optional:
- **Suspected cause** — only if you have strong evidence; mark as suspicion, not fact. Avoid prescribing the fix.
- **Out of scope** — if there's an obvious adjacent bug you're NOT fixing in this ticket.

---

## Good example

```
h2. Summary
End users cannot upload profile photos larger than 5MB on iOS — the app
freezes for ~30 seconds, then the upload fails silently with no error
message.

h2. Steps to reproduce
# Open the end-user app on iOS (tested on iOS 17.4, iPhone 13).
# Navigate to any item that has a photo-upload prompt.
# Tap "Upload photo" and pick a photo ≥5MB from the camera roll
   (e.g., HEIC from iPhone 14 Pro main camera, ~6-8MB).
# Wait.

h2. Actual behavior
The upload progress bar starts but stops at ~15%. The app becomes
unresponsive for ~30 seconds. After that, the screen returns to the
item view with no upload, no error toast, and no entry in the
progress photo history.

h2. Expected behavior
Either the upload completes successfully, or a clear error message
appears within 5 seconds telling the user what went wrong (e.g.
"File too large — please use a photo under 5MB").

h2. Environment
* Surface: Mobile (iOS)
* Device: iPhone 13 / iOS 17.4 (also reproduced on iPhone 14 Pro / iOS 17.5)
* App version: 8.12.0
* User type: End user
* User IDs with reports: 12384, 12511, 12692

h2. Impact
* How many users: ~40 end user reports in the last 30 days
  (search query in description)
* Workaround: Resize the photo before uploading (most end users
  won't know to do this).
* Frequency: 100% reproducible with photos ≥5MB.

h2. Acceptance criteria
* Given an end user on the iOS app with a ≥5MB photo selected,
  when they tap "Upload photo",
  then either the upload succeeds OR a clear error appears within 5 seconds.
* Given the upload fails for any reason, when the failure occurs,
  then the end user sees a specific error message (not silent failure).
* Given the fix ships, when the next mobile release goes out,
  then a regression test covers photos at 5MB, 10MB, and the platform limit.

h2. References
* Sentry issue: https://example.sentry.io/issues/APP-4123
* Sample failing photo: [Drive link]
```

Note: SUPPORT-9821 (the CS escalation) is wired up as a `relates to` issue link via `tracker.link`, not written into References as a URL — see step 9 in SKILL.md. Sentry stays as a plain link since it isn't a Jira issue.

---

## Bad example (anti-pattern: vague + implementation leakage)

```
h2. Summary
Photo upload broken

h2. Description
Upload doesn't work for big files. Need to fix the upload handler in
PhotoUploadController and probably increase the multipart size limit
in Nginx. Maybe also chunk the upload using ActiveStorage::DirectUpload.

h2. Acceptance criteria
* Upload works
```

Why bad:
1. No repro steps — engineer can't tell what "big" means.
2. Prescribes the fix (Nginx, ActiveStorage::DirectUpload) without knowing the root cause.
3. AC is unverifiable.
4. No environment, no impact, no references.

---

## Quick checklist before previewing

- [ ] Summary describes the symptom, not the cause
- [ ] Steps to reproduce are numbered, environment-specific, complete (someone fresh can follow them)
- [ ] Actual vs expected are both stated and precise
- [ ] Environment section is filled in
- [ ] Impact gives at least rough scale and frequency
- [ ] No assigned fix in the description (suspected cause only if marked as suspicion)
- [ ] At least one AC including verification (regression test, monitoring, etc.)
