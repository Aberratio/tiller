# Personal skill templates

Skills scoped to one person rather than a project (a written voice, a daily standup note) are
generated per user from these templates. The output lands in `personal/<user>/`, which is git-ignored:
the harness stays generic, and nobody's voice, channel ids or colleagues reach tracked files.

## Setting up

```bash
./install.sh --setup-personal <user>          # answer the questions, generate, link
./install.sh --personal <user> all            # re-link what was generated
node lib/personal/generate.mjs --user <user> --template write-daily   # regenerate one
```

`personal/<user>/` then holds:

| Path | What |
|---|---|
| `skills/<skill>/` | the generated skill, linked into the tool's skill directory |
| `answers/<template>.json` | the answers; a re-run offers them as defaults |
| `answers/<template>.generated.json` | content hashes of what was generated |
| `leak-terms.txt` | the person's name, seeded so `lib/leak-guard.sh` refuses it in tracked files |

What a skill learns goes into `notes.md` next to its `SKILL.md`. That file belongs to the user: the
generator never compares it, never overwrites it (not even with `--force`), and only seeds it from a
template's `notes.md` when it does not exist yet. Any other edit to a generated skill makes it differ
from its recorded hashes, and the generator then refuses to overwrite it unless `--force` is given.
A skill directory with no generation record (made by hand) is protected the same way.

Non-interactive runs (`--non-interactive`, or stdin not a terminal) take answers from
`--answers <file.json>`, then stored answers, then question defaults, and fail on a missing required
answer. The answers file is either flat (`{"key": "value"}`, shared by all templates) or scoped
(`{"write-daily": {"key": "value"}}`). Tests point the generator elsewhere with `--root <dir>` or
`TILLER_PERSONAL_ROOT`.

## Adding a template

1. `personal/_templates/<template>/template.md` — the SKILL.md with placeholders. Its frontmatter
   `name:` decides the skill directory and may itself use placeholders (`write-like-{{name}}`).
2. `questions.json` — an array of `{key, prompt, help, required, default?, multiline?}`. A default may
   reference earlier answers (`"{{display_name}}"`). Answers given for one template are offered as
   defaults for the same key in the next, so shared keys (`name`, `display_name`, pronouns) are asked
   once per run.
3. Any other file in the directory is copied verbatim next to `SKILL.md` (scripts keep their mode).

Placeholder syntax:

- `{{key}}` — the answer.
- `{{#if key}}…{{else}}…{{/if}}` — kept when the answer is non-empty; `{{else}}` is optional and
  blocks may nest.

An unresolved `{{…}}` left in the output fails the generation.

A template carries the procedure and the quality rules; everything about the person (voice samples,
channels, ids, colleagues, company, language) is a question. No example in a template may name a real
person, project or workspace — `lib/leak-guard.sh` scans this directory.
