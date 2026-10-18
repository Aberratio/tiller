# Profile template

A profile holds every fact that changes between projects. Everything under `profiles/` except this
folder is git-ignored, so a profile stays on the machine that uses it.

1. `lib/new-profile.sh <name>` copies this folder to `profiles/<name>/`, drops the `.example`
   suffixes and sets `secrets.env` to mode 600 (or do the same by hand).
2. Fill `profile.md` (contract: `docs/profile-schema.md`, filling order:
   `docs/adding-a-project.md`). Add the repo path to `repo_globs`, or put the name in a
   `.tiller-profile` file at the repo root, or set `TILLER_PROFILE`.
3. Put credentials in `secrets.env`, never in `profile.md`.
4. List the project's names, repos, people, hosts and ticket key pattern in `leak-terms.txt`.
5. Optional: `cases.json` pins paths to the merge authority the profile must give them.
6. `lib/profile-facts.sh --check --profile profiles/<name>/profile.md` until it reports Launch-safe,
   then `lib/leak-guard.sh` to confirm no tracked file names the project.
