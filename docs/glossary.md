# Glossary

Terms as this repository uses them. Where a term has a common meaning elsewhere, the definition
here is the one the code and the skills follow.

| Term | Meaning |
|---|---|
| **profile** | `profiles/<name>/profile.md`: the facts of one project (repos, tracker, merge authority, toolchain, escalation, inviolables). Git-ignored. Carries facts, never procedure. |
| **facts** | The profile rendered to a JSON object by `lib/profile-facts.sh`. The runner reads facts, never the profile file. |
| **skill** | One `skills/flow-*/SKILL.md`: a procedure Claude Code follows when invoked by `/flow-*` or by a matching phrase. Every skill starts by resolving a profile (Step −1). |
| **Step −1** | The first step of every skill: run `lib/resolve-profile.sh`; no profile means stop. |
| **runner / driver** | `lib/driver/drive.mjs` (one ticket) and `lib/driver/day.mjs` (a queue). Unattended, checkpointed, capped. |
| **phase** | One of fourteen stages of a ticket run (`start` … `logs`). Each writes a checkpoint. |
| **lane** | One model call inside a phase: a prompt, a JSON schema, a model tier, a USD cap, a turn cap and a wall-clock cap. |
| **tier** | A model class (`T1`–`T3`) from `config/routing.json`; a lane is routed to a tier, the tier to a concrete model in `config/models.json`. |
| **gate lane** | A lane whose output decides whether a run proceeds (review axes, confidence, gate). A profile may not lower its tier and the launcher refuses an unverified runtime for it. |
| **adapter** | The code that runs a lane on one runtime: `claude`, `codex`, `openai-compat`. Each declares what it can honour (deny lists, schemas, budgets). |
| **runtime** | The CLI or endpoint an adapter drives. `runtime-down` means its binary or endpoint is not reachable from the lanes' `PATH`. |
| **checkpoint** | The record written after a phase finishes, keyed by run id, phase and input hash. A relaunch skips phases with a matching checkpoint. |
| **step** | One side effect inside a phase (push, worktree, tracker transition), recorded in the step log so a resume does not repeat it blindly. |
| **resume** | Relaunching a run with the same args. Finished phases are skipped; the unfinished one restarts; a cap on resumes turns a crash loop into a park. |
| **park** | The run stops with one open decision for a human, recorded in `decisions.jsonl` and `driver-result.json`. Not a failure, not a question in chat. |
| **decision** | A question the run could not answer; carries kind, why, options and origin. Goes through the escalation chain. |
| **escalation chain** | source cascade → resolver → owner proxy → human. `docs/escalation.md`. |
| **resolver** | The role that researches a question in a fixed order and decides with the reversal cost, or parks. Never acts. |
| **owner proxy** | The role that takes a step needing the owner's mandate, only from the mandate list the profile grants. Never signs. |
| **signature** | A human's explicit approval of a merge or a path the profile marks. Never delegated to any role. |
| **inviolable** | A profile rule no run may cross (a path, a branch, a channel). A decision touching one parks. |
| **hard-stop channel** | An outward channel (chat, email, tracker comment) the run may never write to unattended. Rendered from the profile; the runner denies the matching tools. |
| **cap** | A limit in USD (per call, per run, per day), turns or seconds. Reaching one parks or pauses; it never silently truncates. |
| **usage pause** | The runtime reported a usage limit. The run checkpoints and waits for the reset; status `paused-usage`. |
| **stop hour** | The hour after which a day run starts no new chunk and exits with kind `stop-hour`. |
| **battery wait** | A day run's pause on a low battery off mains. Past its limit (default 4 hours) the day exits with kind `battery-wait`. |
| **chunk / wave** | A group of tickets the day runner drives concurrently; the queue file lists waves in order. |
| **state root** | The directory holding run state, journals, locks and results for one profile and date (`STATE_ROOT`). |
| **journal** | Append-only JSONL of spawns, results and spend per lane; the source for retros and day caps. |
| **decision ledger** | A file on the branch recording deliberate deviations and post-ticket agreements as they are taken. |
| **untrusted text** | Anything a third party could have written: ticket bodies, PR comments, CI output, bot reviews. Fenced with a random marker and a read rule before a model sees it. |
| **fence** | The marker pair around untrusted text. A marker found inside the content is flagged as suspicious. |
| **leak guard** | `lib/leak-guard.sh` and the pre-commit hook: refuses tracked files that contain project, company or personal terms from the local term lists. |
| **brain** | A private per-project knowledge folder under `brains/`, readable only through the private-access hook. |
| **personal skills** | Skills generated for one user from `personal/<user>/` answers; git-ignored. |
| **retro** | `skills/flow-retro`: reads a day's records and writes proposals; applies nothing. |
| **dry run** | A run against a fake runtime that produces schema-valid outputs without calling a model. The test suite uses it. |
| **doctor** | `bin/doctor`: checks prerequisites and prints one verdict per requirement. |
