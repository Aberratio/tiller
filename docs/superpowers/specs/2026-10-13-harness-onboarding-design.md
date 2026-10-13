# Harness onboarding

## Goal

Bring a machine from a fresh clone to a working harness with one command, on macOS, Linux or native
Windows, for whichever supported agent is installed there. Two modes share one core:

- **Fresh adopter**: someone clones tiller for the first time, with their own agent, OS and tools.
- **Another machine**: a person restores their own setup (global settings, instructions, personal
  skills, profiles) from their private personal repo.

Global agent settings (`~/.claude/settings.json`, `~/.claude/CLAUDE.md` and their Copilot CLI
equivalents) are managed as layered desired state and merged key by key, never overwritten
wholesale.

## Decisions

| Question | Decision |
|---|---|
| Audience | Both modes, one core. |
| Agents in v1 | Claude Code and GitHub Copilot CLI. Any other tool gets the `files` fallback: skills and instructions on disk, no integration. |
| Operating systems | macOS, Linux, native Windows. |
| Installer language | Node, no npm dependencies. `install.sh` stays as a thin wrapper. |
| Global settings | Layered desired state; `apply` merges only keys recorded in an ownership manifest. |
| Instructions files | Only a marker-delimited block is managed. |
| Personal layer | `personal/<user>/` is its own git repo with a private remote, like `brains/<name>/`. |
| Tool installation | Never runs a package manager; prints the per-OS command. |
| Missing tool | Disables the features that need it, not the onboarding. |

## Layout

```
bin/tiller.mjs                  entry point: doctor, onboard, apply, status, uninstall
bin/tiller, bin/tiller.cmd      shims for POSIX shells and Windows
lib/machine/probe.mjs           OS, shells, tool versions, installed agents and their config dirs
lib/machine/capabilities.mjs    feature -> requirements -> ready | degraded | unavailable
lib/adapters/claude.mjs         logical targets -> Claude Code paths and formats
lib/adapters/copilot.mjs        logical targets -> Copilot CLI paths and formats
lib/adapters/files.mjs          fallback for any other tool
lib/apply/layers.mjs            merge base -> personal -> machine, expand ${TILLER_HOME} and ${HOME}
lib/apply/merge.mjs             owned-key merge, drift detection, atomic write, backup
lib/apply/manifest.mjs          ~/.tiller/owned.json
lib/apply/link.mjs              symlink, junction or copy, per OS
config/harness/base.json        tracked: the generic desired state
personal/_templates/harness.json  tracked: template for a personal layer
~/.tiller/                      local, per machine (override: TILLER_STATE_HOME)
  machine.json                  probe result plus machine-only values
  owned.json                    ownership manifest
  backups/<timestamp>/          the native files as they were before each apply
```

## Commands

| Command | Does |
|---|---|
| `tiller doctor` | Probe, then print each feature as ready, degraded (with the reason) or unavailable (with the install command for this OS). Read-only. |
| `tiller onboard [--personal <git-url>] [--agents claude,copilot]` | Doctor, clone the personal repo, choose agents (default: every one detected), apply, link skills and agents, list missing `secrets.env` files. |
| `tiller apply [--yes] [--dry-run] [--agents ...]` | Render the desired state per agent, show the diff, write on consent. |
| `tiller apply --adopt <agent>` | Read the agent's current native files and propose a personal layer that reproduces them. Writes only into `personal/<user>/`. |
| `tiller status` | Owned keys, their drift, linked skills and agents. |
| `tiller uninstall [--agents ...]` | Remove exactly what the manifest records. |

`install.sh all`, `--agents`, `--profile` and `--personal` keep working and call the same link code.
`install.sh --hooks` prints a pointer to `tiller apply`.

## Probe and capabilities

The probe records `platform`, the POSIX shell (on Windows: Git Bash's `bash.exe`), versions of
`node`, `git`, `gh`, `jq`, `timeout` (also as `gtimeout`), and each agent's binary and config
directory, honouring `CLAUDE_CONFIG_DIR` and `COPILOT_HOME`. Platform and `PATH` are injectable for
tests.

Each feature declares its requirements:

| Feature | Requires |
|---|---|
| Skills | an agent with a skills directory |
| Harness role agents | Claude Code or Copilot CLI |
| Private-access hook | an agent whose PreToolUse hook can deny, plus a POSIX shell, plus `jq` |
| Profile resolution in skills | a POSIX shell |
| Unattended runs | Claude Code, POSIX shell, `timeout`, `gh` |
| Pull requests | `gh` |

A missing requirement prints which features it disables and the install command for the probed
OS (brew, apt, winget). The command is printed, never run.

## Layers

Desired state is agent-neutral and resolved in order, later wins:

1. `config/harness/base.json`: tracked, carries no project, company or personal fact.
2. `personal/<user>/harness.json` and `personal/<user>/instructions.md`.
3. `~/.tiller/machine.json`: paths and machine-only values.

```json
{
  "env": { "TILLER_HOME": "${TILLER_HOME}" },
  "hooks": [
    { "id": "private-access", "event": "preToolUse", "kinds": ["read", "search", "write", "shell"],
      "command": "${TILLER_HOME}/lib/hooks/private-access.sh" }
  ],
  "agents": ["flow-resolver", "flow-owner-proxy", "flow-pm"],
  "instructions": { "file": "instructions.md" },
  "native": { "claude": { "...": "pass-through keys for one agent only" } }
}
```

`native.<agent>` carries settings that have no neutral form (sandbox, status line, Claude
permissions) and is merged into that agent's settings file only. Profiles do not contribute global
settings; a profile's skills and agents are still linked by `install.sh --profile`.
`TILLER_PROFILES_ROOT` points at `personal/<user>/profiles/` when the personal repo carries profiles.

## Adapters

| Target | Claude Code | Copilot CLI |
|---|---|---|
| Config dir | `~/.claude` or `CLAUDE_CONFIG_DIR` | `~/.copilot` or `COPILOT_HOME` |
| Skills | `<dir>/skills/<name>` | `~/.agents/skills/<name>` |
| Agents | `<dir>/agents/<name>.md` | `<dir>/agents/<name>.agent.md` |
| Role tools | rendered by `lib/agents/install-agents.mjs` | same roles, Copilot tool names |
| Hooks | merged into `settings.json` `hooks` | own file `<dir>/hooks/tiller.json`, nothing merged |
| Env | merged into `settings.json` `env` | per-hook `env` map; shell-profile line printed |
| Instructions | marker block in `<dir>/CLAUDE.md` | marker block in `<dir>/copilot-instructions.md` |
| Native settings | `settings.json` | `settings.json` (JSON with comments) |

Copilot hooks use PascalCase event names so the payload matches the Claude format that
`private-access.sh` already reads. That compatibility is verified by a test before the adapter
ships; if it fails, the adapter translates the payload.

`files` writes skills to a directory the user names and the instructions block to a file the user
names; it integrates nothing else.

## Apply

1. Resolve layers, expand variables, render each agent's targets.
2. Read each native file. Invalid JSON stops the apply with no write. Copilot files are parsed with
   comments allowed; comments outside owned keys survive.
3. Compare every owned key with the hash recorded in `owned.json`. A mismatch is drift: the user
   chooses to adopt the current value into the personal layer, overwrite it, or release the key.
   Without a terminal, drift refuses the apply.
4. Show the diff. Write on consent, or with `--yes`. Without a terminal and without `--yes`, refuse.
5. Back up each file to be changed, write to a temporary file, rename over the original.
6. Record each written key as a JSON pointer plus value hash. A Claude hook entry has no id field,
   so tiller's command starts with `TILLER_HOOK=<id> ` and the manifest records the entry by that
   prefix; Copilot hooks live in tiller's own file. User hooks in the same array are untouched.

A second apply with unchanged state writes nothing. `uninstall` removes owned keys, the marker
block, links and copies recorded in the manifest, and nothing else.

Instruction blocks are delimited by `<!-- tiller:begin -->` and `<!-- tiller:end -->`; text outside
them is never read or written. An edited block is drift, handled as above.

## Linking

| OS | Skill directories | Agent files |
|---|---|---|
| macOS, Linux | symlink | symlink |
| Windows | junction (no admin rights needed) | copy, hash recorded; re-apply refreshes a copy whose source changed |

An existing path that is not tiller's is skipped and reported, as `install.sh` does today.

## Windows

Paths are built with `path` and `os.homedir()`. Hook commands that run a shell script name
`bash.exe` explicitly. Copilot hook entries fill both `bash` and `powershell` keys, the PowerShell
one invoking Git Bash. Without Git Bash, the private-access hook and profile resolution are reported
unavailable.

## Personal repo

```
personal/<user>/
  harness.json        personal layer
  instructions.md     body of the managed instructions block, shared by every agent
  skills/             personal skills (existing mechanism)
  profiles/           optional: this person's project profiles
  leak-terms.txt      existing mechanism
```

`onboard --personal <url>` clones into `personal/<user>/` when absent and pulls when present. It
never pushes. Secrets stay out of every repo; onboard lists each `profiles/*/secrets.env` that a
profile expects and this machine lacks.

## Leak guard

`config/harness/base.json`, `lib/adapters/*` and `lib/apply/*` are scanned like every tracked
file. A test asserts that rendering with an empty personal layer produces no instructions text
beyond the tracked block header.

## Testing

`node:test`, no npm dependencies, every test on a synthetic `HOME`:

- probe with injected platform and `PATH` for darwin, linux, win32;
- golden rendered files per adapter;
- apply: idempotence, drift (each of the three resolutions), user keys and user hooks untouched,
  invalid JSON refused, comments preserved, interrupted write leaves the original;
- uninstall restores the pre-apply file byte for byte when no user edits happened in between;
- linking per OS, including skip of a foreign path;
- Copilot PascalCase payload accepted by `private-access.sh`.

CI runs the suite on macOS, Ubuntu and Windows.

## Delivery order

Each step ships on its own:

1. Probe and `doctor` (read-only).
2. Layers, manifest, merge and the Claude adapter; replaces the hand merge of `--hooks` and
   `TILLER_HOME`.
3. Copilot adapter.
4. `onboard --personal`, `status`, `uninstall`.
5. Windows linking and Git Bash handling.
6. `apply --adopt`, then moving an existing setup into a personal layer.

## Out of scope

- Unattended runs on Copilot CLI; the Workflow script and `claude -p` lanes stay Claude-only.
- Agent memory transfer.
- The hard-coded `~/.claude/run-state` root.
- Copilot in VS Code and the Copilot coding agent.
- Installing tools through a package manager.
