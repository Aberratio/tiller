# tiller setup: clarity fixes after the first Windows run

The first real run (Windows, Git Bash, Claude Code from npm) finished only with hand-held steps.
Each item below is a place where the wizard left its user guessing. Build test-first; ledger:
`docs/superpowers/decisions/guided-setup.md`.

## What went wrong, in run order

1. Prompts name a step but never say what it is for. "Personal skills: new, or clone" read as
   "clone your project", so a project repository was cloned into `personal/<user>/`.
2. `personal clone` links before checking the clone: a repository without `skills/` fails at
   linking and leaves the wrong clone behind.
3. `personal new` starts a long questionnaire (two skills, a written voice and a standup note,
   Slack ids) with no way to skip it. The workaround was an empty `personal/<user>/skills/`.
4. `project` counts any launch-safe profile as done, so two stale profiles copied onto the machine
   skipped the step and the new project got no profile.
5. `project` takes one repository. A project made of several repositories needs
   `onboard.mjs new <name> <dir>... --force` by hand afterwards; `tiller project new` takes one too.
6. A git URL given to `project` is cloned into the current directory, which is `tiller/` when
   started from `install.ps1`.
7. No step attaches an existing notes repository (a brain) to the project; that took
   `git clone … brains/<name>` and `lib/brain-access.sh --set …` by hand.
8. The optional step's prompt does not say what it clones or how it differs from a brain.
9. After setup there is no way to ask where things stand and what to do next; the owner did not
    know how to check status.
10. Nothing checks that a project's repositories install and start on this machine.
11. The personal step offers the OS user name; an existing personal repository under another name
    (`tiller-personal-<name>`) has to be found by hand.
12. A `.cmd` shim spawned with `shell: true` and an args array prints Node's DEP0190 warning in the
   middle of a prompt.
13. `bin/doctor` reports git, bash and jq as missing on Windows while the tools step found them:
    `which()` in `lib/doctor/doctor.mjs` tries only the bare name, never `.exe`/`.cmd`. Its verdict
    is the wizard's last word, so a working machine ends in "a required check failed".

## Fixes

1. **Step header and one-line purpose.** Every step prints `Step n/N: <name>` and one plain
   sentence on what it sets up and whether it is needed, before its first question.
2. **Personal: `new / clone / skip`.** The prompt names the two generated skills and says they are
   optional. `skip` writes nothing and the step reads as done (`personal: skipped`) on the next run.
   Without a terminal and no answer, the default stays `new`, so answers files keep working.
3. **Personal clone checks first.** Clone into a temp directory; no `skills/` there → delete it,
   fail with "this repository has no skills/; a project repository belongs to the Project step",
   and leave `personal/<user>/` untouched.
4. **Project asks when profiles already exist.** On a terminal, with profiles present and no
   `project.name` answer: list them and ask whether to add a new project (default no). Answers-file
   and `--yes` behaviour unchanged.
5. **Several repositories per project.** The prompt takes a list (paths or git URLs, separated by
   spaces or commas); all directories go to one `onboard.mjs new` call. `tiller project new <name>
   <repo>...` takes the same list.
6. **Clones land beside each other.** URLs are cloned into `<parent of tiller>/<project>/<repo>`
   (asked, with that default), never into the current directory.
7. **Optional brain step for the project.** After `project`: "Attach a notes repository to this
   project? (git URL or empty)". Clone into `brains/<name>/`, then
   `lib/brain-access.sh --set <profile> <brain> <level>`, with the level asked (default `write`) and
   checked through `lib/resolve-brains.sh`.
8. **Optional step's prompt** says what it is: one private notes repository shared across all
   projects, different from a per-project brain.
9. **No DEP0190.** With `shell: true`, spawn one already-quoted command string instead of an
   argument array; keep the `launch` tests, add one for the string form.
10. **Closing summary.** After the verdict: what was created, where (profile, repositories,
    brain), and the one command to start working.

11. **`tiller status`.** One screen, no network beyond `gh auth status`: each wizard step done or
    not, each profile with its repositories (cloned / missing / dependencies installed), open
    `TODO`s in its profile, attached brains, whether the cross-project notes repository is present,
    and the single next command. The wizard's closing summary prints the same thing.
12. **Repository readiness.** Per repository of a profile: lockfile present → dependencies
    installed? The profile's `## worktree setup` commands as the install step, offered once; a
    missing toolchain (node version, package manager) named with its install line. Starting the app
    stays out of scope: report the command, do not run a server.
13. **Personal clone by name.** The prompt accepts a name and looks for `tiller-personal-<name>` on
    the signed-in GitHub account, and the linked directory is `personal/<name>/`.

14. **Doctor on Windows.** `which()` tries the `PATHEXT` extensions (default `.exe;.cmd;.bat;.com`)
    on win32, with the platform injectable for tests. Do this one first: every later Windows check
    reads its verdict.

## Checks

- Gates before every commit: `npm test`, `npm run lint:shell` (baseline 67), `npm run lint:skills`,
  `bash lib/leak-guard.sh`.
- A mutation sweep per fix, as in the earlier steps.
- Windows behaviour (prompts in PowerShell → Git Bash, `.cmd` shims) is verified only by the
  owner's rerun; say so in the ledger.
