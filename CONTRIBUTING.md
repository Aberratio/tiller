# Contributing

## Run the tests

```bash
npm test                          # every suite, one summary table, non-zero on any failure
node lib/testing/run-all.mjs --list
node lib/testing/run-all.mjs --only driver
bash lib/leak-guard.sh            # must be clean before you commit
```

Node 20.11 or newer, no dependencies to install. Tests are hermetic: fixtures under
`lib/testing/fixtures/`, no network, no real `claude` or `codex`, never a real profile. A test
that routes through the runtime adapters gets stub binaries from `lib/testing/fake-runtime.mjs`.

## Commits

Plain single-line Conventional Commits in English, for example `fix(driver): refuse an empty queue`.
No trailers, no ticket keys, no agent attribution.

## What a tracked file may contain

Tracked files carry no project, person or vendor facts: no company names, hosts, repo names,
e-mail addresses, credentials or machine paths. **Procedure lives in skills; facts live in
profiles** (`profiles/<name>/`, local and git-ignored). If a skill needs a fact, it reads the
profile; if the profile lacks the section, the skill stops rather than guessing.

`lib/leak-guard.sh` enforces this. It checks the files git would track against the local term lists
(`profiles/*/leak-terms.txt`, `personal/*/leak-terms.txt`) and against credential shapes.
`git config core.hooksPath .githooks` runs it on every commit. A hit means the fact belongs in a
profile; do not weaken the guard.

Code comments state only the non-obvious why, in one or two sentences. Gates and checks fail
closed: when a reading is missing or ambiguous, the answer is "no".

## Add a skill

1. Create `skills/<name>/SKILL.md` with frontmatter (`name`, `description`) and a first section
   `Step −1` that resolves the profile; copy `skills/_shared/resolve-profile.md`. When no profile
   resolves, the skill stops.
2. Keep every project fact out of the text; name the profile section that carries it, and add that
   section to `docs/profile-schema.md` and `profiles/_template/` if it is new.
3. Add tests next to it (`skills/<name>/tests/*.test.mjs`); `npm test` picks them up.
4. Add a row to the skills table in `README.md`.

## Add a runtime adapter

1. Create `lib/driver/adapters/<name>.mjs` returning the shape in `lib/driver/adapters/README.md`
   and refusing, before it spawns anything, a role or tool it cannot honour.
2. Register it in `lib/driver/adapters/index.mjs`, including how its availability is probed.
3. Test it against a fake binary or a local fake server, never the real service.
4. Document it in the adapters README table (schema, budget, denials, what it was verified against).
