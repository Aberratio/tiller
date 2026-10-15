# Exit codes

Every harness script exits with one of these, and the `status` field of its one stdout line
(`schemas/script-result.json`) names the same row. `validate.mjs` fails if this table and
`kinds.json` `statuses` disagree.

| Code | Status | Meaning | Caller does |
|---|---|---|---|
| 0 | `ok` | the script did its job; a measurement that came out red is still `ok` | read the payload |
| 1 | `error` | the script itself failed (bug, missing binary, bad arguments); stdout may not be JSON | treat as `script-error`; never retry blindly |
| 2 | `pending` | not settled yet: a wait timed out, a cap on spawns was reached before done | call again, within the caller's own cap |
| 3 | `blocked` | could not answer: rate limit after backoff, quota, CI infra, conflict, harness denial, stop hour reached, a test toolchain the profile cannot run | act on `kind`; never report it as a failed check |
| 4 | `refused` | declined by policy: missing authority, invalid profile, lowered gate lane, the ticket already has a branch or PR (`duplicate`), another live process runs the ticket (`locked`), a USD cap reached (`budget-exhausted`) | stop; `kind` says whether a human signature or a profile fix is needed |
| 5 | `no-progress` | repeated attempts left state unchanged | stop; record why in run state |
| 6 | `paused-usage` | a usage limit; `retryAfter` carries the reset time when known | checkpoint and wait or exit; never a park, never a question |

`kind` is required for every status except `ok` and `pending`, and must be a kind in `kinds.json`
whose `exit` equals the code. Kinds with `exit: null` are raised by the runner, never by a script.

## Drivers

The two long-running drivers (`lib/driver/drive.mjs` for one ticket, `lib/driver/day.mjs` for a
day) use the table for the process, not for the run. Their exit code says whether the driver
itself ran to the end: `0` for every terminal run status (`merged`, `parked`, `paused-usage`,
`budget-exhausted` and the rest, named in `runStatus` / `dayStatus` of the stdout line), `1` for a
crash, `4` for a refusal (`locked`, `policy`), `128 + n` for a signal. The run's outcome is the
record: `tickets/<ticket>/driver-result.json` and `day-result.json`, which the day driver and the
launcher read instead of the code. A `parked` or `paused-usage` run is a driver that did its job,
so mapping those statuses to `3`, `4` or `6` would make a non-zero code mean two things, and no
caller depends on the code today: the day driver reads a child's result file and treats a missing
one as `died`. Anyone scripting over the drivers reads `runStatus` from the stdout line or the
result file.
