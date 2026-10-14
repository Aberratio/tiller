## Step −1 — Resolve the project profile (before anything else)

```bash
"$TILLER_HOME/lib/resolve-profile.sh" .        # prints the profile file; non-zero means stop
```

Read the profile it names. Every project-specific fact this skill needs — tracker and project key, main branch,
branch convention, worktree procedure, ledger path, merge authority, environments, test commands,
gates — comes from there and from nowhere else.

**No profile resolves → stop and say so.** Do not fall back to the project you saw last. Applying
one project's merge rule or test command to another is the failure this whole mechanism exists to
prevent.
