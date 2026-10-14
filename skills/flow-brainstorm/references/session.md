# The session file

One JSON object per brainstorm, written to `$TMPDIR/brainstorm-<slug>.json` and edited until
`brainstorm.mjs check` exits 0. Every render and the brain record are produced from it; nothing is
formatted by hand.

```json
{
  "goal": "Tell the owner about a parked decision before the day ends",
  "area": "tech",
  "question": "How should a parked decision reach the owner during the day?",
  "evidence": [
    { "claim": "the day driver writes its summary in a lane after the regression sweep",
      "measured": { "command": "grep -n \"summary\" lib/driver/day.mjs", "output": "260:    sweep = await lane('sweep-summary'," } },
    { "claim": "the owner checks the tracker during a run", "assumption": true,
      "settle": "ask the owner which surface they read while a run is going", "flips": true }
  ],
  "options": [
    { "id": "A", "name": "Comment on the ticket", "summary": "post the parked question as a tracker comment",
      "against": "a comment is an outward channel, closed by every default hard-stop list",
      "reversalCost": "1 file, about 30 minutes", "touches": ["## escalation"] },
    { "id": "B", "name": "Append to the doubt log at park time", "summary": "write the park when it happens",
      "against": "the owner still has to open a file to see it",
      "reversalCost": "1 function in 1 file, 15 minutes", "touches": ["## escalation"] },
    { "id": "C", "name": "Lower the stop hour", "summary": "the end-of-day summary simply arrives sooner",
      "against": "trades throughput for latency on every day, parked or not",
      "reversalCost": "1 profile line, 2 minutes", "touches": ["## run policy"], "minimal": true }
  ],
  "recommendation": "B",
  "beat": "A",
  "why": "keeps every write inside the harness; A needs a channel the hard-stop list closes by default"
}
```

| Field | Rule `check` enforces |
|---|---|
| `goal` | present; an outcome, not a solution (that part is judgement, not checked) |
| `area` | optional; `scope`, `tech`, `budget`, `deadline` or `other` — the brain register's vocabulary |
| `question` | optional; the one question put to the human, default `Which option for: <goal>?` |
| `evidence[]` | each item is `measured` (`command` and `output`, both non-empty) or `assumption: true` with `settle`; `flips: true` marks an assumption whose falsity would change the recommendation |
| `options[]` | at least 3; unique `id` and `name`; `summary`, `against`, `reversalCost`, `touches` all present |
| `against` | no two options share it — two options with the same strongest objection are one option |
| `reversalCost` | contains a number: minutes, hours, files, steps |
| `touches` | each entry `## <profile section>`, `inviolable: <title exactly as in the profile>`, or `none` alone; with `--facts`, the inviolable must be declared |
| `minimal` | at least one option carries it: the smallest thing that meets the goal, doing nothing included |
| `recommendation`, `beat` | two different existing ids; `why` present |

`--facts` takes the JSON from `lib/profile-facts.sh`, or a hand-written `{"inviolables": [...]}`.
`--profile` takes the profile file; each `## section` in `touches` must then be one of its headings.
Without it, section names are not checked. A measured output longer than 160 characters renders
clipped, with `… (clipped; N chars)`, never silently. A recommendation that touches an inviolable passes, and `check` prints a `park:` line: that choice
is the human's.

## Renders

| `--as` | For |
|---|---|
| `table` (default) | the option table, recommendation first, then the measured and assumed claims |
| `question` | the plain-text numbered question, for a runtime with no question tool |
| `awaiting` | one `awaiting[]` item in the harness lane shape (`kind`, `question`, `options`, `recommendation`, `reversalCost`) |
| `ledger` | one decision-ledger line; `--tag spec\|standards\|both`, `--agreed-with "<role>, <where>"`, else `self` |
| `doubt` | a dated block for the doubt log: decision, beat, reversal, settle, table |

`record --brain <dir>` writes `brainstorms/<date>-<slug>.md`, the next `D-nnn` in `decisions.md`
(`proposed`, or `agreed` with `--confirmed-by self` in a pet brain), and one `Q-nnn` per assumption
in `questions.md`. A directory with no `decisions.md` is not a register and is refused (exit 3), as
is `--confirmed-by` in a brain with a `client.md`.
