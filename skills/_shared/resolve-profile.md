## Step −1 — Resolve the project profile (before anything else)

```bash
PROFILE="$("$TILLER_HOME/lib/resolve-profile.sh" .)"   # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact a skill needs — tracker and project key, main
branch, branch convention, worktree procedure, ledger path, merge authority, environments, test
commands, gates — comes from there and from nowhere else. `$PROFILE` below means that file.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.

## Canonical block in a skill

```markdown
## Step −1 — Resolve the project profile

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow it; no profile resolves → stop.
```

A skill may add one line after it naming the profile sections it reads and what it does when one is
absent. Nothing else about resolution is restated in the skill.

## Pre-profile variant

A skill that can legitimately run before a profile exists (starting a new project, onboarding one,
a first commit in a repo nobody onboarded, an overview that spans projects) uses this heading and
line instead:

```markdown
## Step −1 — Resolve the project profile (may be absent)

Read `$TILLER_HOME/skills/_shared/resolve-profile.md` and follow its pre-profile variant.
```

Run the same command. Resolution failing is **not** a stop for these skills, but it is never
guessed around either:

- **No profile resolves** → the skill runs in its documented no-profile mode (stated in the skill:
  what it still does, which defaults it uses, what it refuses). It never borrows another
  project's profile and never invents facts.
- **A profile resolves** → read the sections the skill names, exactly as in the standard step.

The skill states, right after the block, which mode it is in when there is no profile and why that
is safe.
