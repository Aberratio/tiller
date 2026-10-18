# guided-setup — decision ledger

- 2026-10-18 · spec · bash dispatcher `bin/tiller`, Node wizard body `lib/setup/wizard.mjs` — the tools step must run before Node exists; a prompt loop and JSON are cheaper in Node · owner, design doc approved in session
- 2026-10-18 · spec · provider login probed with `claude auth status` (`loggedIn`) and `codex login status`, login run in the same terminal — the CLIs answer, so the person is not asked · self
- 2026-10-18 · spec · Codex CLI installed with `npm install -g @openai/codex` after the tools step — npm is already required · self
- 2026-10-18 · spec · provider default is every provider CLI on PATH, else Claude Code · self
- 2026-10-18 · spec · hook merge replaces an entry naming another checkout's private-access.sh — one machine runs one checkout; two hooks would both fire · self
- 2026-10-18 · spec · one answers file keyed by step, nested blocks passed through to sub-tools — no translation layer to maintain · self
- 2026-10-18 · spec · `.tiller-profile` written after a question defaulting to yes, not git-ignored — it lives in the person's repository · self
- 2026-10-18 · spec · project step passes only on `Launch-safe`, otherwise stops with `tiller project ask <name>` — a green summary over an unfinished profile is the anti-goal · self
- 2026-10-18 · spec · Node installed mid-run: PATH re-resolved once, then "open a new terminal" — idempotent re-run is cheaper than PATH heuristics · self
- 2026-10-18 · both · `install.sh` rc writer gains a marked `PATH` line — extends an existing command so `tiller install` and the wizard agree · self
- 2026-10-18 · spec · `profiles/_template/.gitignore` ignores `secrets.env`; backup refuses without it — a push must never carry a secret · self
- 2026-10-18 · spec · backup repositories named `tiller-personal-<owner>`, `tiller-profiles-<name>`; the wizard creates and pushes them through gh — owner chose the full first-to-second-machine loop · owner, AskUserQuestion in session
- 2026-10-18 · standards · tests use real bash and stub provider binaries, no network — same sandbox as `lib/install/tests` · self
- 2026-10-18 · standards · Windows path verified by the owner's run, not by tests — no Windows runner · self
- 2026-10-18 · standards · plan uses only conventions, gates, ledger path and merge authority from the `tiller` profile; its repo row and inviolable describe the 2026-10-16 trial clone, not this checkout — profile refresh is the owner's separate task · self
- 2026-10-18 · standards · `npm run lint:shell` is red on main before this work (67 findings in 20 files untouched here); the gate applied per commit is "no new finding": the changed shell files are shellcheck-clean and the total stays at 67 — fixing other files' findings is outside the plan · self
