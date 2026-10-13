# Brains and private access

## Goal

Attach local knowledge vaults ("brains") to the harness and decide, per project, which brains a
session may read or write. Enforce that decision, and the isolation of one project's profile from
another, mechanically: a session in project A cannot read a brain A was not granted, nor
`profiles/B/`, even when it knows the path.

## Decisions

| Question | Decision |
|---|---|
| Enforcement | A PreToolUse hook blocks, a resolver selects. Instructions in a skill are not the boundary. |
| Scope | Brains plus other projects' profiles. `personal/<user>/` stays shared. |
| Access store | One matrix, `brains/access.json`, edited with a picker. |
| No profile resolves | A `_none` row in the matrix decides. |
| Attachment | The vault lives inside `brains/<name>/`, with its own git history. |
| Levels | `none`, `read`, `write`. |

## Layout

```
brains/_template/            tracked: README for a new brain
brains/access.json.example   tracked: matrix example with fixture names
brains/<name>/               local, git-ignored: one vault, its own git repo
brains/access.json           local, git-ignored: the matrix
lib/resolve-brains.sh        cwd -> granted brains, or a hard failure
lib/brain-access.sh          the picker
lib/hooks/private-access.sh  the enforcement hook
```

`.gitignore` gains `/brains/*`, `!/brains/_template/`, `!/brains/access.json.example`.

## Matrix

```json
{
  "acme":  { "main": "read", "acme-notes": "write" },
  "_none": { "main": "write" }
}
```

- Row key: a profile name or `_none`. Column key: a brain name, i.e. a directory under `brains/`.
- A missing row or a missing cell is `none`. A new brain is closed to every project until granted.
- Any other value, a row naming a profile that does not exist, or a cell naming a brain that does
  not exist is a hard failure of the resolver and a deny in the hook.

## Resolver

`lib/resolve-brains.sh [<cwd>]`

1. Resolve the profile in the same order as `lib/resolve-profile.sh` (`TILLER_PROFILE` →
   `.tiller-profile` → `repo_globs`). The shared logic is extracted rather than duplicated. When no
   profile resolves, the row is `_none`; this is not a failure, unlike `resolve-profile.sh`.
2. Validate the matrix as above.
3. Print one line per granted brain: `<name>\t<level>\t<absolute path>`, levels `read` and `write`
   only. No grant prints nothing and exits 0.

Exit codes: 0 ok, 2 matrix invalid, 3 `TILLER_HOME` unset or unreadable.

A brain skill reads paths only from the resolver and never carries a hardcoded vault path. It
writes only to a brain listed with `write`.

## Enforcement hook

`lib/hooks/private-access.sh`, registered as a PreToolUse hook for
`Read|Grep|Glob|Edit|Write|NotebookEdit|Bash`.

Input: the hook JSON (`tool_name`, `tool_input`, `cwd`). The profile is resolved from `cwd`.

Protected roots: `$TILLER_HOME/brains/<name>/` and `$TILLER_HOME/profiles/<name>/`.

Path tools (`file_path`, `path`, `notebook_path`; Glob's `path` plus the pattern's literal prefix):

1. Normalise with `realpath` (missing leaf: normalise the parent). A symlink into a protected root
   is judged by its target.
2. Inside `brains/X/`: deny when the level of X is `none`; deny `Edit|Write|NotebookEdit` when it is
   `read`.
3. Inside `profiles/Y/`: deny when Y is not the resolved profile. `profiles/_template/` is always
   allowed. With no resolved profile every `profiles/Y/` except `_template` is denied, but
   `profiles/Y/doubts/` may be read (a Bash command qualifies only without a write operator).
4. Inside `brains/` or `profiles/` but not inside a named subdirectory (the directory itself,
   `brains/access.json`): allow reads; `brains/access.json` is written only through the picker,
   so `Edit|Write` on it is denied.

Bash: the command string is scanned for every protected root of a denied brain or profile, both as
`$TILLER_HOME`-relative and absolute forms and with `~` expanded. Any hit is a deny. Writes into a
`read` brain through Bash (redirection, `tee`, `mv`, `cp` targets) are denied by the same scan when
the command names that brain's path together with a write operator.

Fail-closed: malformed input, an invalid matrix, or an internal error denies any call that touches a
protected root and allows the rest. A deny message names the rule and the matrix cell, e.g.
`private-access: brain "main" is "none" for profile "acme" (brains/access.json)`.

### Known gap

The Bash scan reads the command text, not the files a program opens. A script that builds the path
at run time, or a tool that walks `$TILLER_HOME` recursively, is not stopped. Closing that needs
OS-level sandbox rules per project and is out of scope here.

## Picker

`lib/brain-access.sh`

- No argument: print the full matrix as a table, profiles × brains, with `_none` last.
- `<profile|_none>`: an interactive list of brains, arrow keys to move, space to cycle
  `none → read → write`, enter to save, `q` to quit without saving.
- `--set <profile|_none> <brain> <none|read|write>`: set one cell, non-interactive.
- After a save: write atomically (temp file + rename), then print what that row now grants by
  calling the resolver.
- Refuses an unknown profile or brain.

## Installation

`install.sh --hooks` prints the settings fragment that registers the hook in
`~/.claude/settings.json`; it does not edit that file. Restart the session afterwards.
`lib/brain-access.sh` with no matrix present creates an empty one (everything `none`).

## Migration of an existing vault

1. Grep every reference to the vault's current path (skills, hooks, backup configuration, memory).
2. Move the vault into `brains/<name>/`, keeping its `.git`.
3. Update every reference from step 1 to read the path from the resolver.
4. Grant it in the matrix, at minimum on the `_none` row so the current usage keeps working.

## Testing

Fixtures in `lib/testing/`: two profiles, two brains, one matrix. Hook cases, each run with a
synthetic hook JSON:

- `none` brain: Read, Grep, Glob, Bash all denied.
- `read` brain: Read allowed, Edit and Write denied, Bash redirect into it denied.
- `write` brain: all allowed.
- Other project's profile: denied; own profile and `_template`: allowed.
- Symlink outside `$TILLER_HOME` pointing into a denied brain: denied.
- `_none` row: grants applied when `cwd` resolves no profile.
- Malformed JSON and invalid matrix: protected path denied, unrelated path allowed.
- `brains/access.json` write through Edit: denied.

Resolver and picker cases: missing cell is `none`, unknown value fails, unknown brain fails,
`--set` round-trips through the resolver.

## Out of scope

- OS-level sandbox rules per project.
- Access control for `personal/<user>/`.
- Sharing brains between people or machines.
