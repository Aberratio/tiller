# Harness Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development, executed inline
> (the owner chose test-first, one delivery step at a time). Steps use checkbox (`- [ ]`) syntax.

**Goal:** One Node command (`tiller`) that probes a machine, reports what the harness can do on it,
and applies layered global agent settings by owned-key merge, starting with Claude Code.

**Architecture:** `lib/machine/` probes and judges capabilities; `lib/apply/` resolves layers,
keeps the ownership manifest and performs the merge; `lib/adapters/<agent>.mjs` turns the neutral
desired state into per-file operations. `bin/tiller.mjs` wires them. Library functions take `home`,
`env`, `platform` and `stateHome` explicitly; only `bin/tiller.mjs` reads `process.env`/`os`.

**Tech Stack:** Node >= 22 (local: 24), ES modules, `node:test`, zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-harness-onboarding-design.md`

## Global Constraints

- Node, no npm dependencies; tests are `*.test.mjs` on `node:test` + `node:assert/strict`.
- Every test runs on a synthetic `HOME` (`mkdtempSync`); `CLAUDE_CONFIG_DIR`, `COPILOT_HOME`,
  `TILLER_STATE_HOME`, `USERPROFILE` are set or deleted explicitly in every spawned env.
  `tiller apply` is never run against the real home in this session.
- `install.sh` behaviour is unchanged except `--hooks` (Task 2.6); `lib/install/tests` and
  `lib/agents/tests` run green after every step.
- Tool installation is printed, never run (brew, apt, winget).
- Instruction blocks: `<!-- tiller:begin -->` … `<!-- tiller:end -->`; nothing outside is read or written.
- State: `~/.tiller/` (override `TILLER_STATE_HOME`): `machine.json`, `owned.json`, `backups/<timestamp>/`.
- Claude hook entries carry `TILLER_HOOK=<id> ` as the command prefix; the manifest keys them by it.
- `config/harness/base.json`, `lib/adapters/*`, `lib/apply/*` carry no project, company or person name.
- Commits: single-line Conventional Commits, no trailers; `lib/leak-guard.sh` before each, plus a
  manual name check (no local leak-terms list in this worktree).
- Comments only for a non-obvious why, one or two sentences.

## Test command (used by every task)

```bash
node --test lib/machine/tests lib/apply/tests lib/adapters/tests lib/tests/tiller-cli.test.mjs
node --test lib/install/tests lib/agents/tests   # regression, after every step
```

## Review Focus

1. **Paths with spaces.** The real `TILLER_HOME` contains a space. The hook command must be
   shell-quoted; a test runs the rendered command through `sh -c` with a spaced `TILLER_HOME` (2.4).
2. **`settings.json` that is a symlink** (dotfiles repos). Rename-over must write the link's target,
   not replace the link with a file (2.3).
3. **An existing user value at a key tiller is about to own for the first time.** Equal value:
   take ownership silently, no write. Different value: treated as drift (adopt/overwrite/release),
   never overwritten silently (2.3).
4. **A legacy hand-merged private-access hook** (`TILLER_HOME=… private-access.sh`, from today's
   `install.sh --hooks`). It is a user hook, so untouched, but apply warns that the hook will run
   twice until it is removed (2.4).
5. **Windows impostors on PATH.** `C:\Windows\System32\bash.exe` is WSL, not Git Bash, and
   `System32\timeout.exe` is not coreutils `timeout`; the probe ignores both (1.1).

---

## Step 1 — Probe and `doctor` (read-only)

### Task 1.1: `lib/machine/probe.mjs`

**Files:** Create `lib/machine/probe.mjs`, `lib/machine/tests/probe.test.mjs`

**Interfaces — Produces:**
```js
// All inputs injectable; defaults only in bin/tiller.mjs.
probe({ platform, env, home, exists = existsSync, run = defaultRun }) => {
  platform,                                   // 'darwin' | 'linux' | 'win32'
  shell: { path, kind } | null,               // kind: 'bash' | 'sh' | 'git-bash'
  tools: { node, git, gh, jq, timeout }:      // each { path, version } | null; timeout may be gtimeout
  agents: { claude: { bin, configDir, configDirExists }, copilot: { … } }  // bin null when absent
}
which(name, { platform, env, exists }) => string | null   // PATH scan; PATHEXT on win32
```
`run(bin, args) => { status, stdout }`; versions come from `--version` and the first
`\d+\.\d+(\.\d+)?` match. Config dirs: `env.CLAUDE_CONFIG_DIR || join(home, '.claude')`,
`env.COPILOT_HOME || join(home, '.copilot')`. Agent binaries: `claude`, `copilot`. `path` functions
are chosen per platform (`path.win32` for `win32`) so a win32 probe is testable on macOS.

- [ ] **Step 1: failing tests** — one per case, fake `PATH` dirs with stub files, `run` injected:
  - darwin: `jq` absent, `gtimeout` present → `tools.timeout.path` ends in `gtimeout`, `jq === null`.
  - linux: everything present → versions parsed from stub output (`jq-1.7.1` → `1.7.1`).
  - win32: PATH `C:\Windows\System32;C:\Program Files\Git\usr\bin`, `PATHEXT=.EXE;.CMD`, both dirs
    holding `bash.exe` and `timeout.exe` → shell is the Git one (`kind: 'git-bash'`), timeout is the
    Git one; with only System32 → `shell === null`, `timeout === null`.
  - `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` honoured; default dirs under the injected `home`.
  - `run` throwing or exiting non-zero → tool reported with `version: null`, probe does not throw.
- [ ] **Step 2:** run, expect FAIL (module missing).
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run, expect PASS.
- [ ] **Step 5:** commit `feat(machine): probe platform, shell, tools and agents with injectable PATH`.

### Task 1.2: `lib/machine/capabilities.mjs`

**Files:** Create `lib/machine/capabilities.mjs`, `lib/machine/tests/capabilities.test.mjs`

**Interfaces — Consumes:** probe result. **Produces:**
```js
FEATURES   // [{ id, label, requires: [...] }] — the spec's table, in its order
capabilities(probeResult) => [{ id, label, status: 'ready'|'degraded'|'unavailable',
                                reason: string|null, missing: [tool], install: [string] }]
installCommand(tool, platform) => string
```
Requirement semantics: `agent:skills` (claude or copilot present; `files` fallback otherwise →
degraded), `agent:any-of(claude,copilot)`, `agent:deny-hook` (claude, copilot), `agent:claude`,
`shell`, `tool:<name>`. **Degraded** = an agent-scoped requirement holds for some detected agents
but not all, or only the `files` fallback applies; the reason names the agent. **Unavailable** = a
requirement fails outright; `install` lists the command for every missing tool on this platform.
Install table: brew / apt / winget per tool (node, git, gh, jq, timeout→coreutils, Git Bash on
win32, claude, copilot). The Claude Code and Copilot CLI install commands and every winget id are
verified against their official docs during this task (WebFetch), not written from memory; the
source URLs are listed in the step report, not in the code.

- [ ] **Step 1: failing tests:**
  - full darwin probe → every feature `ready`.
  - no `jq` → private-access hook `unavailable`, `install` = `['brew install jq']`; on linux `apt`;
    on win32 `winget install …`.
  - win32 without Git Bash → private-access hook and profile resolution `unavailable`, reason names
    Git Bash; skills still `ready`.
  - only copilot detected → unattended runs `unavailable` (needs Claude Code), role agents `ready`.
  - no agent at all → skills `degraded` (files fallback), role agents `unavailable`.
  - no `gh` → pull requests and unattended runs both list `gh`; one missing tool reported once.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit `feat(machine): judge each feature ready, degraded or unavailable`.

### Task 1.3: `bin/tiller.mjs doctor` and shims

**Files:** Create `bin/tiller.mjs`, `bin/tiller` (POSIX sh: `exec node "$(dirname "$0")/tiller.mjs" "$@"`,
resolving symlinks), `bin/tiller.cmd` (`@node "%~dp0tiller.mjs" %*`), `lib/tests/tiller-cli.test.mjs`.

**Interfaces — Produces:** `main(argv, { env, platform, home, stdout, stderr, stdin, isTTY }) => exitCode`
(exported for in-process tests; the file runs it when executed). Exit codes: 0 done, 2 usage,
3 refused, 4 failed. `doctor [--json]`: one line per feature
`ready      Skills` / `degraded   … — <reason>` / `unavailable … — needs jq: brew install jq`.
`onboard`, `status`, `uninstall` exit 2 with "not available yet".

- [ ] **Step 1: failing tests** (spawn `node bin/tiller.mjs` with synthetic env and stub PATH):
  - `doctor` lists every feature in table order, exit 0, writes nothing under the synthetic HOME
    or state dir (directory listing before == after).
  - `doctor --json` parses and has `probe` and `features`.
  - unknown command → exit 2 with usage on stderr.
  - `bin/tiller doctor` via `sh` works from a symlinked location.
- [ ] **Step 2–4:** red, implement, green; run regression suites.
- [ ] **Step 5:** leak-guard, commit `feat(tiller): add the doctor command and shell shims`.

---

## Step 2 — Layers, manifest, merge, Claude adapter

### Task 2.1: tracked layers

**Files:** Create `config/harness/base.json` (exactly the spec's example minus `native`),
`personal/_templates/harness.json` (`{ "native": { "claude": {} } }` plus a `$comment`), and a line
in `personal/_templates/README.md` on `harness.json` and `instructions.md`.

Folded into Task 2.2's commit.

### Task 2.2: `lib/apply/layers.mjs`

**Files:** Create `lib/apply/layers.mjs`, `lib/apply/tests/layers.test.mjs`

**Interfaces — Produces:**
```js
readLayers({ tillerHome, personalDir /* or null */, stateHome }) => [{ name, dir, data }]
resolve(layers, { vars: { TILLER_HOME, HOME } }) => desired
// desired: { env, hooks: [{id, event, kinds, command}], agents: [], instructions: { body }, native: {agent: {}} }
```
Merge rules, later layer wins: plain objects merge deeply; arrays of objects with `id` merge by
`id` (an entry `{ "id": x, "remove": true }` drops it); other arrays are replaced; `null` deletes
the key. Only `${TILLER_HOME}` and `${HOME}` are expanded, in strings, after merging; any other
`${…}` is left verbatim (a status-line command may use shell variables). `instructions.file` is
read relative to the layer that names it; a missing file in the personal layer is an empty body.
`machine.json` contributes its layer keys; its `probe` key is ignored.

- [ ] **Step 1: failing tests:** base only; personal overrides an `env` key and adds a `native.claude`
  key; hook merged by `id`, removed by `remove`; `null` deletes; `${TILLER_HOME}` with a space
  expanded, `${PWD}` kept; personal `instructions.md` body loaded; missing personal dir = base only;
  invalid JSON in any layer throws naming the file.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit `feat(apply): resolve base, personal and machine layers`.

### Task 2.3: `lib/apply/manifest.mjs` and `lib/apply/merge.mjs`

**Files:** Create both plus `lib/apply/tests/manifest.test.mjs`, `lib/apply/tests/merge.test.mjs`.

**Interfaces — Produces:**
```js
// manifest.mjs — ~/.tiller/owned.json
loadManifest(stateHome) => { version: 1, files: { [absPath]: FileEntry }, released: { [absPath]: [itemId] } }
saveManifest(stateHome, m)            // atomic
// FileEntry: { agent, kind: 'json'|'block', items: { [itemId]: hash }, writtenHash, backup }
// itemId: JSON pointer ("/env/TILLER_HOME"), "hook:<event>:<id>", or "block"
hashValue(v) => sha256 of canonical JSON (sorted keys)

// merge.mjs
plan(target, current, fileEntry, released) => { changes: [Change], drift: [Drift], next }
//   target: { path, kind: 'json', items: [{ id, pointer?|hook?, value }] } | { path, kind: 'block', body }
//   current: file text or null; JSON parse error → throws InvalidNativeFile (no write anywhere)
//   Change: { id, op: 'set'|'remove'|'own', before, after }   'own' = equal unowned value, no write
//   Drift:  { id, reason: 'edited'|'unowned-differs', current, desired }
resolveDrift(planResult, choices /* {id: 'adopt'|'overwrite'|'release'} */) => planResult
writeAtomic(path, text, { backupDir, fs = nodeFs })   // realpath first; tmp + rename; backup before
```
Rules: an owned item whose current hash ≠ recorded hash is drift `edited`; an unowned item present
with a different value is drift `unowned-differs`; an owned item no longer desired is removed when
its hash still matches. Released items are skipped forever until removed from `released`. JSON is
written with the original file's indent (detected) and trailing newline. A plan with no `set` or
`remove` writes nothing, creates no backup and leaves the manifest bytes unchanged.
`adopt` returns the current value for the caller to write into the personal layer (done in 2.5).

- [ ] **Step 1: failing tests:**
  - first apply sets keys; user keys in the same object untouched (deep-equal on the rest).
  - second plan on the written file → no changes (idempotence).
  - `edited` drift for each resolution: overwrite → set; release → item leaves `items`, enters
    `released`, next plan ignores it; adopt → returns current value, item re-owned at that hash.
  - `unowned-differs` raised, never a silent set; equal unowned value → `own`, no write.
  - invalid JSON → throws, file bytes unchanged.
  - `writeAtomic` with an injected `fs.renameSync` that throws → original bytes intact, no tmp left.
  - `writeAtomic` on a symlink → link still a link, target file updated.
  - 4-space-indented original → written with 4 spaces.
  - manifest round-trip; `released` survives.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit `feat(apply): owned-key merge with drift detection, manifest and atomic write`.

### Task 2.4: `lib/adapters/claude.mjs` (settings and instructions)

**Files:** Create `lib/adapters/claude.mjs`, `lib/adapters/tests/claude.test.mjs`,
`lib/adapters/tests/golden/claude/settings.json`, `…/CLAUDE.md`.

**Interfaces — Consumes:** `desired` (2.2). **Produces:**
```js
claudeTargets(desired, { configDir, tillerHome }) => [JsonTarget, BlockTarget]
BLOCK_HEADER   // the one tracked line inside every managed block
legacyHooks(settingsJson) => [command]   // hand-merged private-access entries without TILLER_HOOK=
```
Mapping: `env.X` → pointer `/env/X`. Hook `{id, event: 'preToolUse', kinds, command}` → item
`hook:PreToolUse:<id>` with value
`{ matcher: kinds→"Read|Grep|Glob|Edit|Write|NotebookEdit|Bash", hooks: [{ type: 'command', command: 'TILLER_HOOK=<id> ' + shQuote(command) }] }`,
kinds table `{ read: [Read], search: [Grep, Glob], write: [Edit, Write, NotebookEdit], shell: [Bash] }`.
Merge places it as its own group in `hooks.PreToolUse`, found again by the command prefix; other
groups are untouched. `native.claude` → one item per leaf pointer (a leaf is any non-plain-object).
Instructions → block target on `<configDir>/CLAUDE.md`, body = `BLOCK_HEADER + '\n' + personal body`.
Block handling lives in merge (kind `block`): absent markers → append after one blank line (file
created if missing); more than one begin, or begin without end → refused as malformed; the file's
line ending is kept.

- [ ] **Step 1: failing tests:**
  - golden: base + fixture personal layer → rendered `settings.json` and `CLAUDE.md` equal the golden
    files after `${TILLER_HOME}` is replaced by a fixed path.
  - hook command run through `sh -c` with a spaced `TILLER_HOME` and a Read payload on a non-protected
    path → exit 0, hook ran (stub `TILLER_HOOK` echo is not needed: assert no "not found" in stderr).
  - user hook in `PreToolUse` and a user `env` key survive apply, byte-identical in their JSON.
  - empty personal layer → the block contains only `BLOCK_HEADER` (leak-guard test from the spec).
  - text outside the markers unchanged byte for byte, CRLF file stays CRLF.
  - malformed markers → refused, no write.
  - `legacyHooks` finds a `TILLER_HOME=… private-access.sh` command.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5:** commit `feat(adapters): render Claude Code settings and instructions block`.

### Task 2.5: `tiller apply` (Claude only)

**Files:** Modify `bin/tiller.mjs`; create `lib/apply/apply.mjs`; extend `lib/tests/tiller-cli.test.mjs`.

**Interfaces — Produces:**
```js
runApply({ tillerHome, home, env, stateHome, personalDir, agents, yes, dryRun, isTTY, prompt, out })
  => { status: 'written'|'unchanged'|'dry-run'|'refused', reason?, files: [path] }
```
Flags: `--yes`, `--dry-run`, `--agents claude` (default: every detected agent the adapter supports;
copilot → "not supported yet", step 3), `--user <name>` (personal dir
`${TILLER_PERSONAL_ROOT:-$TILLER_HOME/personal}/<user>`; else `machine.json.user`; else none).
Order: resolve → plan every file (any invalid JSON → refuse before any write) → print diff
(per item: `+ /env/TILLER_HOME = "…"`, `~`, `-`) and legacy-hook warning → drift: interactive
`[a]dopt / [o]verwrite / [r]elease` per item, without a TTY refuse (exit 3) → consent unless `--yes`;
no TTY and no `--yes` → refuse → write with backups into `backups/<ISO timestamp>/` → save manifest
→ write `machine.json` (`probe` refreshed, other keys kept). Adopt writes the value into
`personal/<user>/harness.json` (`native.claude` pointer or `env`); without a personal dir adopt is
not offered. `--dry-run` prints and writes nothing, not even `machine.json`.

- [ ] **Step 1: failing tests** (spawned CLI, synthetic HOME + state + personal root):
  - `apply --yes` on an empty config dir creates `settings.json` and `CLAUDE.md`, manifest records
    `/env/TILLER_HOME`, `hook:PreToolUse:private-access`, `block`; backup dir created only for files
    that existed.
  - second `apply --yes` → "unchanged", no new backup dir, manifest bytes unchanged, file mtimes unchanged.
  - no TTY, no `--yes` → exit 3, nothing written.
  - edited owned key, no TTY → exit 3 naming the pointer; in-process with `prompt` injected:
    each of adopt/overwrite/release yields the expected file, manifest and personal layer.
  - invalid `settings.json` → exit 3, `CLAUDE.md` not written either.
  - `--dry-run` → diff printed, state dir still empty.
  - real-home guard: every spawn asserts `env.HOME !== os.homedir()` before running.
- [ ] **Step 2–4:** red, implement, green; regression suites.
- [ ] **Step 5:** commit `feat(tiller): apply layered desired state to Claude Code`.

### Task 2.6: `install.sh --hooks` points at `tiller apply`

**Files:** Modify `install.sh:83-89` and its header line 14; modify
`lib/install/tests/install.test.mjs:114-…`.

Per the spec, `--hooks` prints a pointer (`Run: bin/tiller apply` with one line on what it merges) and
exits 0; it changes no file. The existing test that asserts the printed fragment is rewritten to
assert the pointer and that no file changed. **This is the one intended change to existing
`install.sh` behaviour — see the open question.**

- [ ] **Step 1:** rewrite the test, run, expect FAIL.
- [ ] **Step 2:** change `install.sh`, run both regression suites, expect PASS.
- [ ] **Step 3:** leak-guard, commit `feat(install): point --hooks at tiller apply`.

---

## Steps 3–6 (later sessions; one task group each)

- **Step 3 — Copilot adapter.** First task: the PascalCase payload test against
  `private-access.sh` (spec fallback: translate the payload if it fails). Then `lib/adapters/copilot.mjs`:
  hooks in `<dir>/hooks/tiller.json` (own file, whole-file ownership), per-hook `env`, block in
  `copilot-instructions.md`, `settings.json` parsed with comments and comments outside owned keys
  kept. Copilot facts re-verified against docs.github.com.
- **Step 4 — `onboard --personal`, `status`, `uninstall`:** detailed below.
- **Step 5 — Windows:** detailed below.
- **Step 6 — `apply --adopt <agent>`**, then moving an existing setup into a personal layer.

## Step 4 — links, rendered agents, `status`, `uninstall`, `onboard`

Copilot facts for this step (docs.github.com, 2026-10-14):
custom-agents-configuration (only `description` required; `tools` as a YAML list; aliases
`execute`/`read`/`edit`/`search`/`web`, case-insensitive, Claude names accepted; MCP tools
`<server>/<tool>`; unknown tool names ignored; body = instructions, max 30,000 characters);
create-custom-agents-for-cli (user agents in `~/.copilot/agents/`, id = file name without
`.agent.md`); add-skills (personal skills in `~/.copilot/skills` or `~/.agents/skills`, `SKILL.md`
with `name` + `description`); hooks-reference (`timeoutSec` default 30, no documented maximum,
timeout = continue). Symlinked skill dirs or agent files: not documented.

Manifest gains `links: { [dest]: { agent, kind: 'skill'|'agent', mode: 'symlink'|'rendered', source?, hash? } }`.
Links and rendered agents follow the apply flow: shown in the diff, written on consent or `--yes`,
nothing in `--dry-run`. A foreign path is skipped and reported, never replaced.

### Task 4.1: `lib/apply/link.mjs` (POSIX)

`planLink({ dest, source }, current, entry)` → `create | ok | skip-foreign | refresh` (refresh: our
symlink pointing at a source that moved); `link(dest, source)`; `unlink(dest, source)` removes only a
symlink whose target is still `source`. `win32` throws "step 5". Tests: create, idempotent ok, foreign
file and foreign symlink skipped, dangling own link refreshed, unlink leaves a foreign path.
Commit `feat(apply): link skills by symlink, never replacing a foreign path`.

### Task 4.2: skills and role agents in the adapters

Desired skills = every `skills/*/SKILL.md` plus every `personal/<user>/skills/*/SKILL.md` (personal
wins on a name clash). Desired role agents = `desired.agents`. Claude: skill links in
`<dir>/skills/<name>`; role agents rendered by `install-agents.mjs`'s `renderAgentFile` into
`<dir>/agents/<name>.md` (mode `rendered`, hash recorded). Copilot: skill links in
`~/.agents/skills/<name>`; role agents rendered into `<dir>/agents/<name>.agent.md` with frontmatter
`name`, `description`, `tools` (YAML list: shell→`execute`, read→`read`, search→`search`, web→`web`,
MCP → `<server>/<tool>` with the logical server name), `model` only when the role sets one; body as
for Claude; render refuses a body over 30,000 characters. **Decision 6 folded here:** the Copilot hook
entry gets `timeoutSec: 120` (golden updated). Tests: goldens for both agent files, skill target
lists, clash rule, the timeout in the hooks golden.
Commit `feat(adapters): render skill links and role agents for Claude Code and Copilot CLI`.

### Task 4.3: apply links and rendered agents

`runApply` plans links next to files. Rendered agent: absent → write; our hash → refresh when the
render changed; edited (hash ≠ recorded) → drift with overwrite/release (no adopt); foreign file →
skip. A desired link that disappeared (skill deleted) and is still ours → removed. First-contact rule
(decision 8) does not apply to links: a foreign path is always skipped. Tests (CLI, synthetic HOME):
first apply links every skill and writes three agents per agent; second apply unchanged; foreign skill
dir reported and untouched; edited agent file without a terminal refuses; `--dry-run` writes none.
Commit `feat(apply): link skills and write role agents per agent`.

### Task 4.4: `tiller status [--json]`

Read-only. Per manifest file: each owned item `ok | drifted | missing`, released items; per link
`ok | missing | foreign | stale`. Exit 0 always (it reports). Tests: clean after apply; edited key shows
`drifted`; removed link shows `missing`; writes nothing.
Commit `feat(tiller): add the status command`.

### Task 4.5: `tiller uninstall [--agents ...] [--yes] [--dry-run]`

Per manifest file of the chosen agents: file hash = `writtenHash` and no released items → `created`
deletes the file, else restore `backup` byte for byte; otherwise surgical: remove each owned item whose
hash still matches, keep and report edited ones, remove the block. Links: unlink ours; rendered agents
deleted when hash matches. Same consent rules as apply; backups of what it changes; manifest entries
dropped. Tests: byte-for-byte restore of a pre-existing file; created file removed; user edit in
between → surgical, user edit kept; foreign path untouched; second uninstall is a no-op; `--agents
copilot` leaves Claude's entries.
Commit `feat(tiller): add uninstall driven by the ownership manifest`.

### Task 4.6: `tiller onboard [--personal <git-url>] [--user <name>] [--agents ...] [--yes]`

Doctor output; then with `--personal`: `git clone <url> personal/<user>` when absent, `git -C … pull
--ff-only` when present, never push; `--user` required unless `machine.json.user` is set, and stored
there. Then apply (same flags). Then list every `profiles/*/` (tiller's and the personal repo's) with
`profile.md` but no `secrets.env`. Tests use a local bare repo as the URL (no network): clone, pull on
second run, missing user refused, secrets listing, apply refusal propagates exit 3.
Commit `feat(tiller): add onboard with a private personal repo`.

### Task 4.7: `install.sh` calls the same link code

`link_skill` and the profile-agent loop call `node lib/apply/link.mjs` (a small CLI on 4.1) with the
same `ok:/skipped:/linked:` lines; no manifest entry (install.sh keeps no ownership). `lib/install/tests`
unchanged and green. Commit `refactor(install): link through lib/apply/link.mjs`.

### Step-4 interpretations (for approval)

1. Skills linked by apply = all tracked skills plus the personal ones; profile skills and agents stay
   with `install.sh --profile`, as the spec says.
2. Role agents are rendered files, not links, on macOS/Linux too (they are generated from
   `SKILL.md` + `config/agents.json`); the spec's "symlink" row covers skill dirs and profile agents.
3. Copilot MCP tool names use the logical server name (`atlassian/getJiraIssue`); a user whose Copilot
   server is named otherwise gets the tool ignored (documented behaviour), not an error.
4. `timeoutSec: 120` for decision 6 (default 30; no documented maximum).
5. A missing `secrets.env` = a profile directory with `profile.md` and without `secrets.env`.

## Step 5 — Windows

Copilot facts for this step (docs.github.com, 2026-10-14):
hooks-reference (`bash` = "Shell command for Unix", `powershell` = "Shell command for Windows"; one of
`bash`/`powershell`/`command` required; `command` is copied to both when they are absent, an explicit
key wins on its platform; what runs when only the other OS's key is present: not documented; user hooks
in `%USERPROFILE%\.copilot\hooks\` or `$COPILOT_HOME/hooks/`; which PowerShell binary runs the
`powershell` key: not documented); use-hooks ("Copilot uses the appropriate key based on the user's
operating system"; Windows hooks "require ... PowerShell 7.0 or later installed and in your PATH",
checked with `pwsh --version`); cli-config-dir-reference (`~/.copilot` = `$HOME/.copilot`, Windows
example `C:\Users\YOUR-USER\.copilot\...`; `COPILOT_HOME` replaces the whole path; the shell tool
prefers `pwsh` and falls back to `powershell.exe`, which is said of the shell tool, not of hooks;
junctions not mentioned); add-skills (`~/.copilot/skills` or `~/.agents/skills`, no Windows path form,
no word on symlinks or junctions).
Claude Code fact used (code.claude.com/docs/en/hooks, 2026-10-14): a shell-form command hook runs in
Git Bash on Windows, or PowerShell when Git Bash is not installed; the `shell` field picks explicitly.

Windows behaviour is tested on macOS through an injected `platform`, injected fs operations and an
injected probe result; nothing in this step runs on Windows until CI has a remote (Task 5.7).
`fs.symlinkSync(target, path, 'junction')` ignores the type off Windows, so a "win32" link test on
macOS makes a real symlink and a spy asserts the `'junction'` argument.

Manifest `links[dest].mode` gains `junction` (`source`, as `symlink`) and `copy` (`source`, `hash` of
the copied bytes).

### Task 5.1: home and Git Bash on win32

`bin/tiller.mjs` gets `homeOf(env, platform)` (exported for tests): win32 → `USERPROFILE ||
os.homedir()`, ignoring a `HOME` that Git Bash or MSYS tools set; elsewhere unchanged
(`HOME || USERPROFILE || homedir()`). `probe` records `shell.path` as found (already) and adds
`shell.posixPath`: the same path with `\` → `/` (`C:/Program Files/Git/bin/bash.exe`), used by the
adapters. Tests (`probe.test.mjs`, unit on `homeOf`): win32 with `HOME=/c/Users/x` and
`USERPROFILE=C:\Users\x` → `C:\Users\x`; darwin unchanged; Git Bash from `ProgramFiles` fallback gets
the forward-slash form; System32 impostor still ignored.
Commit `feat(machine): resolve the Windows home from USERPROFILE and record Git Bash's path`.

### Task 5.2: `lib/apply/link.mjs` on Windows (junction, copy)

`link(dest, source, { platform, fs })`: win32 + directory source → `fs.symlinkSync(source, dest,
'junction')`; win32 + file source → `fs.copyFileSync`, returns `{ mode: 'copy', hash }`; POSIX
unchanged. `fs` defaults to `node:fs` and is injected in tests. `sameTarget(a, b, platform)`: on win32
strips `\\?\` and `\??\`, trailing separators, compares `path.win32.resolve` case-insensitively; POSIX
is string equality. `planLink` uses it, so a junction reported as a symlink by `lstat` (Node does) is
`ok`/`refresh` as on POSIX. `planCopy({ source }, dest, entry)` → `create | ok | refresh | drift |
skip-foreign`: absent → create; dest hash = entry hash and source hash ≠ → refresh; dest hash ≠ entry
hash → drift; no entry → skip-foreign unless bytes equal the source (then `ok`, taken over).
`unlink` removes a junction (`fs.unlinkSync`; Node removes directory reparse points) or a copy whose
hash still matches. The "step 5" throw goes. Tests (`link.test.mjs`, synthetic dirs): win32 dir →
spy sees `'junction'` and the link resolves; win32 file → copy with hash; `sameTarget` table (prefix,
trailing `\`, case); copy create/ok/refresh/drift/foreign; unlink leaves an edited copy and a foreign
junction; POSIX tests unchanged.
Commit `feat(apply): link by junction and copy with a hash on Windows`.

### Task 5.3: apply, status and uninstall use junctions on Windows

`planLinks` drops the `unsupported` action and its note; on win32 a skill link is planned and
recorded with `mode: 'junction'`. `planGone`, `linkState` and uninstall's `planLinkGone` treat
`junction` like `symlink` (through `sameTarget`) and `copy` by hash (`ok | drifted | stale` when the
source changed or vanished). `runApply` and `runUninstall` accept an injected `probeMachine` (default
`probe`), since a win32 probe of a POSIX temp dir finds no `bash.exe`. Tests (library calls of
`runApply`/`runStatus`/`runUninstall` with `platform: 'win32'`, synthetic HOME, both env vars set or
deleted): first apply records junctions for every skill and `rendered` agents as before; second apply
unchanged; foreign skill dir skipped; status `ok`, then `missing` after removal; uninstall removes
the junctions and leaves a foreign one.
Commit `feat(apply): apply, report and uninstall skill junctions on Windows`.

### Task 5.4: `install.sh` profile agents copied on Windows

The `node lib/apply/link.mjs <source> <dest>` CLI uses 5.2 on win32: skill dirs → junction, profile
agent files → copy. Each copy is recorded in the manifest as `{ agent: 'claude', kind: 'agent',
mode: 'copy', source, hash, origin: 'install' }` (decision 1): `tiller apply` never plans it as gone,
`uninstall` leaves it alone (as it does install.sh's symlinks), `status` lists it with an `install`
tag and its `ok | drifted | stale` state. New CLI output `refreshed` for a copy whose source changed; install.sh prints
`refreshed: agent <name>`. Tests (`link.test.mjs`, spawning the CLI with `TILLER_STATE_HOME` set and
the platform injected through an exported `main(argv, { platform, fs, stateHome })`): copy, ok on
rerun, refresh after a source edit, skipped after a dest edit; library `runApply` and `runUninstall`
leave an `origin: 'install'` entry and its file untouched; `runStatus` reports it;
`lib/install/tests` unchanged and green.
Commit `feat(install): copy profile agents on Windows and refresh them when the source changes`.

### Task 5.5: hook commands name `bash.exe`; no Git Bash, no hook

Adapters take `{ platform, shell }` from the probe. Claude on win32:
`TILLER_HOOK=<id> '<shell.posixPath>' '<script, forward slashes>'` (Claude runs it in Git Bash, so the
prefix and quoting stay POSIX; the manifest prefix match is unchanged). Copilot `bash` key on win32
names `bash.exe` the same way. When `probe.shell` is null (win32 without Git Bash), `runApply` drops
every hook from the desired state and prints `private-access hook unavailable: needs Git Bash (winget
install Git.Git)`; an owned hook entry is then removed by the normal plan. Tests: Claude and Copilot
goldens for win32 with `tillerHome = 'C:\\tiller home'` and `shell.posixPath = 'C:/Program
Files/Git/bin/bash.exe'`; POSIX goldens unchanged; the POSIX command still runs through `sh -c` with a
spaced `TILLER_HOME`; library `runApply` on win32 with a no-shell probe writes no hook and removes a
previously owned one.
Commit `feat(adapters): run hook scripts through Git Bash on Windows and skip them without it`.

### Task 5.6: Copilot `powershell` key and Windows env lines

Every Copilot hook entry carries both keys on every OS (spec), so one hooks file works on either:
`bash` as today; `powershell` = `& '<bash.exe>' '<copilot-pretooluse.sh>' '<hook>'` with PowerShell
quoting (`'` → `''`), forward-slash paths, and `$LASTEXITCODE` passed on with `; exit
$LASTEXITCODE` so a non-zero wrapper exit stays a deny. On win32 `<bash.exe>` is `shell.posixPath`;
on darwin/linux it is `bash` (decision 3: both keys on every OS). `lib/hooks/copilot-pretooluse.sh` exits 1 on an empty stdin (a payload lost between PowerShell and
Git Bash must deny, not allow). `copilotEnvLines` on win32 prints
`[Environment]::SetEnvironmentVariable('K', 'v', 'User')` instead of `export`. Tests: hooks golden
with both keys per platform; the wrapper denies an empty payload (`lib/tests/private-access.test.mjs`);
a quoting test with `'` in `TILLER_HOME`; env-lines golden for win32;
when `pwsh` is on PATH (CI Windows only, `skip` elsewhere) the rendered `powershell` string runs a
stub hook and its exit code survives.
Commit `feat(adapters): fill the Copilot powershell hook key with a Git Bash call`.

### Task 5.8: `private-access.sh` judges Windows-form paths

On Windows the payload's `cwd` and paths arrive as `C:\Users\x\tiller\brains\b\f.md`; today `norm`
treats that as relative (`$cwd/C:\...`) and `names_protected`/`word_hit` only know `/`, so a protected
path is allowed (fail open). Change: a path or `cwd` matching `^[A-Za-z]:[\\/]` switches the call to
Windows mode, in which every path and the Bash command have `\` read as a separator, the drive letter
is upper-cased, and the result goes through `cygpath -u` (shipped with Git Bash) before `realpath`;
`names_protected` and the Bash scan accept `[\\/]` between `brains`/`profiles` and the name in that
mode. No `cygpath` in Windows mode → any call naming a protected root is denied. POSIX paths are
untouched (a `\` in a POSIX file name keeps its meaning). Files: `lib/hooks/private-access.sh`,
`lib/tests/private-access.test.mjs`, `lib/testing/private-access.mjs` (a stub `cygpath` on PATH that
maps `C:/` to the synthetic HOME's root, so the cases run on macOS; on the Windows CI job the real
`cygpath` is used and the stub is not installed). Tests, each against a none brain, a read brain and
another project's profile: `C:\...\brains\<b>\f.md` Read denied; `c:\...` (lower-case drive)
denied; mixed `C:/...\brains/<b>\f.md` denied; Windows-form `cwd` resolves the right profile (own
profile allowed, another denied); Grep/Glob with a Windows-form `path`; Bash `type
C:\...\brains\<b>\f.md` and `cat brains\<b>/f.md` denied; read brain + Windows-form Edit denied;
Windows-form path outside `TILLER_HOME` allowed; Windows mode without `cygpath` → protected denied,
unrelated allowed; every existing POSIX case unchanged. Not covered, noted for manual QA: segment
case on a case-insensitive filesystem (`...\BRAINS\<b>`), and 8.3 short names (`TILLER~1`).
Commit `fix(hooks): judge Windows-form paths in the private-access hook`.

### Task 5.7: CI matrix

`.github/workflows/test.yml`: on push and pull_request; matrix `os: [macos-latest, ubuntu-latest,
windows-latest]`, `node: [22, 24]`; steps checkout, setup-node, then the test command with glob
arguments (`node --test 'lib/apply/tests/*.test.mjs' ...`) under `shell: bash` (Git Bash on the
Windows runner). Tests that need a POSIX-only feature (`sh -c`, `chmod`, POSIX symlinks without
junction) get `{ skip: process.platform === 'win32' && '<reason>' }`, each named in the commit. The
leak guard runs on ubuntu only. No remote exists, so nothing runs the file: it is checked locally
with `ruby -ryaml -e 'YAML.load_file(ARGV[0])'` (macOS ships Ruby), the platform skips are added from
reading the tests (5.8's cases run on Windows with the real `cygpath`), and the first real run is
recorded once a remote exists. Commit `ci: run the suite on macOS,
Ubuntu and Windows`.

### Step-5 interpretations (for approval)

Owner answers 2026-10-14: Tasks 5.1–5.6, 5.8, 5.7 approved, executed in that order.

1. **(approved 2026-10-14)** Copies made by `install.sh` are manifest entries with `origin:
   'install'`; apply and uninstall skip them, status shows them (Task 5.4).
2. **(approved 2026-10-14)** Role agents stay `rendered` on Windows (step-4 interpretation 2), so in
   `tiller apply` the spec's "copy" row covers nothing; copy mode serves only 5.4.
3. **(approved 2026-10-14)** The Copilot `powershell` key is rendered on every OS next to `bash`
   (`& 'bash'` off Windows), so the hooks file has one shape everywhere (Task 5.6).
4. **Manual QA (Windows, real Copilot):** how Copilot launches the `powershell` key and whether the
   hook's stdin reaches `bash.exe` through `&` is not documented. Plan: `&` with inherited stdin; if the
   payload arrives empty, switch to `$input | & ...`. Today an empty payload passes
   `private-access.sh` (it allows a call with no tool name), so a lost stdin would fail open; 5.6 makes
   `copilot-pretooluse.sh` exit non-zero (deny) on an empty payload.
5. **(approved 2026-10-14)** Windows home = `USERPROFILE`, not `HOME` (the spec says `os.homedir()`,
   which on Windows reads `USERPROFILE`); Copilot's docs name `%USERPROFILE%\.copilot`.
6. **Manual QA (Windows, both agents):** skill discovery through a junction is undocumented for Claude
   Code and Copilot; treated as working until checked.
7. **(approved 2026-10-14)** Forward-slash Windows paths inside hook commands (Git Bash and
   PowerShell accept both; it avoids backslash escaping).

## Spec interpretations made in this plan (for approval)

1. "Degraded" = available for some detected agents but not all, or only via the `files` fallback.
2. Layer merge rules (arrays by `id`, `remove`, `null` deletes) — the spec says only "later wins".
3. An unowned existing value that differs is drift, not a silent overwrite.
4. Skill and agent linking through `tiller apply` waits for step 4 (with `link.mjs`); step 2's
   Claude adapter covers `settings.json` and `CLAUDE.md`. `install.sh` keeps linking meanwhile.
5. `machine.json` is written by `apply` (not by the read-only `doctor`).
