# Security policy

## Reporting

Report vulnerabilities privately through GitHub security advisories ("Report a vulnerability" under
the repository's Security tab). Do not open a public issue. Expect an acknowledgement within a
week.

## What counts

The harness runs agents with write access to a repository, so the following are in scope:

- A prompt-injection bypass of `lib/text/untrusted.mjs`: text the harness did not write (tickets,
  comments, CI output) that closes its own fence or is otherwise treated as an instruction.
- A gate evaluator that fails open: a missing, malformed or ambiguous reading that lets a merge,
  push or approval through.
- A leak-guard bypass: a project, person or credential fact that reaches a tracked file or commit
  without `lib/leak-guard.sh` refusing it.
- A way for a lane to reach a brain, profile or channel its access matrix does not grant
  (`lib/hooks/private-access.sh`).
- A runtime adapter that runs a tool or spends past a cap the role does not allow.

Out of scope: findings that need an attacker who already controls the machine or the profile, and
issues in the third-party CLIs the adapters call.
