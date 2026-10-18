# Projects without code — plan

Source: `docs/superpowers/specs/2026-10-18-guided-setup-design.md`, section "Follow-up: projects
without code". No tracker ticket; the spec section is the ticket. Ledger:
`docs/superpowers/decisions/guided-setup.md`.

## 1. What this is

`tiller project new` learns two questions: what the project is (`code` | `document` | `notes`) and
whether the given directory is one repository or a project folder. `code` keeps today's path.
`document` writes a launch-safe profile with no tracker, gates, tests or static checks. `notes`
writes no profile and offers a brain instead.

Premise check (measured 2026-10-18 on a scratch copy of `b513685`):

- `profile-facts.sh --check` refuses a profile whose `## gates` is `none`
  (`lib/profile-facts.sh:241`, "a project declares at least one gate"). Tracker `Kind: none`,
  `## test toolchain none` and `## static checks none` pass. The spec's open point is therefore
  false as written; the owner chose a profile-level `Kind: document` marker that alone may declare
  gates `none`.
- `onboard.mjs answer <name> gates none` is refused (each value must be a gate source).
- A repository with no `origin/HEAD` leaves `repos — primary repo main branch` at TODO, so a
  local-only manuscript cannot end launch-safe through onboarding. Pre-existing, affects `code`
  too; out of scope, recorded as a residual.
- `lib/profile-name.sh:29` matches `$glob|$glob/*`: one glob for a folder covers every repository
  below it, including later ones. Confirmed.
- Node's `spawnSync('bash'|'git')` fails with EPERM in this sandbox while an unreadable directory
  sits early on PATH; the tests here run with a PATH of readable directories only.

## 2. Decisions taken, overridable

- The marker is a bullet `- Kind: code | document` in `## identity`; absent reads `code`. No
  `schema_version` bump: an older renderer refuses a document profile on its gates, the safe side.
- Only `Kind: document` may write `## gates` `none`; the facts object gains `kind` and renders
  `gates: []` for it. A document profile may still declare gates.
- `onboard.mjs` gains the answer `identity.kind` (`code` | `document`). For `document` the `gates`
  question is dropped and `## gates`, `## test toolchain`, `## static checks` render `none`
  regardless of detection. A `code` render is unchanged byte for byte.
- In the wizard `project.kind` is asked before the name, default `code`; an answers file without
  it and no terminal is exit 4, as the spec says. Existing tests' answers files gain
  `kind: code`, which is the only change to them.
- `project.folder` (default `false`) is asked after the directory. A folder is onboarded with
  every direct child that is a git repository and `--glob */<parent>/<folder>`; a folder with no
  repository yet stops with a resume command. The `.tiller-profile` question is not asked for a
  folder: the resolver reads the marker at a repository root, and the glob already covers it.
- `document`: tracker `none`, gates dropped, merge authority asked by the wizard as
  `project.merge`, default `human`, passed to onboarding as `mergeAuthority`. A
  `project.answers.mergeAuthority` still wins.
- `notes`: asks the name, then `project.brain` (default yes). Yes copies `brains/_template/` to
  `brains/<name>/`, `git init`s it, and runs `lib/brain-access.sh --set _none <name>
  <project.access>` with `project.access` default `read` (the `_none` row is every folder without
  a profile, so the narrower level is the default). The verdict says flow-* skills stop in that
  folder by design.
- `notes` done-check: `brains/<name>/` exists and the matrix grants at least the asked level, or
  `project.brain` is `false`. A second run asks nothing and changes no file.
- Test-only switch `TILLER_BRAINS_HOME` (the `TILLER_HOME` handed to `brain-access.sh` and where
  `brains/<name>` is created), default the checkout, so the sandbox never writes the real matrix.

## 3. Seam table

| seam | test level | loop mode | deliberately not tested here |
|---|---|---|---|
| `profile-facts.sh` `Kind` + gates rule | unit, `lib/gates/tests/profile-facts.test.mjs` | red→green per rule | the gate evaluator with zero gates (unchanged code path: no conditions) |
| `onboard/profile.mjs` questions + render for `identity.kind` | unit, `lib/onboard/tests/onboard.test.mjs` | red→green | detection of prose repositories |
| wizard `project` step: kind, folder, document, notes | unit in the sandbox, `lib/setup/tests/kinds.test.mjs` | red→green; `code` pinned by snapshot | interactive prompts (covered by the answers-file rule) |
| `code` path byte for byte | pin: profile and stdout of a `kind: code` run equal the pre-change run | green before and after | — |

## 4. Steps

1. Schema: `Kind` in `## identity`, gates `none` for document, `kind` in facts;
   `docs/profile-schema.md`. Unit. Agent.
2. Onboarding: `identity.kind` answer, document render. Unit. Agent.
3. Wizard: `project.kind`, `project.folder`, document path, pin for `code`. Unit. Agent.
4. Wizard: `notes` with the brain offer and grant, idempotency. Unit. Agent.
5. Docs: README "Profiles", `docs/adding-a-project.md`, `profiles/_template/profile.md` identity
   line. Non-behavioural. Agent.

Gates before each commit: `npm test`, `npm run lint:shell` (no new finding), `npm run
lint:skills`, `bash lib/leak-guard.sh`.

## 5. Hand-offs and gates

- Push and PR: owner (`git push -u origin feat/projects-without-code`); push does not work from
  the agent's sandbox.
- Merge authority (`tiller` profile): `**` → `human`.

## 6. What no test level reaches

- A real interactive run of `tiller project new` choosing each kind: owner.
- The private-access hook against a real brain created by `notes`: owner (the hook is not run in
  the sandbox).

## 7. Traceability

| spec line | step |
|---|---|
| layout, one glob per folder, repositories added later | 3 (test: a repository added after onboarding resolves) |
| kind question, default `code`, `code` unchanged | 3 (pin) |
| `document` profile launch-safe, merge authority asked | 1, 2, 3 |
| `notes`: no profile, brain offer, grant through `brain-access.sh`, flow-* stop | 4 |
| answers file `project.kind`, `project.folder`, exit 4 | 3 |
| open point: gates `none` | 1 |
| README, adding-a-project | 5 |
