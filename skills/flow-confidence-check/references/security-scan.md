# Scripted security scan

Run before any dimension agent is dispatched, on the same pinned merge base and head the agents review.
It measures what a script can measure, so the security dimension spends its budget on judgment.

```
node "$TILLER_HOME/lib/security/scan-diff.mjs" --repo <repo-root> --base <merge-base-sha> --head <head-sha> --profile <profile.md>
```

`--profile` is optional; without it no audit command runs.

## What it checks

| Category            | Finding id   | Severity | What it means                                                                                                 |
| ------------------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `credential`        | `SEC-CRED-n` | blocker  | An added line matches a credential shape from `lib/leak-guard.sh`. The location is given; the value never is. |
| `dependency-change` | `SEC-DEP-n`  | medium   | A dependency manifest or lockfile changed. One finding per file.                                              |
| `audit`             | `SEC-AUDIT`  | high     | The profile's `## security` `- Audit command:` exited non-zero, or could not run (`source: toolchain`).       |
| `scan-error`        | `SEC-SCAN-ERROR` | high | The scan itself failed (bad ref, unreadable profile). Exit 1, `status: error`.                               |

## How the findings are used

1. Exit 1, `status` other than `ok`, or no `findings` array: the scan did not answer. Record `SEC-SCAN-ERROR` as a
   harness finding. It blocks the verdict and is never sent to a fix agent. Never treat a failed scan as a clean one.
2. Merge the findings into the same list the dimension agents return, with `dimension: security-scan`.
3. Measured findings skip the verifier step: a verifier cannot refute a pattern match on a line that exists.
   A finding with `source: toolchain` is a tooling problem: report it, do not ask a fix agent to change code for it.
4. Tell every dimension agent, in its prompt, which findings the scan already raised and which dependency files
   changed, so they are not raised twice. The security agent still judges what a changed dependency brings in.
5. On a fix round, re-run the scan on the new head before re-grading. A finding that disappears is fixed.

If stdout carries `artifact`, the stdout list was clipped to fit the 4 KiB result; read the full list from that file.
