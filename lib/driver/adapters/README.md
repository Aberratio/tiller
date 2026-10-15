# Runtime adapters

`lane()` runs every lane through one adapter, chosen by its `runtime` field (default `claude`). Each
adapter takes the same request and returns the same result:
`{ structured, usage: { in, out, cacheRead, cacheCreate, costUsd, costSource }, model, durationMs, denials, exitClass, raw }`.
`exitClass` is one of `ok`, `budget`, `turns`, `timeout`, `schema`, `tool_denied`, `auth`, `rate_limit` or
`runtime_error`.

Roles in `config/agents.json` use logical tool names: `read`, `search`, `shell`, `web`,
`role:<role>.<op>` and `mcp:<server>.<tool>`. A `role:` name resolves first, through
`config/tool-kinds.json` and the profile's `## tools`, to `mcp:<server>.<tool>`; `config/mcp-servers.json`
then gives the runtime's name for the server. Each op also declares its access (`read`, or `write` with
the outward channel it reaches), which is where an unattended child's denied tools come from. Each adapter translates them, or refuses a role it cannot
honour before it spawns anything.

| Runtime | Schema | Budget | Denials | Verified against |
|---|---|---|---|---|
| `claude` | native `--json-schema` | native `--max-budget-usd` | `permission_denials` | fake `claude` (unchanged argv) |
| `openai-compat` | the conversation, then a repair turn with `response_format` json_schema, else plain repair (`fallback.mjs`) | `config/prices.json`; self-hosted is priced at 0 and capped by tokens, turns and wall clock | its own tool refusals | local fake HTTP server |
| `codex` | `--output-schema` file, `-o` file validated again | `config/prices.json`, process group killed on breach | none | fake `codex` binary only |

`config/prices.json` is the only price table; routing and these caps both read it. A model with no entry in it cannot run on `openai-compat` or `codex`. A lane's caps can
only tighten `limits`.

`capabilities.denyTools` says whether the runtime enforces a tool deny list (`--disallowedTools` on
`claude`). Only `claude` sets it; `codex` and `openai-compat` have no per-tool deny mechanism.
`lib/routing/validate-launch.mjs` refuses an active model, or one pinned to a gate lane, on a runtime
without it.

Each adapter's `available(env, { onPath })` says whether its runtime is reachable at launch (a binary
on the lanes' PATH, or a configured endpoint); an adapter without one is never routed to.

## openai-compat

- Configured through `OPENAI_COMPAT_BASE_URL` (e.g. `http://localhost:8000/v1`) and an optional
  `OPENAI_COMPAT_API_KEY`.
- `OPENAI_COMPAT_RESPONSE_FORMAT=off` turns off `response_format` for a server that silently ignores it.
- Tools are read-only: `read_file`, `list_files`, `search` and `shell`.
  - Every tool is confined to cwd.
  - `shell` takes an argv and runs without a shell interpreter.
  - Allowed commands come from `OPENAI_COMPAT_SHELL_ALLOW`, or a read-only default list.
- There is no dispatch tool and no MCP client, so lanes that write and roles that need MCP or web cannot
  run here yet.

## codex: UNVERIFIED

Nothing below has been run against a real `codex` binary.

- `--output-schema` takes a file path, and the prompt is read from stdin when the prompt argument is `-`.
- The `-c approval_policy="never"` and `-c mcp_servers={}` overrides are accepted in that form.
- Event shapes:
  - `turn.completed.usage` has `input_tokens`, `cached_input_tokens`, `output_tokens` and
    `reasoning_output_tokens`. Reasoning tokens are added to output, so the cap never undercounts.
  - `turn.failed.error.message`, `error.message` and the `item.type` names come from the docs.
- Exit codes: anything other than 0 is treated as a failure.
- Subagents cannot be turned off. A run is stopped as `tool_denied` when it emits an item type outside the
  documented set.
- Codex records no denials, so harness-blocked triage falls back to the text rules.
- Usage arrives only per turn, so a breach is caught at a turn boundary. Wall clock is the only mid-turn
  stop.
- `config/prices.json` has no `codex/*` entry, so every codex lane is refused until one is added.
- A lane runs in the `read-only` sandbox; `workspace-write` is refused until a codex write lane has been measured.
