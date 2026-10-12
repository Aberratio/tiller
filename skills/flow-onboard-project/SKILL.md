---
name: flow-onboard-project
description: Onboard a project into the harness - detect every fact a script can read from its repos, put the remaining decisions to a human, render profiles/<name>/profile.md and prove it with profile-facts --check. Also reports where an existing profile drifted from its repos. Use when the user says "onboard <project>", "add a project to tiller", "create a profile for <repo>", or asks whether a profile is still true.
user-invocable: true
---

# flow-onboard-project

The script does the work; this skill carries questions between the script and a human. There is
no profile-resolution step: the profile does not exist yet, and creating it is the point.

```bash
O="node $TILLER_HOME/lib/onboard/onboard.mjs"
```

## Rules

- **The detection is the only reader of the repos.** `detect.mjs` already read branches, commits,
  lockfiles, `package.json` scripts, workflows, branch protection and recent PR reviewers. A fact
  it reports as `not detected` becomes a question for the human.
- **Every answer is the human's.** Each `answer` call carries what the human picked or typed,
  `mergeAuthority` included: its default `unconfirmed` parks every merge, which is correct until
  someone who knows the project's rule says otherwise. `answer` refuses `mergeAuthority agent`
  (exit 3); when the human picks it, they set it themselves with `$O ask <name>` in a terminal.
- **On request only:** when the human asks "what does the repo say?", read the single file the
  question names (for `branching.integrateMain`, `CONTRIBUTING.md`) and quote the line. A written
  rule beats history, and history is all the script can see.

## Steps

1. **New project.** `$O new <name> <repo-dir>... --project "<Display name>"` (add `--no-network`
   when `gh` is unavailable). It scaffolds `profiles/<name>/` with `lib/new-profile.sh` and renders
   `profile.md` there. Exit 3 means a repo already belongs to a profile: run step 5 on that
   profile instead, and pass `--force` only when the human says the repo moves to the new one.
2. **Questions.** `$O questions <name> --json`. Put the open ones to the human with
   `AskUserQuestion`, at most four per call, required ones (`required: true`) first, each
   question's `options` as given with the first option first. `multi: true` is multi-select; for
   `multi: "text"` (inviolables) offer `none` and let "Other" carry the items.
3. **Answers.** For each answer, `$O answer <name> <id> <value>...`, one value per selected
   option. Exit 2 names what was malformed: re-ask that question only. Exit 3 means the value
   looked like a credential: ask where it lives instead (it goes in `profiles/<name>/secrets.env`),
   except for `mergeAuthority agent` (Rules).
4. **Prove.** The last `answer` prints the `--check` result; done means it ends `Launch-safe.`
   Then report in one line what stays for a human: the TODOs left in the profile (QA statuses,
   environments, release, known issues), the `## tools` rows to change from `default`, and the
   project's own names to add to `profiles/<name>/leak-terms.txt`.
5. **Drift.** `$O drift <name>` lists, read-only: changed main branches, required checks and
   active review bots that are not declared gates, detected commands and lockfiles missing from the
   profile, scripts the profile calls that no longer exist, stale `measured` dates, and a `## repos`
   table it cannot read. Exit 5 means at least one `- ` finding, each a line for the human; `note:`
   lines (TODOs, facts not compared) do not fail. A hand-written profile is the human's to edit.
6. **Graduate.** When the human wants to write prose into the profile, they delete its
   `onboarding: generated` line. From then on `render` refuses the file and `drift` keeps it honest.

The human can skip every model turn with `$O ask <name>`, which runs the same questions in the
terminal.
