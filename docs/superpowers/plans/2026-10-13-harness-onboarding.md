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
- **Step 4 — `onboard --personal`, `status`, `uninstall`** plus `lib/apply/link.mjs` (POSIX symlinks)
  and skills/agents linking per adapter; uninstall restores the backup byte for byte when the file's
  hash still equals `writtenHash`, else removes owned items surgically.
- **Step 5 — Windows:** junctions, agent-file copies with hashes, `bash.exe` in hook commands,
  Copilot `bash`+`powershell` keys; CI matrix macOS/Ubuntu/Windows.
- **Step 6 — `apply --adopt <agent>`**, then moving an existing setup into a personal layer.

## Spec interpretations made in this plan (for approval)

1. "Degraded" = available for some detected agents but not all, or only via the `files` fallback.
2. Layer merge rules (arrays by `id`, `remove`, `null` deletes) — the spec says only "later wins".
3. An unowned existing value that differs is drift, not a silent overwrite.
4. Skill and agent linking through `tiller apply` waits for step 4 (with `link.mjs`); step 2's
   Claude adapter covers `settings.json` and `CLAUDE.md`. `install.sh` keeps linking meanwhile.
5. `machine.json` is written by `apply` (not by the read-only `doctor`).
