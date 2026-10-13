# Brains and Private Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach local brains to the harness, grant them per project through one matrix, and enforce
the grants and the isolation of other projects' profiles with a PreToolUse hook.

**Architecture:** Profile lookup moves out of `lib/resolve-profile.sh` into a sourced
`lib/profile-name.sh`, shared by the profile resolver, the new brain resolver and the hook.
`lib/resolve-brains.sh` validates `brains/access.json` and prints the grants of one row.
`lib/hooks/private-access.sh` normalises every path a tool call names, judges it against the
grants, scans Bash command text, and fails closed. `lib/brain-access.sh` is the only writer of the
matrix. `install.sh --hooks` prints the settings fragment.

**Tech Stack:** bash 3.2 (macOS `/bin/bash`: no associative arrays, no `mapfile`, no `${x,,}`),
`jq`, `/bin/realpath`, `node:test` for tests (same harness as `lib/tests/*.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-12-brains-and-private-access-design.md`

## Global Constraints

- Levels: `none`, `read`, `write`. A missing row or cell is `none`.
- Row key: a profile name or `_none`. Column key: a directory under `brains/`. Names starting with
  `_` are templates, never a profile or a brain.
- Resolver exit codes: 0 ok, 2 matrix invalid, 3 `TILLER_HOME` unset or unreadable.
- Resolver line format: `<name>\t<level>\t<absolute path>`, `read` and `write` only.
- Hook matcher: `Read|Grep|Glob|Edit|Write|NotebookEdit|Bash`.
- Deny message shape: `private-access: brain "main" is "none" for profile "acme" (brains/access.json)`.
- `.gitignore` gains `/brains/*`, `!/brains/_template/`, `!/brains/access.json.example`.
- Tests use only synthetic fixtures under `lib/testing/`, never `profiles/` or `brains/` of this repo.
- Every test spawn deletes `TILLER_PROFILE` and `TILLER_OVERLAY` from the env.
- Commits: one-line Conventional Commits, no trailer; `lib/leak-guard.sh --staged` clean first.
- Test runs in this sandbox need a PATH without unreadable entries:
  `export PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"`.
  Baseline on main: 748 tests, 34 driver failures (`runtime-down`, sandbox). Regression check = the
  failing set is unchanged.

### Choices the spec leaves open (taken here, none reverses a spec decision)

1. **Exit 4** from the resolver when `TILLER_PROFILE` or `.tiller-profile` names a profile that does
   not exist. Falling back to `_none` would silently apply a different row; the hook treats exit 4
   as an internal error (fail closed).
2. **`--row <profile|_none>`** on the resolver, so the picker can print what a row grants without
   faking a cwd. Without it the spec's `[<cwd>]` form is unchanged.
3. The hook defaults `TILLER_HOME` to its own repo when unset; the printed fragment also sets it
   explicitly, so a session launched without the env var is still covered.
4. Bash write detection: a `read` brain's path plus any write operator anywhere in the command is a
   deny. `2>/dev/null`, `>/dev/null` and `>&2` are stripped first. False positives are accepted.
5. Bash writes that name `brains/access.json` with a write operator are denied too (rule 4's intent:
   written only through the picker).
6. Invalid matrix, malformed input or internal error: every protected root is denied, including the
   session's own profile (spec: "denies any call that touches a protected root").

## Review Focus

1. **`TILLER_HOME` with a space** (the real one is under `Other Repos`): every case pattern and
   regex must keep the path quoted. Pinned: the hook test home is created under a directory with a
   space.
2. **Relative and missing paths**: `Read` of `brains/main/x.md` relative to `cwd`, and `Write` of a
   new file in a new subdirectory of a `none` brain, must be judged as inside the brain. Pinned in
   Task 4.
3. **Name-prefix collisions in the Bash scan**: `brains/main` must not match `brains/mainframe`.
   Pinned in Task 5.
4. **Harmless redirections next to a `read` brain**: `cat brains/main/x 2>/dev/null` must be allowed.
   Pinned in Task 5.
5. **A file directly in `brains/`** (`access.json.example`, `.DS_Store`) is not a brain and must not
   be denied as one. Pinned in Task 4.

Residual, accepted by the spec's Known gap and not tested: Grep/Glob whose root is `brains/` or
`$TILLER_HOME` itself (rule 4 allows reads there; ripgrep skips the git-ignored brains), a Glob
pattern whose first segment is a brace or wildcard, and Bash that reaches a brain without naming it
(`grep -r x brains`, `cd brains && cat main/x`).

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/profile-name.sh` (new, sourced) | `profile_name`: cwd → profile name; `list_names`: non-template subdirectories |
| `lib/resolve-profile.sh` (modify) | uses `profile_name`; behaviour unchanged |
| `lib/resolve-brains.sh` (new) | validate the matrix, print one row's grants |
| `lib/hooks/private-access.sh` (new) | PreToolUse enforcement |
| `lib/brain-access.sh` (new) | the picker, sole writer of `brains/access.json` |
| `install.sh` (modify) | `--hooks` prints the settings fragment |
| `brains/_template/README.md`, `brains/access.json.example` (new, tracked) | starting points |
| `.gitignore`, `README.md` (modify) | layout and setup |
| `lib/testing/fixtures/private-access/` (new) | profile `beta`, brains `main` and `acme-notes`, `access.json` |
| `lib/testing/private-access.mjs` (new) | builds a throwaway `TILLER_HOME` from the fixtures |
| `lib/tests/resolve-brains.test.mjs`, `lib/tests/private-access.test.mjs`, `lib/tests/brain-access.test.mjs` (new) | tests |
| `lib/tests/resolve-profile.test.mjs`, `lib/install/tests/install.test.mjs` (modify) | copy the helper; `--hooks` case |

Fixture matrix (also the content of `brains/access.json.example`):

```json
{
  "acme":  { "main": "read", "acme-notes": "write" },
  "_none": { "main": "write" }
}
```

So: `acme` → `main` read, `acme-notes` write. `beta` (no row) → both `none`. No profile → `main`
write, `acme-notes` none.

---

### Task 1: Carry the spec and this plan onto the branch

**Files:** `docs/superpowers/specs/2026-10-12-brains-and-private-access-design.md`,
`docs/superpowers/plans/2026-10-12-brains-and-private-access.md`

- [ ] **Step 1:** `lib/leak-guard.sh --staged` after `git add docs/superpowers/` → exit 0.
- [ ] **Step 2:** `git commit -m "docs: add brains and private access design and plan"`

---

### Task 2: Extract the profile lookup

**Files:**
- Create: `lib/profile-name.sh`
- Modify: `lib/resolve-profile.sh` (steps 1–3, lines 51–86)
- Modify: `lib/tests/resolve-profile.test.mjs` (`layout()` copies the helper)

**Interfaces:**
- Produces: `profile_name <profiles-dir> <dir>` → name on stdout, return 0; return 1 when nothing
  names a profile. `list_names <dir> [<required-file>]` → subdirectory names, `_*` skipped, sorted.

- [ ] **Step 1: Failing test.** In `resolve-profile.test.mjs` add, and make `layout()` copy the helper:

```js
const HELPER = fileURLToPath(new URL('../profile-name.sh', import.meta.url))
// in layout(), after copying SCRIPT:
copyFileSync(HELPER, join(root, 'lib', 'profile-name.sh'))

test('repo_globs match longest-first and an unmatched dir fails with exit 1', () => {
  const root = layout()
  writeFileSync(join(root, 'profiles', 'demo', 'profile.md'), BASE.replace('schema_version: 2', 'schema_version: 2\nrepo_globs:\n  - "*/work/demo"'))
  mkdirSync(join(root, 'work', 'demo'), { recursive: true })
  mkdirSync(join(root, 'work', 'other'), { recursive: true })
  const env = { ...process.env }; delete env.TILLER_PROFILE; delete env.TILLER_OVERLAY
  const hit = spawnSync('bash', [join(root, 'lib', 'resolve-profile.sh'), join(root, 'work', 'demo')], { encoding: 'utf8', env })
  assert.equal(hit.status, 0, hit.stderr)
  assert.equal(hit.stdout.trim(), join(root, 'profiles', 'demo', 'profile.md'))
  const miss = spawnSync('bash', [join(root, 'lib', 'resolve-profile.sh'), join(root, 'work', 'other')], { encoding: 'utf8', env })
  assert.equal(miss.status, 1)
})
```

Also make `resolve()` delete `TILLER_PROFILE` before setting it (it already sets it; keep).

- [ ] **Step 2:** `node --test lib/tests/resolve-profile.test.mjs` → FAIL (`ENOENT` copying `profile-name.sh`).

- [ ] **Step 3: Implement `lib/profile-name.sh`.**

```bash
# Sourced, not run. Profile lookup shared by resolve-profile.sh, resolve-brains.sh and the
# private-access hook, so the three never disagree on which project a directory belongs to.

# profile_name <profiles-dir> <dir> -> the profile name; returns 1 when nothing names one.
# Order: TILLER_PROFILE env > .tiller-profile at the repo root > repo_globs, longest first, so a
# worktree path never loses to the shorter glob of its parent workspace. A name starting with _ is
# a template. Whether the named profile exists is the caller's check.
profile_name() {
  local profiles="$1" target="$2" root p name glob line
  local entries=()
  if [ -n "${TILLER_PROFILE:-}" ]; then printf '%s\n' "$TILLER_PROFILE"; return 0; fi
  root="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null || echo "$target")"
  if [ -f "$root/.tiller-profile" ]; then
    head -1 "$root/.tiller-profile" | tr -d '[:space:]'; echo; return 0
  fi
  for p in "$profiles"/*/profile.md; do
    [ -f "$p" ] || continue
    name="$(basename "$(dirname "$p")")"
    case "$name" in _*) continue ;; esac
    while IFS= read -r glob; do
      [ -n "$glob" ] && entries+=("${#glob} $glob $name")
    done < <(awk '/^repo_globs:/{f=1;next} /^[a-z_]+:/{f=0} f&&/^ *- /{sub(/^ *- */,"");gsub(/"/,"");print}' "$p")
  done
  [ "${#entries[@]}" -gt 0 ] || return 1
  while IFS= read -r line; do
    glob="${line#* }"; glob="${glob% *}"
    name="${line##* }"
    # shellcheck disable=SC2254
    case "$target" in $glob|$glob/*) printf '%s\n' "$name"; return 0 ;; esac
  done < <(printf '%s\n' "${entries[@]}" | sort -rn)
  return 1
}

# list_names <dir> [<required-file>] -> names of its subdirectories (with that file, if given),
# templates skipped, one per line, sorted.
list_names() {
  local d n
  for d in "$1"/*/; do
    [ -d "$d" ] || continue
    n="${d%/}"; n="${n##*/}"
    case "$n" in _*) continue ;; esac
    [ -z "${2:-}" ] || [ -f "$1/$n/$2" ] || continue
    printf '%s\n' "$n"
  done
}
```

In `lib/resolve-profile.sh` replace everything from `# 1 — explicit override` to the line before
the final `echo "resolve-profile: no profile matches..."` with:

```bash
# shellcheck source=profile-name.sh
. "$REPO_DIR/lib/profile-name.sh"
name="$(profile_name "$PROFILES" "$target")" && emit "$name"
```

and update its header comment's order line to point at `lib/profile-name.sh`.

- [ ] **Step 4:** `node --test lib/tests/resolve-profile.test.mjs` → PASS (5 tests). Then the full
  suite (command in Global Constraints) → failing set equals baseline.
- [ ] **Step 5:** leak guard, then `git commit -m "refactor(profiles): extract profile lookup for reuse by the brain resolver"`

---

### Task 3: Fixtures and the brain resolver

**Files:**
- Create: `lib/testing/fixtures/private-access/profiles/beta/profile.md`,
  `lib/testing/fixtures/private-access/brains/main/note.md`,
  `lib/testing/fixtures/private-access/brains/acme-notes/note.md`,
  `lib/testing/fixtures/private-access/access.json`, `lib/testing/private-access.mjs`
- Create: `lib/resolve-brains.sh`, `lib/tests/resolve-brains.test.mjs`
- Modify: `lib/testing/README.md` (one line on the new fixture)

**Interfaces:**
- Consumes: `profile_name`, `list_names`.
- Produces: `lib/resolve-brains.sh [--row <name>] [<cwd>]`, exit 0/2/3/4, lines
  `<name>\t<level>\t<abs path>`. `makeHome({ matrix, spaced })` and `cwds(home)` from
  `lib/testing/private-access.mjs`.

- [ ] **Step 1: Fixtures.** `beta/profile.md`:

```markdown
---
profile: beta
schema_version: 2
repo_globs:
  - "*/src/beta-app"
---

# Profile — Beta (synthetic test fixture)
```

`brains/main/note.md`: `main brain fixture note`. `brains/acme-notes/note.md`: `acme notes fixture note`.
`access.json`: the fixture matrix above.

`lib/testing/private-access.mjs`:

```js
import { cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIX = fileURLToPath(new URL('./fixtures/private-access/', import.meta.url))
const ACME = fileURLToPath(new URL('./fixtures/acme/profile.md', import.meta.url))

// A throwaway TILLER_HOME: profiles acme and beta, brains main and acme-notes, the fixture matrix.
// `matrix: null` leaves access.json out; a string is written verbatim (for invalid JSON).
export function makeHome({ matrix, spaced = true } = {}) {
  const base = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'private-access-')))
  const home = join(base, spaced ? 'Other Repos' : 'repos', 'tiller')
  mkdirSync(join(home, 'profiles', 'acme'), { recursive: true })
  cpSync(ACME, join(home, 'profiles', 'acme', 'profile.md'))
  cpSync(join(FIX, 'profiles'), join(home, 'profiles'), { recursive: true })
  mkdirSync(join(home, 'profiles', '_template'), { recursive: true })
  writeFileSync(join(home, 'profiles', '_template', 'profile.md'), '# template\n')
  cpSync(join(FIX, 'brains'), join(home, 'brains'), { recursive: true })
  mkdirSync(join(home, 'brains', '_template'), { recursive: true })
  writeFileSync(join(home, 'brains', '_template', 'README.md'), '# template\n')
  if (matrix === undefined) cpSync(join(FIX, 'access.json'), join(home, 'brains', 'access.json'))
  else if (matrix !== null) writeFileSync(join(home, 'brains', 'access.json'), typeof matrix === 'string' ? matrix : JSON.stringify(matrix))
  const cwd = { acme: join(base, 'src', 'acme-web'), beta: join(base, 'src', 'beta-app'), none: join(base, 'elsewhere') }
  for (const d of Object.values(cwd)) mkdirSync(d, { recursive: true })
  return { base, home, cwd }
}

export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.TILLER_PROFILE; delete env.TILLER_OVERLAY
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return env
}
```

- [ ] **Step 2: Failing tests** `lib/tests/resolve-brains.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const SCRIPT = fileURLToPath(new URL('../resolve-brains.sh', import.meta.url))
const run = (home, args, extra = {}) =>
  spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: cleanEnv({ TILLER_HOME: home, ...extra }) })
const lines = r => r.stdout.split('\n').filter(Boolean).sort()

test('a profile row prints its read and write grants with absolute paths', () => {
  const { home, cwd } = makeHome()
  const r = run(home, [cwd.acme])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(lines(r), [`acme-notes\twrite\t${home}/brains/acme-notes`, `main\tread\t${home}/brains/main`])
})

test('a missing row is none: nothing printed, exit 0', () => {
  const { home, cwd } = makeHome()
  const r = run(home, [cwd.beta])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('no profile resolves: the _none row decides', () => {
  const { home, cwd } = makeHome()
  assert.deepEqual(lines(run(home, [cwd.none])), [`main\twrite\t${home}/brains/main`])
})

test('a missing cell is none: a new brain is closed until granted', () => {
  const { home, cwd } = makeHome()
  mkdirSync(join(home, 'brains', 'fresh'))
  assert.ok(!run(home, [cwd.acme]).stdout.includes('fresh'))
})

test('--row selects a row without a cwd', () => {
  const { home } = makeHome()
  assert.deepEqual(lines(run(home, ['--row', '_none'])), [`main\twrite\t${home}/brains/main`])
})

test('no matrix: everything is none', () => {
  const { home, cwd } = makeHome({ matrix: null })
  const r = run(home, [cwd.none])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
})

test('an unknown value, brain or profile, or broken JSON, is exit 2 naming the problem', () => {
  const cases = [
    [{ acme: { main: 'admin' } }, /unknown level "admin"/],
    [{ acme: { ghost: 'read' } }, /no such brain "ghost"/],
    [{ ghost: { main: 'read' } }, /row "ghost": no such profile/],
    ['{ not json', /not valid JSON/],
  ]
  for (const [matrix, msg] of cases) {
    const { home, cwd } = makeHome({ matrix })
    const r = run(home, [cwd.acme])
    assert.equal(r.status, 2, JSON.stringify(matrix))
    assert.match(r.stderr, msg)
    assert.equal(r.stdout, '')
  }
})

test('TILLER_HOME unset is exit 3; a named profile that does not exist is exit 4', () => {
  const { home, cwd } = makeHome()
  assert.equal(run(home, [cwd.acme], { TILLER_HOME: undefined }).status, 3)
  assert.equal(spawnSync('bash', [SCRIPT, cwd.acme], { encoding: 'utf8', env: { ...cleanEnv({ TILLER_HOME: home }), TILLER_PROFILE: 'ghost' } }).status, 4)
})
```

- [ ] **Step 3:** `node --test lib/tests/resolve-brains.test.mjs` → FAIL (script missing).

- [ ] **Step 4: Implement `lib/resolve-brains.sh`** (`chmod +x`):

```bash
#!/usr/bin/env bash
# Resolve the brains a working directory may use.
#
#   resolve-brains.sh [<dir>]              -> grants of the profile <dir> resolves to, or of _none
#   resolve-brains.sh --row <name|_none>   -> grants of that row
#
# Prints one line per granted brain: <name>\t<read|write>\t<absolute path>. A missing row or cell is
# none and prints nothing. A brain skill takes its paths from here and never hardcodes a vault.
# Exit 0 ok, 2 matrix invalid, 3 TILLER_HOME unset or unreadable, 4 a profile is named
# (TILLER_PROFILE, .tiller-profile) but does not exist.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=profile-name.sh
. "$LIB/profile-name.sh"

{ [ -n "${TILLER_HOME:-}" ] && [ -d "$TILLER_HOME" ] && [ -r "$TILLER_HOME" ]; } \
  || { echo "resolve-brains: TILLER_HOME unset or unreadable" >&2; exit 3; }
home="$(cd "$TILLER_HOME" && pwd -P)"
matrix="$home/brains/access.json"

if [ "${1:-}" = "--row" ]; then
  row="${2:-}"
  [ -n "$row" ] || { echo "resolve-brains: --row needs a name" >&2; exit 3; }
else
  target="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "resolve-brains: no such dir" >&2; exit 3; }
  if row="$(profile_name "$home/profiles" "$target")"; then
    [ -f "$home/profiles/$row/profile.md" ] || { echo "resolve-brains: no profile '$row'" >&2; exit 4; }
  else
    row=_none
  fi
fi

[ -f "$matrix" ] || exit 0

profiles="$(list_names "$home/profiles" profile.md | jq -R . | jq -sc .)"
brains="$(list_names "$home/brains" | jq -R . | jq -sc .)"
problems="$(jq -r --argjson profiles "$profiles" --argjson brains "$brains" '
  if type != "object" then "the matrix is not an object" else
  to_entries[] | .key as $row |
  if $row != "_none" and ($profiles | index($row)) == null then "row \"\($row)\": no such profile"
  elif (.value | type) != "object" then "row \"\($row)\": not an object"
  else .value | to_entries[] |
    if ($brains | index(.key)) == null then "row \"\($row)\": no such brain \"\(.key)\""
    elif (.value | type) != "string" or ([.value] | inside(["none", "read", "write"]) | not)
      then "row \"\($row)\", brain \"\(.key)\": unknown level \(.value | tojson)"
    else empty end
  end end' "$matrix" 2>/dev/null)" \
  || { echo "resolve-brains: brains/access.json is not valid JSON" >&2; exit 2; }
if [ -n "$problems" ]; then
  printf 'resolve-brains: %s (brains/access.json)\n' "$problems" >&2
  exit 2
fi

jq -r --arg row "$row" '(.[$row] // {}) | to_entries[] | select(.value != "none") | "\(.key)\t\(.value)"' "$matrix" |
  while IFS="$(printf '\t')" read -r name level; do
    printf '%s\t%s\t%s\n' "$name" "$level" "$home/brains/$name"
  done
```

Note: a quoted `"` in a JSON key is not valid in a brain or profile name, so plain interpolation in
the messages is safe.

- [ ] **Step 5:** `node --test lib/tests/resolve-brains.test.mjs` → PASS (8 tests).
- [ ] **Step 6:** leak guard, then `git commit -m "feat(brains): resolve the brains a project may read or write from one access matrix"`

---

### Task 4: Enforcement hook — path tools

**Files:**
- Create: `lib/hooks/private-access.sh`, `lib/tests/private-access.test.mjs`

**Interfaces:**
- Consumes: `profile_name`, `list_names`, `lib/resolve-brains.sh --row`.
- Produces: hook reading PreToolUse JSON on stdin; prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"private-access: …"}}`
  to deny, nothing to allow; always exit 0.

- [ ] **Step 1: Failing tests** `lib/tests/private-access.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const HOOK = fileURLToPath(new URL('../hooks/private-access.sh', import.meta.url))

function call(home, cwd, tool_name, tool_input, raw) {
  const input = raw ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd })
  const r = spawnSync('bash', [HOOK], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home }) })
  assert.equal(r.status, 0, r.stderr)
  if (!r.stdout.trim()) return { decision: 'allow' }
  const out = JSON.parse(r.stdout).hookSpecificOutput
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason }
}
const denied = (r, msg) => { assert.equal(r.decision, 'deny'); if (msg) assert.match(r.reason, msg) }
const allowed = r => assert.equal(r.decision, 'allow', r.reason)

test('none brain: Read, Grep and Glob are denied with the matrix cell named', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'main', 'note.md')
  denied(call(home, cwd.beta, 'Read', { file_path: note }),
    /^private-access: brain "main" is "none" for profile "beta" \(brains\/access\.json\)$/)
  denied(call(home, cwd.beta, 'Grep', { pattern: 'x', path: join(home, 'brains', 'main') }))
  denied(call(home, cwd.beta, 'Glob', { pattern: 'brains/main/**/*.md', path: home }))
  denied(call(home, cwd.beta, 'Glob', { pattern: '**/*.md', path: join(home, 'brains', 'main') }))
})

test('read brain: Read allowed, Edit, Write and NotebookEdit denied', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'main', 'note.md')
  allowed(call(home, cwd.acme, 'Read', { file_path: note }))
  denied(call(home, cwd.acme, 'Edit', { file_path: note, old_string: 'a', new_string: 'b' }), /"main" is "read" for profile "acme"/)
  denied(call(home, cwd.acme, 'Write', { file_path: note, content: 'x' }))
  denied(call(home, cwd.acme, 'NotebookEdit', { notebook_path: join(home, 'brains', 'main', 'n.ipynb'), new_source: '' }))
})

test('write brain: every tool is allowed', () => {
  const { home, cwd } = makeHome()
  const note = join(home, 'brains', 'acme-notes', 'note.md')
  allowed(call(home, cwd.acme, 'Read', { file_path: note }))
  allowed(call(home, cwd.acme, 'Edit', { file_path: note, old_string: 'a', new_string: 'b' }))
  allowed(call(home, cwd.acme, 'Write', { file_path: join(home, 'brains', 'acme-notes', 'new', 'x.md'), content: 'x' }))
})

test("another project's profile is denied; own profile and _template are allowed", () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'beta', 'profile.md') }), /profiles\/beta/)
  allowed(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }))
  allowed(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', '_template', 'profile.md') }))
})

test('a symlink outside TILLER_HOME pointing into a denied brain is judged by its target', () => {
  const { base, home, cwd } = makeHome()
  symlinkSync(join(home, 'brains', 'main'), join(base, 'shortcut'))
  denied(call(home, cwd.beta, 'Read', { file_path: join(base, 'shortcut', 'note.md') }))
})

test('_none row: its grants apply when cwd resolves no profile, and every real profile is denied', () => {
  const { home, cwd } = makeHome()
  allowed(call(home, cwd.none, 'Write', { file_path: join(home, 'brains', 'main', 'x.md'), content: 'x' }))
  denied(call(home, cwd.none, 'Read', { file_path: join(home, 'brains', 'acme-notes', 'note.md') }), /for profile "_none"/)
  denied(call(home, cwd.none, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }))
  allowed(call(home, cwd.none, 'Read', { file_path: join(home, 'profiles', '_template', 'profile.md') }))
})

test('brains/access.json: Read allowed, Edit and Write denied', () => {
  const { home, cwd } = makeHome()
  const m = join(home, 'brains', 'access.json')
  allowed(call(home, cwd.none, 'Read', { file_path: m }))
  denied(call(home, cwd.none, 'Edit', { file_path: m, old_string: 'a', new_string: 'b' }), /brain-access\.sh/)
  denied(call(home, cwd.none, 'Write', { file_path: m, content: '{}' }))
})

test('relative and missing paths are judged where they land', () => {
  const { home, cwd } = makeHome()
  denied(call(home, home, 'Read', { file_path: 'brains/acme-notes/note.md' }))  // cwd = TILLER_HOME, row _none
  denied(call(home, cwd.beta, 'Write', { file_path: join(home, 'brains', 'main', 'new', 'deep', 'x.md'), content: 'x' }))
})

test('a file directly in brains/ is not a brain', () => {
  const { home, cwd } = makeHome()
  writeFileSync(join(home, 'brains', 'access.json.example'), '{}')
  allowed(call(home, cwd.beta, 'Read', { file_path: join(home, 'brains', 'access.json.example') }))
  allowed(call(home, cwd.beta, 'Read', { file_path: join(home, 'brains', '_template', 'README.md') }))
  allowed(call(home, cwd.beta, 'Glob', { pattern: '*', path: join(home, 'brains') }))
})

test('a path outside TILLER_HOME is allowed', () => {
  const { base, home, cwd } = makeHome()
  allowed(call(home, cwd.beta, 'Read', { file_path: join(base, 'elsewhere', 'x.md') }))
})
```

- [ ] **Step 2:** `node --test lib/tests/private-access.test.mjs` → FAIL (hook missing).

- [ ] **Step 3: Implement `lib/hooks/private-access.sh`** (`chmod +x`). Bash branch is a stub in this
  task (`Bash) ;;`) and is filled in Task 5.

```bash
#!/usr/bin/env bash
# PreToolUse hook: deny a tool call that reaches a brain the session's project was not granted, or
# another project's profile. The project is resolved from the hook's cwd; grants come from
# brains/access.json through lib/resolve-brains.sh. Fails closed: when the input, the matrix or
# this script is broken, any call that names a protected root is denied and the rest allowed.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../profile-name.sh
. "$LIB/profile-name.sh"
export TILLER_HOME="${TILLER_HOME:-$(dirname "$LIB")}"
input="$(cat)"

deny() {
  jq -cn --arg r "private-access: $1" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $r}}'
  exit 0
}

# Any brains/<x> or profiles/<x> that is not a template, in free text.
names_protected() {
  printf '%s' "$1" | grep -Eq '(^|[^A-Za-z0-9_.-])(brains|profiles)/[A-Za-z0-9]'
}

# Absolute, symlinks resolved; a missing tail is kept as written under its nearest existing parent.
norm() {
  local p="$1" tail=""
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
    /*) ;;
    *) p="$cwd/$p" ;;
  esac
  while [ ! -e "$p" ] && [ "$p" != / ]; do
    tail="/${p##*/}$tail"
    p="$(dirname "$p")"
  done
  p="$(realpath "$p")" || return 1
  printf '%s%s\n' "${p%/}" "$tail"
}

level_of() {
  printf '%s\n' "$grants" | awk -F'\t' -v b="$1" '$1 == b { print $2; f = 1 } END { if (!f) print "none" }'
}

# judge <absolute path> <1 when the tool writes>
judge() {
  local p="$1" w="$2" rest name lvl
  case "$p" in
    "$home/brains"|"$home/profiles") return 0 ;;
    "$home/brains/access.json")
      [ "$w" = 1 ] && deny "brains/access.json is written only through lib/brain-access.sh"
      return 0 ;;
    "$home/brains/_template"|"$home/brains/_template/"*|"$home/profiles/_template"|"$home/profiles/_template/"*) return 0 ;;
    "$home/brains/"*)
      rest="${p#"$home/brains/"}"; name="${rest%%/*}"
      [ "$rest" = "$name" ] && [ ! -d "$home/brains/$name" ] && return 0
      [ -n "$broken" ] && deny "brain \"$name\" denied: $broken"
      lvl="$(level_of "$name")"
      [ "$lvl" = none ] && deny "brain \"$name\" is \"none\" for profile \"$row\" (brains/access.json)"
      [ "$lvl" = read ] && [ "$w" = 1 ] && deny "brain \"$name\" is \"read\" for profile \"$row\" (brains/access.json)"
      return 0 ;;
    "$home/profiles/"*)
      rest="${p#"$home/profiles/"}"; name="${rest%%/*}"
      [ "$rest" = "$name" ] && [ ! -d "$home/profiles/$name" ] && return 0
      [ -n "$broken" ] && deny "profiles/$name denied: $broken"
      [ "$name" = "$row" ] || deny "profiles/$name is not the resolved profile \"$row\""
      return 0 ;;
  esac
}

judge_path() {  # judge_path <raw path> <write>
  local n
  [ -n "$1" ] || { names_protected "$input" && deny "no path in the tool input"; return 0; }
  n="$(norm "$1")" || deny "could not normalise $1"
  judge "$n" "$2"
}

# Glob: the search root, and the root joined with the pattern's literal prefix.
glob_target() {
  local base="$1" pattern="$2" prefix
  prefix="$(printf '%s' "$pattern" | awk -F/ '{ o = ""; for (i = 1; i <= NF; i++) { if ($i ~ /[*?[{]/) break; o = o (i > 1 ? "/" : "") $i } print o }')"
  case "$prefix" in
    "") printf '%s\n' "$base" ;;
    /*) printf '%s\n' "$prefix" ;;
    *) printf '%s\n' "$base/$prefix" ;;
  esac
}

f() { jq -r --arg k "$1" '.tool_input[$k] // empty' <<<"$input"; }

main() {
  tool="$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null)" || tool=""
  cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)" || cwd=""
  if [ -z "$tool" ] || [ -z "$cwd" ]; then
    names_protected "$input" && deny "malformed hook input"
    return 0
  fi
  home="$(realpath "$TILLER_HOME")" || { names_protected "$input" && deny "TILLER_HOME unreadable"; return 0; }

  broken=""
  if row="$(profile_name "$home/profiles" "$cwd")"; then
    [ -f "$home/profiles/$row/profile.md" ] || broken="profile \"$row\" is named but does not exist"
  else
    row=_none
  fi
  grants=""
  if [ -z "$broken" ]; then
    grants="$("$LIB/resolve-brains.sh" --row "$row" 2>/dev/null)" || broken="brains/access.json is invalid (run lib/resolve-brains.sh)"
  fi

  local p
  case "$tool" in
    Read) judge_path "$(f file_path)" 0 ;;
    Edit|Write) judge_path "$(f file_path)" 1 ;;
    NotebookEdit) judge_path "$(f notebook_path)" 1 ;;
    Grep) p="$(f path)"; judge_path "${p:-$cwd}" 0 ;;
    Glob)
      local base; base="$(f path)"; [ -n "$base" ] || base="$cwd"
      judge_path "$base" 0
      judge_path "$(glob_target "$(norm "$base")" "$(f pattern)")" 0 ;;
    Bash) ;;
  esac
  return 0
}

out="$(main)"; rc=$?
[ "$rc" -eq 0 ] && { printf '%s' "$out"; exit 0; }
names_protected "$input" && deny "internal error ($rc) while judging a protected path"
exit 0
```

- [ ] **Step 4:** `node --test lib/tests/private-access.test.mjs` → PASS (10 tests).
- [ ] **Step 5:** leak guard, then `git commit -m "feat(hooks): deny path tools that reach an ungranted brain or another project's profile"`

---

### Task 5: Enforcement hook — Bash scan and fail-closed

**Files:**
- Modify: `lib/hooks/private-access.sh` (the `Bash)` branch, plus `scan_bash`)
- Modify: `lib/tests/private-access.test.mjs`

- [ ] **Step 1: Failing tests** (append):

```js
test('Bash: a none brain or another profile named in any form is denied', () => {
  const { home, cwd } = makeHome()
  for (const command of [
    `cat "${join(home, 'brains', 'main', 'note.md')}"`,
    'cat ~/x/tiller/brains/main/note.md',
    'cat "$TILLER_HOME/brains/main/note.md"',
    'cd /tmp && cat brains/main',
  ]) denied(call(home, cwd.beta, 'Bash', { command }), /"main" is "none"/)
  denied(call(home, cwd.acme, 'Bash', { command: 'cat profiles/beta/profile.md' }), /profiles\/beta/)
  allowed(call(home, cwd.acme, 'Bash', { command: 'cat profiles/acme/profile.md profiles/_template/profile.md' }))
})

test('Bash: a brain name is matched whole, not as a prefix', () => {
  const { home, cwd } = makeHome()
  allowed(call(home, cwd.beta, 'Bash', { command: 'ls /srv/brains/mainframe' }))
})

test('Bash: a write into a read brain is denied, a harmless redirection is not', () => {
  const { home, cwd } = makeHome()
  const dir = join(home, 'brains', 'main')
  for (const command of [`echo x > "${dir}/new.md"`, `echo x | tee -a "${dir}/note.md"`, `mv /tmp/a "${dir}/"`, `cp /tmp/a "${dir}/b"`])
    denied(call(home, cwd.acme, 'Bash', { command }), /"main" is "read"/)
  allowed(call(home, cwd.acme, 'Bash', { command: `cat "${dir}/note.md" 2>/dev/null` }))
  allowed(call(home, cwd.acme, 'Bash', { command: `echo x > "${join(home, 'brains', 'acme-notes', 'n.md')}"` }))
})

test('Bash: writing brains/access.json is denied', () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.none, 'Bash', { command: `echo '{}' > "${join(home, 'brains', 'access.json')}"` }))
  allowed(call(home, cwd.none, 'Bash', { command: `cat "${join(home, 'brains', 'access.json')}"` }))
})

test('malformed JSON: a protected path is denied, an unrelated one allowed', () => {
  const { home, cwd } = makeHome()
  denied(call(home, cwd.acme, null, null, `{"tool_name":"Read","tool_input":{"file_path":"${home}/brains/main/note.md"`), /malformed/)
  allowed(call(home, cwd.acme, null, null, '{"tool_name":"Read","tool_input":{"file_path":"/srv/x.md"'))
})

test('invalid matrix: every protected path is denied, an unrelated one allowed', () => {
  const { base, home, cwd } = makeHome({ matrix: { acme: { main: 'admin' } } })
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'brains', 'acme-notes', 'note.md') }), /invalid/)
  denied(call(home, cwd.acme, 'Read', { file_path: join(home, 'profiles', 'acme', 'profile.md') }), /invalid/)
  denied(call(home, cwd.acme, 'Bash', { command: 'cat brains/acme-notes/note.md' }), /invalid/)
  allowed(call(home, cwd.acme, 'Read', { file_path: join(base, 'elsewhere', 'x.md') }))
  allowed(call(home, cwd.acme, 'Bash', { command: 'ls /srv' }))
})
```

- [ ] **Step 2:** run → the Bash, malformed-protected and invalid-matrix Bash cases FAIL.

- [ ] **Step 3: Implement.** Add above `main`:

```bash
# word_hit <text> <relative path> -> the path appears as a whole path segment run.
word_hit() {
  local re
  re="$(printf '%s' "$2" | sed 's/[.[\*^$()+?{|]/\\&/g')"
  printf '%s' "$1" | grep -Eq "(^|[^A-Za-z0-9_.-])$re([^A-Za-z0-9_.-]|\$)"
}

# Write operators, after dropping redirections that only reach /dev/null or another descriptor.
writes() {
  printf '%s' "$1" | sed -E 's/[0-9]*>>?[[:space:]]*(&[0-9]+|\/dev\/null)//g' |
    grep -Eq '>|(^|[^A-Za-z0-9_-])(tee|mv|cp|rm|rmdir|touch|mkdir|ln|install|rsync|truncate|dd|chmod|chown|unlink|patch)([^A-Za-z0-9_-]|$)|(sed|perl)[^|;&]*[[:space:]]-i|git[^|;&]*[[:space:]](commit|add|mv|rm|checkout|reset|restore|stash|apply|am|merge|rebase|pull|clean)([^A-Za-z0-9_-]|$)'
}

# The command text names every path it reaches only when it is written out; see the spec's Known gap.
scan_bash() {
  local cmd="$1" b p lvl
  if [ -n "$broken" ]; then
    names_protected "$cmd" && deny "Bash names a protected path: $broken"
    return 0
  fi
  word_hit "$cmd" brains/access.json && writes "$cmd" && deny "brains/access.json is written only through lib/brain-access.sh"
  for b in $(list_names "$home/brains"); do
    word_hit "$cmd" "brains/$b" || continue
    lvl="$(level_of "$b")"
    [ "$lvl" = none ] && deny "brain \"$b\" is \"none\" for profile \"$row\" (brains/access.json)"
    [ "$lvl" = read ] && writes "$cmd" && deny "brain \"$b\" is \"read\" for profile \"$row\" (brains/access.json)"
  done
  for p in $(list_names "$home/profiles" profile.md); do
    [ "$p" = "$row" ] && continue
    word_hit "$cmd" "profiles/$p" && deny "profiles/$p is not the resolved profile \"$row\""
  done
  return 0
}
```

Replace `Bash) ;;` with `Bash) scan_bash "$(f command)" ;;`. Brain and profile names cannot contain
whitespace (they are directory names this harness creates), so the unquoted `for` is safe; a name
with a space would be skipped by `list_names`' consumer — add `case "$n" in *[[:space:]]*) continue ;; esac`
to `list_names` in the same commit, with the test in Task 3's file:

```js
test('a brain directory with whitespace in its name is not a brain', () => {
  const { home, cwd } = makeHome()
  mkdirSync(join(home, 'brains', 'bad name'))
  assert.equal(run(home, [cwd.acme]).status, 0)
})
```

- [ ] **Step 4:** `node --test lib/tests/private-access.test.mjs lib/tests/resolve-brains.test.mjs` → PASS.
- [ ] **Step 5:** leak guard, then `git commit -m "feat(hooks): scan Bash commands for ungranted brains and profiles, failing closed"`

---

### Task 6: The picker

**Files:**
- Create: `lib/brain-access.sh` (`chmod +x`), `lib/tests/brain-access.test.mjs`

**Interfaces:**
- Consumes: `list_names`, `lib/resolve-brains.sh --row`.
- Produces: `brain-access.sh`, `brain-access.sh <row>`, `brain-access.sh --set <row> <brain> <level>`.
  Exit 0 ok, 2 unknown row/brain/level or usage, 3 `TILLER_HOME` or write failure.

- [ ] **Step 1: Failing tests:**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, cleanEnv } from '../testing/private-access.mjs'

const PICKER = fileURLToPath(new URL('../brain-access.sh', import.meta.url))
const RESOLVER = fileURLToPath(new URL('../resolve-brains.sh', import.meta.url))
const pick = (home, args, input = '') =>
  spawnSync('bash', [PICKER, ...args], { encoding: 'utf8', input, env: cleanEnv({ TILLER_HOME: home }) })
const grants = (home, row) =>
  spawnSync('bash', [RESOLVER, '--row', row], { encoding: 'utf8', env: cleanEnv({ TILLER_HOME: home }) }).stdout.split('\n').filter(Boolean).map(l => l.split('\t').slice(0, 2).join(' ')).sort()
const matrix = home => JSON.parse(readFileSync(join(home, 'brains', 'access.json'), 'utf8'))

test('no argument prints profiles x brains with _none last', () => {
  const { home } = makeHome()
  const r = pick(home, [])
  assert.equal(r.status, 0, r.stderr)
  const rows = r.stdout.trim().split('\n')
  assert.match(rows[0], /acme-notes\s+main/)
  assert.match(rows.find(l => l.startsWith('acme ')), /write\s+read/)
  assert.match(rows.find(l => l.startsWith('beta ')), /none\s+none/)
  assert.match(rows.at(-1), /^_none\s+none\s+write/)
})

test('no matrix: the picker creates an empty one', () => {
  const { home } = makeHome({ matrix: null })
  assert.equal(pick(home, []).status, 0)
  assert.deepEqual(matrix(home), {})
})

test('--set round-trips through the resolver; none removes the cell and an empty row', () => {
  const { home } = makeHome()
  const r = pick(home, ['--set', 'beta', 'main', 'write'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /main\twrite/)
  assert.deepEqual(grants(home, 'beta'), ['main write'])
  pick(home, ['--set', 'beta', 'main', 'none'])
  assert.deepEqual(grants(home, 'beta'), [])
  assert.equal(matrix(home).beta, undefined)
  assert.deepEqual(readdirSync(join(home, 'brains')).filter(f => f.startsWith('.access')), [])
})

test('an unknown profile, brain or level is refused and the matrix is unchanged', () => {
  const { home } = makeHome()
  const before = readFileSync(join(home, 'brains', 'access.json'), 'utf8')
  for (const args of [['ghost', 'main', 'read'], ['acme', 'ghost', 'read'], ['acme', 'main', 'admin'], ['_template', 'main', 'read']])
    assert.equal(pick(home, ['--set', ...args]).status, 2, args.join(' '))
  assert.equal(pick(home, ['ghost']).status, 2)
  assert.equal(readFileSync(join(home, 'brains', 'access.json'), 'utf8'), before)
})

test('interactive: arrows move, space cycles, enter saves; q leaves the matrix alone', () => {
  const { home } = makeHome()
  // brains sorted: acme-notes, main. Down to main, space twice: none -> read -> write.
  const r = pick(home, ['beta'], '\x1b[B  \n')
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(grants(home, 'beta'), ['main write'])
  pick(home, ['beta'], ' q')
  assert.deepEqual(grants(home, 'beta'), ['main write'])
})
```

- [ ] **Step 2:** `node --test lib/tests/brain-access.test.mjs` → FAIL (script missing).

- [ ] **Step 3: Implement `lib/brain-access.sh`:**

```bash
#!/usr/bin/env bash
# Edit brains/access.json, the matrix of which project may read or write which brain.
#
#   brain-access.sh                                      print the matrix, profiles x brains, _none last
#   brain-access.sh <profile|_none>                      pick one row: arrows move, space cycles
#                                                        none -> read -> write, enter saves, q quits
#   brain-access.sh --set <profile|_none> <brain> <none|read|write>
#
# The only writer of the matrix: saves are atomic (temp file + rename) and are followed by what the
# row now grants, as lib/resolve-brains.sh sees it. Exit 0 ok, 2 unknown name or level, 3 TILLER_HOME
# unset or the matrix could not be written.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=profile-name.sh
. "$LIB/profile-name.sh"

{ [ -n "${TILLER_HOME:-}" ] && [ -d "$TILLER_HOME" ]; } || { echo "brain-access: TILLER_HOME unset or unreadable" >&2; exit 3; }
home="$(cd "$TILLER_HOME" && pwd -P)"
matrix="$home/brains/access.json"
mkdir -p "$home/brains" || exit 3
[ -f "$matrix" ] || echo '{}' >"$matrix" || { echo "brain-access: could not create $matrix" >&2; exit 3; }

profiles="$(list_names "$home/profiles" profile.md)"
brains="$(list_names "$home/brains")"

is_in() { printf '%s\n' "$2" | grep -qxF -- "$1"; }
check_row() { [ "$1" = _none ] || is_in "$1" "$profiles" || { echo "brain-access: no profile '$1'" >&2; exit 2; }; }
check_brain() { is_in "$1" "$brains" || { echo "brain-access: no brain '$1'" >&2; exit 2; }; }
level() { jq -r --arg r "$1" --arg b "$2" '.[$r][$b] // "none"' "$matrix"; }

# save_row <row> <JSON object brain -> level>: one atomic write; none cells and an empty row vanish.
save_row() {
  local tmp
  tmp="$(mktemp "$home/brains/.access.json.XXXXXX")" || { echo "brain-access: could not write $matrix" >&2; exit 3; }
  if jq --arg r "$1" --argjson cells "$2" \
      '.[$r] = ((.[$r] // {}) + $cells | with_entries(select(.value != "none"))) | if .[$r] == {} then del(.[$r]) else . end' \
      "$matrix" >"$tmp" && mv "$tmp" "$matrix"; then
    echo "$1 now grants:"
    "$LIB/resolve-brains.sh" --row "$1" || true
  else
    rm -f "$tmp"; echo "brain-access: could not write $matrix" >&2; exit 3
  fi
}

print_table() {
  local r b line
  line="profile"; for b in $brains; do line="$line	$b"; done; printf '%s\n' "$line"
  for r in $profiles _none; do
    line="$r"; for b in $brains; do line="$line	$(level "$r" "$b")"; done; printf '%s\n' "$line"
  done
}

pick_row() {
  local row="$1" i=0 n key b cells levels=() names=()
  for b in $brains; do names+=("$b"); levels+=("$(level "$row" "$b")"); done
  n="${#names[@]}"
  [ "$n" -gt 0 ] || { echo "brain-access: no brains under $home/brains" >&2; return 0; }
  while :; do
    [ -t 2 ] && printf '\033[H\033[2J' >&2
    echo "$row — arrows move, space cycles, enter saves, q quits" >&2
    for b in $(seq 0 $((n - 1))); do
      [ "$b" = "$i" ] && printf '> ' >&2 || printf '  ' >&2
      printf '%-24s %s\n' "${names[$b]}" "${levels[$b]}" >&2
    done
    IFS= read -rsn1 key || { echo "not saved" >&2; return 0; }
    case "$key" in
      $'\033') IFS= read -rsn2 key; case "$key" in '[A') [ "$i" -gt 0 ] && i=$((i - 1)) ;; '[B') [ "$i" -lt $((n - 1)) ] && i=$((i + 1)) ;; esac ;;
      ' ') case "${levels[$i]}" in none) levels[$i]=read ;; read) levels[$i]=write ;; *) levels[$i]=none ;; esac ;;
      q) echo "not saved" >&2; return 0 ;;
      '') cells="$(for b in $(seq 0 $((n - 1))); do printf '%s\t%s\n' "${names[$b]}" "${levels[$b]}"; done |
                  jq -Rn '[inputs | split("\t") | {key: .[0], value: .[1]}] | from_entries')"
          save_row "$row" "$cells"; return 0 ;;
    esac
  done
}

case "${1:-}" in
  "") print_table | column -t -s "$(printf '\t')" ;;
  --set)
    [ "$#" -eq 4 ] || { echo "usage: brain-access.sh --set <profile|_none> <brain> <none|read|write>" >&2; exit 2; }
    check_row "$2"; check_brain "$3"
    case "$4" in none|read|write) ;; *) echo "brain-access: unknown level '$4'" >&2; exit 2 ;; esac
    save_row "$2" "$(jq -cn --arg b "$3" --arg l "$4" '{($b): $l}')" ;;
  -*) echo "usage: brain-access.sh [<profile|_none> | --set <profile|_none> <brain> <level>]" >&2; exit 2 ;;
  *) check_row "$1"; pick_row "$1" ;;
esac
```

`$'\033'` is bash syntax that 3.2 supports. `seq` exists on macOS.

- [ ] **Step 4:** `node --test lib/tests/brain-access.test.mjs` → PASS (5 tests).
- [ ] **Step 5:** leak guard, then `git commit -m "feat(brains): add a picker that is the only writer of the access matrix"`

---

### Task 7: Install fragment, layout and docs

**Files:**
- Modify: `install.sh` (after the `--agents` branch, line ~79), `lib/install/tests/install.test.mjs`
- Create: `brains/_template/README.md`, `brains/access.json.example`
- Modify: `.gitignore`, `README.md` (Layout block and Setup list), `lib/testing/README.md`

- [ ] **Step 1: Failing test** in `install.test.mjs`:

```js
test('--hooks prints a PreToolUse fragment that runs the private-access hook and changes no file', () => {
  const dirs = sandbox()
  const r = run(['--hooks'], dirs)
  assert.equal(r.status, 0, r.stderr)
  const frag = JSON.parse(r.stdout)
  const entry = frag.hooks.PreToolUse[0]
  assert.equal(entry.matcher, 'Read|Grep|Glob|Edit|Write|NotebookEdit|Bash')
  assert.match(entry.hooks[0].command, /lib\/hooks\/private-access\.sh/)
  assert.match(entry.hooks[0].command, /^TILLER_HOME=/)
  const probe = spawnSync('sh', ['-c', entry.hooks[0].command], { encoding: 'utf8', input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/srv/x' }, cwd: '/srv' }) })
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout, '')
})
```

- [ ] **Step 2:** run → FAIL (`--hooks` falls through to skill install).

- [ ] **Step 3: Implement** in `install.sh`, after the `--agents` block; add the usage line
  `#   ./install.sh --hooks   # print the settings.json fragment for the private-access hook` to the header:

```bash
if [ "${1:-}" = "--hooks" ]; then
  # Printed, never written: ~/.claude/settings.json is merged by hand, then the session restarted.
  jq -n --arg cmd "TILLER_HOME=$(printf '%q' "$ROOT_DIR") $(printf '%q' "$ROOT_DIR/lib/hooks/private-access.sh")" \
    '{hooks: {PreToolUse: [{matcher: "Read|Grep|Glob|Edit|Write|NotebookEdit|Bash", hooks: [{type: "command", command: $cmd}]}]}}'
  echo "Merge into ~/.claude/settings.json, then restart the session." >&2
  exit 0
fi
```

`.gitignore` append:

```
# Brains are local vaults, each with its own git history. Only the template and example are tracked.
/brains/*
!/brains/_template/
!/brains/access.json.example
```

`brains/access.json.example`: the fixture matrix. `brains/_template/README.md`:

```markdown
# A brain

A brain is a local knowledge vault under `brains/<name>/`, with its own git history. It is
git-ignored here and closed to every project until granted.

1. `git clone <vault> brains/<name>` or move an existing vault in, keeping its `.git`.
2. `lib/brain-access.sh <profile|_none>` to grant `read` or `write`.
3. `lib/resolve-brains.sh` from a project prints what that project may use.

The private-access hook (`install.sh --hooks`) denies the rest.
```

README Layout block gains:

```
brains/_template/          tracked: how to attach a brain
brains/<name>/             local, git-ignored: one vault, its own git repo
brains/access.json         local, git-ignored: which project may read or write which brain
lib/resolve-brains.sh      cwd -> granted brains, or a hard failure
lib/brain-access.sh        print or edit brains/access.json
lib/hooks/private-access.sh  deny tools that reach an ungranted brain or another project's profile
```

and Setup gains a step: `./install.sh --hooks` → merge the printed fragment into
`~/.claude/settings.json`, restart. `lib/testing/README.md` gains: `fixtures/private-access/` —
a second profile, two brains and a matrix; `private-access.mjs` builds a throwaway `TILLER_HOME`
from them.

- [ ] **Step 4:** full suite → new tests pass, failing set equals baseline; `lib/leak-guard.sh` (full) → exit 0.
- [ ] **Step 5:** `git commit -m "feat(install): print the private-access hook fragment and document brains"`

---

### Task 8: Demo, migration list, PR

- [ ] **Step 1: Manual demo** against fixtures (no real profile or brain):

```bash
export PATH="$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
H=$(node -e "import('./lib/testing/private-access.mjs').then(m => console.log(JSON.stringify(m.makeHome())))")
home=$(jq -r .home <<<"$H"); cwd=$(jq -r .cwd.beta <<<"$H")
jq -cn --arg f "$home/brains/main/note.md" --arg c "$cwd" '{tool_name:"Read",tool_input:{file_path:$f},cwd:$c}' \
  | env -u TILLER_PROFILE TILLER_HOME="$home" lib/hooks/private-access.sh
```

Expected: one JSON line, `permissionDecision: "deny"`, reason
`private-access: brain "main" is "none" for profile "beta" (brains/access.json)`.

- [ ] **Step 2: Migration step 1 only** — grep references to the current vault path in
  `~/.claude/skills`, `~/.claude/hooks`, `~/.claude/settings.json`, backup config, memory; hand the
  list and the commands for steps 2–4 to the owner. Nothing is moved.
- [ ] **Step 3:** `flow-create-pull-request` (draft). The repo has no remote today: if the skill
  resolves no profile or cannot push, the branch stays local and that is reported.
