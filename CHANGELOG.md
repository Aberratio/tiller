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
- Prerequisite preflight in `install.sh`: every call checks node, git, bash and jq first and
  refuses with the install plan when one is missing; `install.sh --prereqs` installs them through
  brew, apt, dnf, apk, pacman or winget (`lib/setup/prereqs.sh`); `install.ps1` bootstraps Git
  Bash on Windows, where skills link as junctions when native symlinks are not allowed.
- Every skill install writes `TILLER_HOME` where the agents read their environment: the `env`
  object of `~/.claude/settings.json` (with `TILLER_MACHINE` and, on Windows,
  `CLAUDE_CODE_GIT_BASH_PATH`), `~/.codex/config.toml` for the codex target and the shell rc file;
  values set by hand are kept.
- `bin/tiller` and its guided setup, `tiller setup`: tools, providers (install, link, sign-in),
  the private-access hook, personal skills, a launch-safe project profile, a private GitHub backup
  of what it created, an optional helm and a doctor verdict. Every step is skipped when already done
  and is also a command of its own (`tiller login`, `tiller hooks`, `tiller personal`,
  `tiller project`); `--answers <file.json>` runs it without a terminal. `install.ps1` ends in
  `tiller setup`, and the shell rc line puts `tiller/bin` on `PATH`.
- `npm test` as the single hermetic test entry point, with stub runtimes for machines without the
  agent CLIs.
- MIT license, contribution, security and conduct documents.
