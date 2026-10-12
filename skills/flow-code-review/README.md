# flow-code-review

Two-axis review of a change, run as parallel sub-agents and reported side by side:

- **Standards** — does it follow this repo's documented conventions, plus a Fowler smell baseline that applies even when the repo documents nothing?
- **Spec** — does it do what the ticket *and every decision agreed since* asked for?
- **Works** (optional) — do the repo's own check commands pass, and does each failure actually belong to this change?

The two axes are never merged or reranked. That is the whole mechanism: code can follow every convention while implementing the wrong thing, or do exactly what the ticket asked while breaking the project's conventions. In practice one axis regularly catches a blocker the other is structurally blind to — a route rendering a dead message instead of redirecting, a label written with bare `File.write` where the rest of the codebase uses tmp+rename, a `console.log` shipped, a 3× duplicated path expression.

## Where it sits

| | flow-code-review | flow-confidence-check |
|---|---|---|
| When | before the commit, in the session that wrote the code | branch finished, fresh session |
| Owns | style, naming, architecture, diff-vs-intent | verdict, test-coverage rubric, security, PR comment |
| Output | findings to fix now | `high-confidence` / `needs-review` |

Both are useful on the same ticket, in that order.

## Install

```bash
./install.sh flow-code-review
```

Restart Claude Code (or start a new session). No configuration — it learns each repo from its own docs every run.

## Usage

```
/flow-code-review                       # uncommitted work vs the merge base — the default
/flow-code-review main
"review my changes before I commit"
"review a teammate's branch and tell me how to test it manually"   # adds Works + a manual-QA plan
```

## What it handles that a generic review does not

- **Uncommitted work is the default state.** With zero commits past the fixed point, `git diff main...HEAD` returns nothing and even two-dot skips untracked files — so a review can silently review *nothing*. The skill branches on repo state, intent-to-adds new files, and pins the correct diff command into every brief.
- **A teammate's remote branch** in a multi-repo workspace: locate the repo, fetch, review in place.
- **The spec is the ticket plus the agreements since.** Feeding the planning round's decisions in is what stops the Spec agent reporting pre-agreed decisions as scope creep.
- **Deliberate deviations are pre-declared to both axes**, so an agent grades your decision instead of spending its strongest finding rediscovering it.
- **Pre-existing debt is labelled, not billed** to a focused diff.
- **Generated artifacts get read.** A clean generator can still emit output that breaks the ticket's constraint.
- **Proportionality.** A one-line config change gets an inline checklist, not two sub-agents.

## Requirements

- Claude Code with sub-agent support
- `git` with an `origin` remote
- The tracker role's tools (for kind `jira`, the Atlassian MCP) or `gh` for automatic ticket resolution (optional — you can paste the spec)

## Provenance

Every rule is traceable to a session where its absence cost time. The provenance notes cite private session records, so they are kept outside this repository; read them before changing a rule.
