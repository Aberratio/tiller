# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project aims at [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Project-agnostic `flow-*` skills for the whole ticket path: start, plan, test-first build, code
  review, confidence verdict, commit, pull request, conflict resolution, bug diagnosis, decision
  ledger, ticket writing, board upkeep, manual QA, discovery, brainstorming and retro.
- Per-project profiles (`profiles/<name>/`, local and git-ignored) that carry every project fact; a
  skill that resolves no profile stops.
- Unattended runners: a Node ticket driver and day driver over deterministic scripts, with agents
  limited to judgment lanes, a closed JSON contract, gate arithmetic, journals and run state.
- Runtime adapters for `claude`, `codex` and OpenAI-compatible endpoints, with tiered model
  routing, calibration from measured verdicts, backoff and cooldowns.
- Resolver, owner-proxy and board roles that act only inside the mandate a profile grants.
- Untrusted-text fencing (`lib/text/untrusted.mjs`) and a diff security scan in every confidence pass.
- Leak guard (`lib/leak-guard.sh`) and a pre-commit hook that keep project, person and credential
  facts out of tracked files.
- Private brains with an access matrix and a private-access hook, and an optional private overview
  repository shared across machines.
- Project onboarding that detects facts from repos and reports profile drift.
- `npm test` as the single hermetic test entry point, with stub runtimes for machines without the
  agent CLIs.
- MIT license, contribution, security and conduct documents.
