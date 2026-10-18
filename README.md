# tiller

Project-agnostic agent skills, plus one local profile per project carrying the facts that differ.

The skills carry no project facts, so a team adopts them by writing a profile, not by forking a
skill. Nothing is installed automatically: `install.sh` symlinks into `~/.claude/skills/` only when
it is run by hand.

## Why it exists

Skills that grow inside one project absorb that project's facts: its merge-signature rule, its
worktree flow, its staging hosts, its test commands. Most of what they teach is not project-specific
at all; it is how a ticket gets opened, reviewed, tested and merged anywhere. This repo separates the
two, so any project gets the procedure without inheriting another project's merge rule.

What couples a skill to a project is hardcoded **paths, repo names, merge rules and toolchain
commands**, not the examples in its prose. Those facts live in the profile; the skill reads them.

## Layout

```
skills/flow-*/             the procedure, with no project facts in it
profiles/_template/        tracked: the starting point for a profile
profiles/<name>/           local, git-ignored: profile.md, cases.json, secrets.env, leak-terms.txt,
                           and optionally skills/ and agents/ that only make sense for that project
personal/_templates/       tracked: templates for one person's generated skills
personal/<user>/           local, git-ignored: one person's skills and leak-terms.txt
lib/resolve-profile.sh     cwd -> profile, or a hard failure
lib/profile-facts.sh       profile -> the facts the driver branches on, or a hard failure
lib/new-profile.sh         create profiles/<name>/ from the template
lib/discovery/             discovery brains: new, check, status (flow-discovery)
lib/leak-guard.sh          refuse tracked content that names a project, a person or a credential
lib/testing/               synthetic fixtures for tests (never a real profile)
brains/_template/          tracked: how to attach a brain
brains/<name>/             local, git-ignored: one vault, its own git repo
brains/access.json         local, git-ignored: which project may read or write which brain
lib/resolve-brains.sh      cwd -> granted brains, or a hard failure
lib/brain-access.sh        print or edit brains/access.json
lib/hooks/private-access.sh  deny tools that reach an ungranted brain or another project's profile
helm/                      local, git-ignored: clone of the private cross-project helm
lib/helm/                  helm CLI, record.sh, template; lib/hooks/helm-session.sh at session start
```

Each skill opens with a `Step −1` that resolves the profile and reads it. **No profile resolves →
the skill stops.** That is the safety property the design is for: a skill must never apply one
project's merge authority to another project because it guessed.

## Setup

From a fresh clone to a working session, in order:

```bash
git clone <this repo> ~/src/tiller && cd ~/src/tiller
git config core.hooksPath .githooks          # leak guard on every commit

# 0. Prerequisites: node >= 20.11, git, bash, jq; gh and claude optional. Every install.sh call
#    checks them first and refuses when one is missing; this installs them through the platform's
#    package manager (brew, apt, dnf, apk, pacman, winget) after showing the plan.
./install.sh --prereqs                        # Windows: .\install.ps1 from PowerShell, see below

# 1. Shared skills and harness roles. Every skill install also records TILLER_HOME where the
#    agents read their environment: the "env" object of ~/.claude/settings.json (with
#    TILLER_MACHINE), ~/.codex/config.toml for --target codex, and one line in the shell's rc file.
./install.sh all                              # symlink every flow-* skill into ~/.claude/skills
./install.sh --target codex all               # the same for Codex (~/.agents/skills)
./install.sh --agents [--profile <file>]      # write flow-resolver, flow-owner-proxy, flow-pm to ~/.claude/agents

# 2. One profile per project (see Profiles below)
lib/new-profile.sh acme                       # also seeds profiles/acme/leak-terms.txt with the name
echo acme > ~/src/acme-web/.tiller-profile    # or repo_globs in the profile's frontmatter

# 3. Personal skills (asks questions in a terminal; --answers <file.json> without one)
./install.sh --setup-personal <user>

# 4. Project-only skills and agents, if the profile has any
./install.sh --profile acme all               # profiles/acme/skills/* and profiles/acme/agents/*.md

# 5. Private access: merge the printed fragment into ~/.claude/settings.json, then restart
./install.sh --hooks                          # brains and other projects' profiles, see brains/_template/

# 6. Helm, optional: one private repository shared by every machine
./install.sh --helm <git-url>                 # or --helm --new <git-url> for a first machine
# TILLER_MACHINE is the host name unless set; add TILLER_MACHINE_CAPS (e.g. calendar) by hand
```

`TILLER_HOME` must be set wherever the skills run; each skill's `Step −1` calls
`$TILLER_HOME/lib/resolve-profile.sh`. Without it every skill resolves no profile and stops, which
is the correct failure but an opaque one. `install.sh` writes it for Claude Code, Codex and the
terminal and keeps any value set by hand; another agent needs it in its own environment. Restart
the session after installing.

### Windows

The shell entry points run in Git Bash; `install.ps1` bootstraps it:

```powershell
git clone <this repo> C:\src\tiller; cd C:\src\tiller
.\install.ps1 all            # installs Git, Node LTS, jq, gh, claude through winget as needed, then runs install.sh all
.\install.ps1 --hooks        # any install.sh form works the same way
```

- `install.sh` writes `TILLER_HOME` and `CLAUDE_CODE_GIT_BASH_PATH` into `settings.json` in the
  `C:/src/tiller` form (forward slashes), which bash and Node both read; `/c/src/tiller` is
  bash-only. `install.sh --hooks` prints its paths the same way.
- `ln -s` needs Developer Mode (Settings > System > For developers); `install.ps1` enables it when
  run as administrator. Without it `install.sh` links skills as junctions, which work the same.
- The unattended drivers (`flow-run-ticket`, `flow-run-day`) are not supported on Windows; the
  interactive `flow-*` skills are.

## Profiles

A profile is a folder, `profiles/<name>/`, and stays on the machine that uses it:

```bash
lib/new-profile.sh acme                 # copies profiles/_template/ to profiles/acme/
$EDITOR profiles/acme/profile.md
lib/profile-facts.sh --check --profile profiles/acme/profile.md
lib/leak-guard.sh
```

Resolution order: `TILLER_PROFILE` env var → a `.tiller-profile` file at the repo root (one line,
the profile name) → `repo_globs` in a profile's frontmatter → fail.

An unattended run needs the facts as values rather than as a file: the driver reads no profile, so
every fact it branches on is rendered once, before anything spawns. `lib/profile-facts.sh` renders
them and refuses when a required section is unfilled, including one that still reads `TODO`:

```bash
"$TILLER_HOME/lib/profile-facts.sh" --check ~/src/acme-web
# -> per-key report; exit 4 means a launch against this profile would be refused
```

The contract (required sections, the facts object, the rule that a profile carries facts and never
procedure) is [docs/profile-schema.md](docs/profile-schema.md); filling a new one is
[docs/adding-a-project.md](docs/adding-a-project.md) and `profiles/_template/README.md`.
Credentials go in `profiles/<name>/secrets.env` (mode 600), never in `profile.md`.

A skill or agent that only makes sense for one project (a QA lane for that product, a simulator
for its domain) lives in `profiles/<name>/skills/<skill>/` or `profiles/<name>/agents/<agent>.md`
and is installed with `./install.sh --profile <name> all`.

## Personal skills

Skills about one person rather than one project (a daily note, a writing voice) are generated into
`personal/<user>/`, which is git-ignored. `install.sh --setup-personal <user>` generates and links
them, `install.sh --personal <user> all` re-links; a plain `all` never does. The mechanism and the templates: `personal/_templates/README.md`.

## Helm

The helm is a private overview above the profiles: which project is at which stage, what is next,
what is due, what was promised, which machine holds which clone. It lives in its own git
repository, cloned into `helm/`, and is shared by every machine that runs tiller.

Projects write to it and never read it: `flow-*` skills call `lib/helm/record.sh` at fixed
milestones, which stamps the resolved profile, and the private-access hook denies a project
session every path under `helm/`. Each write is a new file under `events/`, so two machines never
conflict. At session start `lib/hooks/helm-session.sh` prints at most five lines: overdue, due
within 48 hours, parked, stale projects, machines that have not synced. `flow-helm` gives the full
status and proposes calendar events. It advises; it never starts work. Design:
`docs/superpowers/specs/2026-10-14-helm-design.md`.

## Leak guard

Every tracked file must stay free of project, company and personal facts. `lib/leak-guard.sh` scans
the files git would track against the local lists `profiles/*/leak-terms.txt` and
`personal/*/leak-terms.txt` (one case-insensitive extended regex per line), plus credential shapes.
`.githooks/pre-commit` runs it with `--staged`; `git config core.hooksPath .githooks` enables it.
A hit means the fact belongs in a profile, not that the term list is wrong.

## Skills

| Skill | Role |
|---|---|
| `flow-start-ticket` | open work on a ticket: branch, status, plan |
| `flow-plan-ticket` | turn a specified ticket into a plan |
| `flow-brainstorm` | explore what to build before a ticket exists; one recorded decision |
| `flow-tdd` | build test-first |
| `flow-code-review` | two-axis review, no verdict |
| `flow-confidence-check` | final verdict on a finished branch |
| `flow-diagnose-bug` | find and prove a cause |
| `flow-decision-ledger` | record a deviation or a post-ticket agreement |
| `flow-create-commit` | commit in the profile's `## commits` format |
| `flow-create-pull-request` | open a draft PR |
| `flow-resolve-conflicts` | resolve a conflicted merge or rebase; reads `## generated files` |
| `flow-run-ticket` / `flow-run-day` | launch an unattended ticket or day run |
| `flow-resolver` | settle an open question; inviolables come from the profile (`docs/escalation.md`) |
| `flow-owner-proxy` | act in the owner's place, inside the profile's closed mandate |
| `flow-retro` | read a day's runs as a whole and propose edits with evidence; applies nothing (`skills/flow-retro/bin/retro.mjs`) |
| `flow-write-ticket` | write or clean up a ticket; conventions from `## ticket conventions` |
| `flow-pm` | keep the board true; mandate from `## board` |
| `flow-manual-qa` | decide which criteria need a human; register from `## verification register` |
| `flow-onboard-project` | create a profile from detected facts and a human's answers; report drift (`lib/onboard/onboard.mjs`) |
| `flow-helm` | cross-project status, reminders and calendar proposals from the private helm |

## The harness in pictures

Six diagrams, widest view first. They render on GitHub; other viewers need a Mermaid-capable preview.

### 1. Which project am I in?

Every skill starts with this. No profile resolved means no work.

```mermaid
flowchart TD
    A(["Skill starts in some directory"]) --> B{"TILLER_PROFILE<br/>env var set?"}
    B -->|yes| OK
    B -->|no| C{".tiller-profile file<br/>at the repo root?"}
    C -->|yes| OK
    C -->|no| D{"cwd matches a profile's<br/>repo_globs?"}
    D -->|yes| OK
    D -->|no| STOP["STOP<br/>no profile resolved"]
    OK["profiles/&lt;name&gt;/profile.md"] --> O{"TILLER_OVERLAY set?"}
    O -->|yes| OV["profiles/&lt;name&gt;/overlays/&lt;env&gt;.md<br/>replaces same-named sections;<br/>merge authority, inviolables,<br/>owner proxy cannot be overridden"]
    O -->|no| E
    OV --> E{"profile-facts.sh --check<br/>required sections filled,<br/>no TODO left?"}
    E -->|yes| GO(["Skill runs with this<br/>project's facts"])
    E -->|"no, exit 4"| STOP2["STOP<br/>names the missing sections"]

    classDef stop fill:#fde2e1,stroke:#c0392b,color:#7b241c
    classDef go fill:#dff5e3,stroke:#27ae60,color:#145a32
    class STOP,STOP2 stop
    class GO go
```

### 2. One ticket, by hand

The interactive path. Each box is one skill; the arrow is what it hands on.

```mermaid
flowchart TD
    W["flow-write-ticket<br/><i>ticket is not spec-shaped yet</i>"] -.-> ST
    DB["flow-diagnose-bug<br/><i>cause unknown</i>"] -.->|"deliverable: a plan"| PL
    ST["flow-start-ticket<br/>sanity-check, branch from<br/>fresh main, set status"] -->|ticket + branch| PL
    PL["flow-plan-ticket<br/>verify premise, seam table"] -->|plan + seams| TD
    TD["flow-tdd<br/>red, green per seam"] -->|working tree| CR
    CR["flow-code-review<br/>Standards + Spec, reports only"] -->|findings fixed| CM
    CM["flow-create-commit<br/>format from profile ## commits<br/>(default: Conventional Commits)"] --> PR
    PR["flow-create-pull-request<br/>always a draft"] --> CC
    CC["flow-confidence-check<br/>verdict on the branch,<br/>in a fresh subagent"] --> QA
    QA["flow-manual-qa<br/>criteria that need a human"]

    LG[("flow-decision-ledger<br/>one file per branch")]
    PL -. writes deviations .-> LG
    TD -. writes deviations .-> LG
    LG -. read into briefs .-> CR
    LG -. read into briefs .-> CC
    RC["flow-resolve-conflicts"] -. "on a merge or rebase conflict" .-> CM
```

`flow-pm` sits beside this line: it reconciles the board with the artefacts and is never a step in it.

### 3. The layers of an unattended run

The driver (`lib/driver/`) holds the phases, the counters and the gate arithmetic. It runs the
deterministic scripts itself, one process per call, and reaches a model only through judgment lanes.

```mermaid
flowchart TB
    subgraph W["Node driver, lib/driver/"]
        W1["phases, counters,<br/>gate arithmetic, journal"]
    end
    subgraph A["Agents: judgment only"]
        A1["plan / implement / fix"]
        A2["review axes, confidence,<br/>QA judge"]
        A3["resolver, owner proxy"]
    end
    subgraph D["Deterministic scripts in lib/, tested"]
        D1["git/ forge/ gates/ state/"]
    end
    W1 -->|prompt + output schema| A
    A -->|"JSON that must validate"| W1
    W1 -->|"one script by absolute path"| D1
    D1 -->|"one JSON line on stdout"| W1
    A2 -. "a claim that feeds a gate<br/>is re-derived by a script" .-> D1
```

Lane tiers come from `config/routing.json`: T1 haiku, T2 sonnet (prose, logs, premise), T3 opus
(every lane that can open a gate). A gate lane is never routed below the session's tier.

### 4. One ticket, unattended (`flow-run-ticket`)

The fourteen phases of the ticket driver (`lib/driver/phases.mjs`). Each writes a checkpoint, so a
dead run resumes at the phase it died in.

```mermaid
flowchart TD
    L["Launcher: resolve profile, probes,<br/>args, node driver"] --> start
    start["start<br/>duplicate guard, worktree"] --> premise
    premise{"premise<br/>does the ticket's claim<br/>hold in the repo?"} -->|falsified| PARK1["decision: rewrite<br/>or close the ticket"]
    premise -->|holds| plan["plan"]
    plan --> impl["implement<br/>test claim re-run by a script"]
    impl --> review["review<br/>Standards + Spec axes"]
    review -->|"high+ findings,<br/>fixRounds left"| fix1["fix round"] --> review
    review --> pr["pr<br/>draft PR"]
    pr --> ci{"ci<br/>wait-ci on head SHA"}
    ci -->|"red, ciFix left"| fix2["fix round"] --> ci
    ci -->|green| bot["review-bot<br/>threads answered"]
    bot --> conf["confidence<br/>independent re-verify"]
    conf -->|"confirmed high+<br/>after 2 passes"| PARK2["decision:<br/>split or take over"]
    conf --> gate{"gate<br/>profile gates + merge<br/>authority, as code"}
    gate -->|"agent may merge,<br/>all green"| merge["merge"]
    gate -->|"human must sign,<br/>all green"| RTS["ready-to-sign<br/>PR left open"]
    gate -->|not green| PARK3["parked"]
    gate -->|"merge held by launcher"| OPEN["open-pr"]
    merge --> qa["qa<br/>criteria vs deployed SHA"]
    qa --> clean["cleanup"] --> logs["logs<br/>run summary"]

    classDef park fill:#fdebd0,stroke:#d68910,color:#7e5109
    classDef sign fill:#e8daef,stroke:#7d3c98,color:#4a235a
    classDef done fill:#dff5e3,stroke:#27ae60,color:#145a32
    class PARK1,PARK2,PARK3 park
    class RTS sign
    class merge,logs done
```

Ready-to-sign is not a failure: it is the run finishing on a path the profile's `## merge authority`
reserves for a human signature.

### 5. When a run gets stuck: the escalation chain

Every question walks the same chain, one hop at a time (`lib/escalation/route.mjs`). Only the lists
(inviolables, mandates, hard-stop channels) come from the profile.

```mermaid
flowchart LR
    Q(["a phase cannot<br/>proceed"]) --> HB{"harness block?<br/>classifier or<br/>permission denial"}
    HB -->|yes| NOBODY["goes to nobody<br/>listed with the rule quoted;<br/>no answer would unblock it"]
    HB -->|no| SG{"needs a<br/>signature?"}
    SG -->|yes| RTS["ready-to-sign list"]
    SG -->|no| SC{"source cascade<br/>repo docs, ticket,<br/>comments, PRs, ledger"}
    SC -->|answered| DEC["decided"]
    SC -->|no answer| HS{"hard stop?<br/>someone else's PR,<br/>outward channel"}
    HS -->|yes| HUMAN
    HS -->|no| RES{"resolver<br/>researches, weighs,<br/>states reversal cost"}
    RES -->|"touches an inviolable"| INV["inviolable park<br/>with recommendation"]
    RES -->|"decides, no mandate needed"| DEC
    RES -->|"needs the owner's mandate"| MAN{"mandate in the<br/>profile's closed list?"}
    MAN -->|no| HUMAN["parked for<br/>the human"]
    MAN -->|yes| OP["owner proxy<br/>acts and reports"]
    OP -->|"condition unmet"| HUMAN
    OP -->|done| PROX["proxied"]

    classDef human fill:#e8daef,stroke:#7d3c98,color:#4a235a
    classDef ok fill:#dff5e3,stroke:#27ae60,color:#145a32
    classDef grey fill:#eaecee,stroke:#7f8c8d,color:#2c3e50
    class HUMAN,RTS,INV human
    class DEC,PROX ok
    class NOBODY grey
```

The owner proxy's vocabulary is six mandates: `approve-day-queue`, `start-next-ticket`,
`approve-peer-step`, `resume-run`, `lift-cap-once`, `undraft-pr`. It never signs and never writes to
a hard-stop channel.

### 6. A whole day, unattended (`flow-run-day`)

A day is waves of ticket runs. The supervisor is a plain shell loop on purpose: it has no context to
grow, and its only decision is reading `state.md`.

```mermaid
flowchart TD
    Q["approved queue<br/>waves.json"] --> DA{"harness.mjs day-args<br/>profile has owner proxy,<br/>day ceiling, maxParallel?"}
    DA -->|no| REF["refused:<br/>the refusal is the answer"]
    DA -->|yes| ENV["supervisor env<br/>stop hour, denied tools"]
    ENV --> SUP

    subgraph SUP["lib/supervisor/supervise.sh, loop"]
        S1["spawn one bounded<br/>claude -p child"] --> S2{"state.md says?"}
        S2 -->|"supervisor: done"| END(["day over"])
        S2 -->|"paused-usage &lt;reset&gt;"| SLEEP["wait for the reset"] --> S1
        S2 -->|"still running"| S3{"stop hour reached?<br/>spawn cap? no progress?"}
        S3 -->|no| S1
        S3 -->|yes| END
    end

    S1 --> DAY
    subgraph DAY["lib/driver/day.mjs, inside the child"]
        D1{"open decisions<br/>under the ceiling?"} -->|yes| D2["start up to maxParallel<br/>run-ticket children"]
        D1 -->|"at ceiling"| D3["ask owner proxy once:<br/>lift-cap-once"]
        D3 -->|refused| CEIL(["day stops: ceiling"])
        D3 -->|granted| D2
        D2 --> D4["base branch moved?<br/>one sweep lane looks<br/>for regressions"]
        D4 --> D5{"next wave?"}
        D5 -->|"only via owner proxy:<br/>start-next-ticket"| D1
        D5 -->|"no waves left"| DONE(["supervisor: done"])
    end
```

Harness blocks and ready-to-sign parks never count toward the ceiling. The report back lists
ready-to-sign PRs, open decisions and sweep regressions, with every gate re-read from the forge.

## Wayfinding

`/wayfinder` charts a foggy effort as a map of decision tickets on "this repo's issue tracker". Here
the maps live in one private repo kept apart from every delivery board: a decision ticket is not a
deliverable, and on a sprint board it distorts the board and leaks internal vocabulary into tickets
that must carry none.

The skill is **not forked**. `wayfinding/issue-tracker-section.md` is appended to a project's
`docs/agents/issue-tracker.md`, which is the file the skill already reads, and the profile's
`## wayfinding` section names the maps repo and the project label. `wayfinding/setup-wayfinding.sh`
provisions the repo and labels once per machine. Details in `wayfinding/README.md`.
